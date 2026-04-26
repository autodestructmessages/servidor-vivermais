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

// 📓 NOVO: Caderninho de Recibos (Evita mensagens duplicadas)
const controleDeEntregas = {}; 

let ultimoPushEntrada = 0;

// 🛡️ CRIPTOGRAFIA MILITAR: Puxando a chave secreta do painel do Render
// Se não achar no Render, usa uma de teste (nunca use a de teste em produção oficial)
const senhaSecreta = process.env.CHAVE_MESTRA || 'ChaveTemporariaLocalViverMais2026';
const ENCRYPTION_KEY = crypto.scryptSync(senhaSecreta, 'salt', 32); 
const IV_LENGTH = 16;

// 🔒 Função para Embaralhar antes de ir pro Firebase
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

// 🔓 Função para Desembaralhar quando puxar do Firebase
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
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  db = getFirestore('vivermais'); 
} catch (error) {
  console.log('⚠️ AVISO MODO DE SEGURANÇA: Arquivo firebase-key.json não encontrado ou inválido.');
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
  } catch (error) { /* Silenciado no modo furtivo */ }
}

if (db) carregarTokensDoBanco(); 

async function salvarTokenNoBanco(token) {
  if (!db) return; 
  try {
    const salaRef = db.collection('Salas').doc('SALA_GERAL');
    await salaRef.update({
      tokens: admin.firestore.FieldValue.arrayUnion(token)
    });
  } catch (error) { /* Silenciado */ }
}

// 🧹 LIXEIRO AUTOMÁTICO (Apaga em 30 min)
async function lixeiroAutomatico() {
  if (!db) return;
  const meiaHoraAtras = Date.now() - (30 * 60 * 1000);
  try {
    const snapshot = await db.collection('MensagensTemporarias')
      .where('timestamp', '<', meiaHoraAtras)
      .get();

    if (snapshot.empty) return;

    const batch = db.batch();
    snapshot.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
  } catch (e) { /* Silenciado */ }
}

setInterval(lixeiroAutomatico, 10 * 60 * 1000);

const app = express();
app.use(cors());

// ☕ ROTA DO CAFÉ: O único log permitido (pra você ver o monitor funcionando)
app.get('/keepalive', (req, res) => {
  const data = new Date().toLocaleTimeString();
  console.log(`☕ [${data}] Bebendo café para não dormir... Monitor ativo!`);
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

async function enviarNotificacao(tokensDestino, tituloPush = '⚡ Energia Recarregada!', corpoPush = 'Sua vida no ViverMais recarregou!') {
  const validTokens = tokensDestino.filter(t => t && typeof t === 'string' && t.startsWith('ExponentPushToken'));
  if (!validTokens || validTokens.length === 0) return;

  const mensagensPush = validTokens.map(token => ({
    to: token, sound: 'default', title: tituloPush, body: corpoPush, priority: 'high', data: { segredo: true }, 
  }));

  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Accept-encoding': 'gzip, deflate', 'Content-Type': 'application/json' },
      body: JSON.stringify(mensagensPush),
    });
  } catch (error) { /* Silenciado */ }
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

  socket.on('entrar_sala_geral', async ({ tokenPush }) => {
    const codigo = 'SALA_GERAL';
    socket.data.salaAtual = codigo;
    
    // 👈 NOVO: Memoriza quem é esse socket para o caderninho
    socket.data.tokenPush = tokenPush; 
    socket.join(codigo);
    
    // 👈 NOVO: Cria a folha desse usuário no caderninho se não existir
    if (tokenPush && !controleDeEntregas[tokenPush]) {
      controleDeEntregas[tokenPush] = new Set();
    }
    
    const sala = salasAtivas[codigo];
    
    if (tokenPush && !sala.tokens.includes(tokenPush)) {
      sala.tokens.push(tokenPush);
      salvarTokenNoBanco(tokenPush);
    }

    const qtdOnline = atualizarContagemSala(codigo);

    // 🚀 RECUPERA O HISTÓRICO, DESCRIPTOGRAFA E FILTRA
    if (db) {
      try {
        const snapshot = await db.collection('MensagensTemporarias').where('sala', '==', codigo).get();
        const mensagensRecuperadas = [];
        
        snapshot.forEach(doc => {
          let msg = doc.data();
          // 🔓 Desembaralha antes de mandar pro celular
          if (msg.texto) msg.texto = decrypt(msg.texto);
          if (msg.audio) msg.audio = decrypt(msg.audio);
          if (msg.imagem) msg.imagem = decrypt(msg.imagem);
          mensagensRecuperadas.push(msg);
        });

        mensagensRecuperadas.sort((a, b) => a.timestamp - b.timestamp);
        
        mensagensRecuperadas.forEach(msg => {
          // 🛑 A MÁGICA: Só entrega se não for dele E se ainda não estiver no caderninho
          const jaRecebeu = tokenPush && controleDeEntregas[tokenPush].has(msg.id);
          
          if (msg.tokenRemetente !== tokenPush && !jaRecebeu) {
            socket.emit('receber_fantasma', msg);
            if (tokenPush) controleDeEntregas[tokenPush].add(msg.id); // 👈 Carimba que entregou
          }
        });
      } catch (error) { /* Silenciado */ }
    }

    if (qtdOnline === 1) {
      socket.emit('receber_fantasma', {
        id: 'SISTEMA_' + Math.random().toString(36).substring(2, 8),
        texto: '🛡️ MODO SEGURO: Protocolos ativos. Aguardando conexão...',
        hora: new Date().toLocaleTimeString()
      });
    }

    if (sala.tokens.length > 1) {
      const agora = Date.now();
      if (agora - ultimoPushEntrada > 120000) { 
        const tokensParaAvisar = sala.tokens.filter(t => t !== tokenPush);
        enviarNotificacao(tokensParaAvisar, '🏆 Novo Competidor!', 'Alguém entrou no ViverMais.');
        ultimoPushEntrada = agora; 
      }
    }
  });

  socket.on('alerta_global_enviar', (msg) => {
    io.emit('alerta_geral_recebido', msg);
    const todosTokens = new Set();
    Object.values(salasAtivas).forEach(sala => sala.tokens.forEach(t => todosTokens.add(t)));
    enviarNotificacao(Array.from(todosTokens), '🚨 ATENÇÃO GLOBAL', 'Alguém acionou o RANKING!');
  });

  // 💾 SALVANDO NO FIREBASE COM CRIPTOGRAFIA
  socket.on('enviar_fantasma', async (dados) => {
    const mensagemFinal = {
      ...dados,
      id: Math.random().toString(36).substring(2, 10), 
      hora: new Date().toLocaleTimeString(),
      timestamp: Date.now() 
    };

    if (db) {
      try { 
        // 🔒 Criptografa pro Firebase não fofocar
        const mensagemBlindada = { ...mensagemFinal };
        if (mensagemBlindada.texto) mensagemBlindada.texto = encrypt(mensagemBlindada.texto);
        if (mensagemBlindada.audio) mensagemBlindada.audio = encrypt(mensagemBlindada.audio);
        if (mensagemBlindada.imagem) mensagemBlindada.imagem = encrypt(mensagemBlindada.imagem);

        await db.collection('MensagensTemporarias').add(mensagemBlindada); 
      } catch (error) { /* Silenciado */ }
    }

    // 🚚 ENTREGA VIP: Em vez de gritar na sala, entrega individualmente e anota no caderninho
    const socketsNaSala = await io.in(dados.sala).fetchSockets();
    socketsNaSala.forEach(soc => {
      if (soc.id !== socket.id) { // Não entrega de volta pro próprio remetente
        soc.emit('receber_fantasma', mensagemFinal);
        
        // Anota que esse usuário já recebeu a mensagem ao vivo
        const tokenDestino = soc.data.tokenPush;
        if (tokenDestino) {
          if (!controleDeEntregas[tokenDestino]) controleDeEntregas[tokenDestino] = new Set();
          controleDeEntregas[tokenDestino].add(mensagemFinal.id);
        }
      }
    });
  });

  // =====================================
  // 🏆 SISTEMA DE RANKING GLOBAL ANÔNIMO
  // =====================================
  
  // Salva novo recorde e avisa todo mundo do novo TOP 3
  socket.on('novo_recorde_anonimo', async ({ jogo, pontos }) => {
    if (!db || !jogo || pontos === undefined || pontos === null) return;
    try {
      // 1. Guarda os pontos no cofre (Sem nome, sem IP, apenas os pontos)
      await db.collection(`Ranking_${jogo}`).add({
        pontos: pontos,
        timestamp: Date.now()
      });

      // 2. Busca quem são os 3 melhores de todos os tempos daquele jogo
      const snapshot = await db.collection(`Ranking_${jogo}`)
        .orderBy('pontos', 'desc')
        .limit(3)
        .get();

      const top3 = [];
      snapshot.forEach(doc => top3.push(doc.data()));

      // 3. Atualiza os placares ao vivo de quem está com o app aberto
      io.emit('atualizar_ranking', { [jogo]: top3 });
      
    } catch (error) {
      /* Silenciado no modo furtivo */
    }
  });

  // Quando alguém abre a tela de Ranking, o app pede a lista atualizada
  socket.on('pedir_ranking', async () => {
    if (!db) return;
    try {
      const rankings = { bolhas: [], tetris: [], dino: [], reflexo: [], frenesi: [] };
      const jogos = ['bolhas', 'tetris', 'dino', 'reflexo', 'frenesi'];
      
      // Varre todos os jogos para montar o placar completo
      for (const j of jogos) {
        const snap = await db.collection(`Ranking_${j}`).orderBy('pontos', 'desc').limit(3).get();
        snap.forEach(doc => rankings[j].push(doc.data()));
      }

      // Devolve para quem pediu
      socket.emit('atualizar_ranking', rankings);
    } catch (error) {
      /* Silenciado */
    }
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
// O único log na porta pra você saber que iniciou sem erros
server.listen(PORT, () => console.log(`🚀 MODO FURTIVO ATIVO: Operando na porta ${PORT}`));
