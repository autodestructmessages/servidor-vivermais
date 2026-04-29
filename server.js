const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const crypto = require('crypto'); // 🛡️ Módulo de segurança nativo do Node

// 1️⃣ Salas em memória RAM
const salasAtivas = {
  'SALA_GERAL': {
    senha: null,
    criador: 'SISTEMA',
    tokens: []
  }
}; 

// 📓 Caderninho de Recibos (Evita mensagens duplicadas na entrega ao vivo e do histórico)
const controleDeEntregas = {}; 

// ⏱️ Controles de tempo furtivo
let ultimoPushEntrada = 0;
let ultimoPushMensagem = 0;
let ultimoPushRanking = 0;

// Tempos de bloqueio para não gerar suspeita
const TEMPO_SILENCIO_ENTRADA = 5 * 60 * 1000; // 5 minutos sem avisar que alguém entrou
const TEMPO_SILENCIO_CHAT = 10 * 60 * 1000;   // 10 minutos de silêncio após a 1ª mensagem (Modo Conversa)

// 🛡️ CRIPTOGRAFIA MILITAR
const senhaSecreta = process.env.CHAVE_MESTRA || 'ChaveTemporaria2026';
const ENCRYPTION_KEY = crypto.scryptSync(senhaSecreta, 'salt', 32); 
const IV_LENGTH = 16;

function encrypt(text) {
  if (!text) return text;
  try {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
  } catch (e) { return text; }
}

function decrypt(text) {
  if (!text || !text.includes(':')) return text;
  try {
    const textParts = text.split(':');
    const iv = Buffer.from(textParts.shift(), 'hex');
    const encryptedText = Buffer.from(textParts.join(':'), 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) { return text; } 
}

// 2️⃣ 🔐 INÍCIO DA BLINDAGEM DO FIREBASE
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');

let db = null;

try {
  const serviceAccount = require('./firebase-key.json');
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  db = getFirestore('vivermais'); 
} catch (error) {
  console.log('⚠️ AVISO: Arquivo firebase-key.json não encontrado ou inválido.');
}

async function carregarTokensDoBanco() {
  if (!db) return; 
  try {
    const doc = await db.collection('Salas').doc('SALA_GERAL').get();
    if (doc.exists) {
      salasAtivas['SALA_GERAL'].tokens = doc.data().tokens || [];
    } else {
      await db.collection('Salas').doc('SALA_GERAL').set({ tokens: [] });
    }
  } catch (error) {}
}

if (db) carregarTokensDoBanco(); 

async function salvarTokenNoBanco(token) {
  if (!db) return; 
  try {
    const salaRef = db.collection('Salas').doc('SALA_GERAL');
    await salaRef.update({
      tokens: admin.firestore.FieldValue.arrayUnion(token)
    });
  } catch (error) {}
}

// 🧹 LIXEIRO AUTOMÁTICO (Evapora as mensagens após 20 minutos)
async function lixeiroAutomatico() {
  if (!db) return;
  const vinteMinutosAtras = Date.now() - (20 * 60 * 1000); // 20 minutos exatos
  try {
    const snapshot = await db.collection('MensagensTemporarias')
      .where('timestamp', '<', vinteMinutosAtras)
      .get();

    if (snapshot.empty) return;
    const batch = db.batch();
    snapshot.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
  } catch (e) {}
}

setInterval(lixeiroAutomatico, 10 * 60 * 1000);

const app = express();
app.use(cors());

// Robo do Uptime para o Render não dormir
app.get('/keepalive', (req, res) => {
  res.send('Servidor ViverMais 100% Acordado!');
});

const server = http.createServer(app);

const io = new Server(server, { 
  cors: { origin: "*" },
  maxHttpBufferSize: 1e7,
  pingInterval: 25000, 
  pingTimeout: 60000   
});

function atualizarContagemSala(codigoSala) {
  const room = io.sockets.adapter.rooms.get(codigoSala);
  const qtdOnline = room ? room.size : 0;
  io.to(codigoSala).emit('atualizar_contagem_online', qtdOnline);
  return qtdOnline; 
}

// 🎯 FUNÇÃO PUSH
async function enviarNotificacao(tokensDestino, titulo, corpo) {
  const validTokens = [...new Set(tokensDestino.filter(t => t && typeof t === 'string' && t.startsWith('ExponentPushToken')))];
  
  if (validTokens.length === 0) return;

  const mensagensPush = validTokens.map(token => ({
    to: token, 
    sound: 'default', 
    title: titulo, 
    body: corpo, 
    priority: 'high'
  }));

  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 
        'Accept': 'application/json', 
        'Accept-encoding': 'gzip, deflate', 
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify(mensagensPush),
    });
  } catch (error) { console.log('Erro no Push'); }
}

io.on('connection', (socket) => {
  socket.on('ping_fantasma', () => socket.emit('pong_fantasma'));

  socket.on('criar_sala', ({ codigo, senha, tokenPush }) => {
    if (!salasAtivas[codigo]) salasAtivas[codigo] = { senha, criador: socket.id, tokens: [] };
    if (tokenPush && !salasAtivas[codigo].tokens.includes(tokenPush)) salasAtivas[codigo].tokens.push(tokenPush);
    socket.data.salaAtual = codigo;
    socket.join(codigo);
    atualizarContagemSala(codigo);
  });

  socket.on('entrar_sala_privada', ({ codigo, senha, tokenPush }, callback) => {
    const sala = salasAtivas[codigo];
    if (sala && sala.senha === senha) {
      socket.data.salaAtual = codigo;
      socket.join(codigo);
      if (tokenPush && !sala.tokens.includes(tokenPush)) sala.tokens.push(tokenPush);
      callback({ status: 'ok' });
      atualizarContagemSala(codigo);
    } else {
      callback({ status: 'erro', msg: 'Código/Senha incorretos!' });
    }
  });

  // 🚪 ENTRADA NA SALA GERAL
  socket.on('entrar_sala_geral', async ({ tokenPush }) => {
    const codigo = 'SALA_GERAL';
    socket.data.salaAtual = codigo;
    socket.data.tokenPush = tokenPush; 
    socket.join(codigo);
    
    if (tokenPush && !controleDeEntregas[tokenPush]) controleDeEntregas[tokenPush] = new Set();
    
    const sala = salasAtivas[codigo];
    
    if (tokenPush && !sala.tokens.includes(tokenPush)) {
      sala.tokens.push(tokenPush);
      salvarTokenNoBanco(tokenPush);
    }

    const qtdOnline = atualizarContagemSala(codigo);

    // 🚀 RECUPERA O HISTÓRICO DAS ÚLTIMAS MENSAGENS E ENTREGA SOMENTE 1 VEZ
    if (db) {
      try {
        const snapshot = await db.collection('MensagensTemporarias').where('sala', '==', codigo).get();
        const mensagensRecuperadas = [];
        
        snapshot.forEach(doc => {
          let msg = doc.data();
          if (msg.texto) msg.texto = decrypt(msg.texto);
          if (msg.audio) msg.audio = decrypt(msg.audio);
          if (msg.imagem) msg.imagem = decrypt(msg.imagem);
          mensagensRecuperadas.push(msg);
        });

        mensagensRecuperadas.sort((a, b) => a.timestamp - b.timestamp);
        
        mensagensRecuperadas.forEach(msg => {
          const jaRecebeu = tokenPush && controleDeEntregas[tokenPush].has(msg.id);
          // Não entrega se foi a própria pessoa que mandou e não entrega repetido
          if (msg.tokenRemetente !== tokenPush && !jaRecebeu) {
            socket.emit('receber_fantasma', msg);
            if (tokenPush) controleDeEntregas[tokenPush].add(msg.id); 
          }
        });
      } catch (error) { }
    }

    if (qtdOnline === 1) {
      socket.emit('receber_fantasma', {
        id: 'SISTEMA_' + Math.random().toString(36).substring(2, 8),
        texto: '🛡️ MODO SEGURO: Protocolos ativos. Aguardando conexão...',
        hora: new Date().toLocaleTimeString()
      });
    }

    // 🔔 NOTIFICAÇÃO GENÉRICA DE ENTRADA (Com trava de 5 minutos)
    if (sala.tokens.length > 0) {
      const agora = Date.now();
      if (agora - ultimoPushEntrada > TEMPO_SILENCIO_ENTRADA) { 
        const tokensParaAvisar = sala.tokens.filter(t => t !== tokenPush);
        if (tokensParaAvisar.length > 0) {
          enviarNotificacao(tokensParaAvisar, '🏆 Novidade no Ranking!', 'O ranking global foi movimentado. Confira sua posição no ViverMais!');
          ultimoPushEntrada = agora; 
        }
      }
    }
  });

  socket.on('alerta_global_enviar', (msg) => {
    io.emit('alerta_geral_recebido', msg);
    const todosTokens = new Set();
    Object.values(salasAtivas).forEach(sala => sala.tokens.forEach(t => todosTokens.add(t)));
    enviarNotificacao(Array.from(todosTokens), '🚨 ATENÇÃO GLOBAL', 'Alguém acionou o RANKING global. Acesse o app agora!');
  });

  // 💬 ENVIO DE MENSAGENS 
  socket.on('enviar_fantasma', async (dados) => {
    const mensagemFinal = {
      ...dados,
      id: Math.random().toString(36).substring(2, 10), 
      hora: new Date().toLocaleTimeString(),
      timestamp: Date.now() 
    };

    if (db) {
      try { 
        const mensagemBlindada = { ...mensagemFinal };
        if (mensagemBlindada.texto) mensagemBlindada.texto = encrypt(mensagemBlindada.texto);
        if (mensagemBlindada.audio) mensagemBlindada.audio = encrypt(mensagemBlindada.audio);
        if (mensagemBlindada.imagem) mensagemBlindada.imagem = encrypt(mensagemBlindada.imagem);
        await db.collection('MensagensTemporarias').add(mensagemBlindada); 
      } catch (error) { }
    }

    // Entrega ao vivo para quem estiver na sala
    const socketsNaSala = await io.in(dados.sala).fetchSockets();
    socketsNaSala.forEach(soc => {
      if (soc.id !== socket.id) { 
        soc.emit('receber_fantasma', mensagemFinal);
        const tokenDestino = soc.data.tokenPush;
        if (tokenDestino) {
          if (!controleDeEntregas[tokenDestino]) controleDeEntregas[tokenDestino] = new Set();
          controleDeEntregas[tokenDestino].add(mensagemFinal.id);
        }
      }
    });

    // 🔔 NOTIFICAÇÃO DISFARÇADA DE NOVA MENSAGEM (Com trava pesada de 10 minutos)
    const salaAtual = salasAtivas[dados.sala];
    if (salaAtual && salaAtual.tokens.length > 0) {
      const agora = Date.now();
      // O silêncio de 10 minutos garante que enquanto estiverem conversando, o celular não vai apitar.
      if (agora - ultimoPushMensagem > TEMPO_SILENCIO_CHAT) { 
        const tokensParaAvisar = salaAtual.tokens.filter(t => t !== dados.tokenRemetente);
        if (tokensParaAvisar.length > 0) {
          enviarNotificacao(tokensParaAvisar, '⚡ Energia Recarregada!', 'Sua vida no ViverMais foi recarregada. Aproveite para treinar sua mente!');
          ultimoPushMensagem = agora;
        }
      }
    }
  });

  // =====================================
  // 🏆 SISTEMA DE RANKING GLOBAL
  // =====================================
  socket.on('novo_recorde_anonimo', async ({ jogo, pontos }) => {
    if (!db || !jogo || pontos === undefined || pontos === null) return;
    try {
      await db.collection(`Ranking_${jogo}`).add({
        pontos: pontos,
        timestamp: Date.now()
      });

      const snapshot = await db.collection(`Ranking_${jogo}`).orderBy('pontos', 'desc').limit(3).get();
      const top3 = [];
      snapshot.forEach(doc => top3.push(doc.data()));

      io.emit('atualizar_ranking', { [jogo]: top3 });

      // Notificação de Recorde (Também disfarçada / App-related)
      const salaGeral = salasAtivas['SALA_GERAL'];
      if (salaGeral && salaGeral.tokens.length > 0) {
        const agora = Date.now();
        if (agora - ultimoPushRanking > 30000) {
          const nomeJogo = jogo.charAt(0).toUpperCase() + jogo.slice(1);
          enviarNotificacao(salaGeral.tokens, '👑 Novo Recorde Global!', `Alguém acabou de registrar ${pontos} pontos em ${nomeJogo}! Venha tentar bater.`);
          ultimoPushRanking = agora;
        }
      }
    } catch (error) { }
  });

  socket.on('pedir_ranking', async () => {
    if (!db) return;
    try {
      const rankings = { bolhas: [], tetris: [], dino: [], reflexo: [], frenesi: [] };
      const jogos = ['bolhas', 'tetris', 'dino', 'reflexo', 'frenesi'];
      
      for (const j of jogos) {
        const snap = await db.collection(`Ranking_${j}`).orderBy('pontos', 'desc').limit(3).get();
        snap.forEach(doc => rankings[j].push(doc.data()));
      }
      socket.emit('atualizar_ranking', rankings);
    } catch (error) {}
  });

  socket.on('sair_sala', () => {
    const salaAtual = socket.data.salaAtual;
    if (salaAtual) {
      socket.leave(salaAtual);
      socket.data.salaAtual = null;
      atualizarContagemSala(salaAtual);
    }
  });

  socket.on('disconnect', () => {
    const salaAtual = socket.data.salaAtual;
    if (salaAtual) atualizarContagemSala(salaAtual);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`🚀 MODO FURTIVO ATIVO: Operando na porta ${PORT}`));
