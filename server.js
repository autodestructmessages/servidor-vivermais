const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const admin = require('firebase-admin');

// 🔐 CONEXÃO COM O COFRE DO FIREBASE
// Ele vai ler o arquivo de chave que vamos configurar no Render
const serviceAccount = require('./firebase-key.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const app = express();
app.use(cors());

// ☕ ROTA DO CAFÉ: Mantém o servidor acordado
app.get('/keepalive', (req, res) => {
  const data = new Date().toLocaleTimeString();
  console.log(`☕ [${data}] Bebendo café...`);
  res.send('Servidor ViverMais 100% Acordado!');
});

const server = http.createServer(app);

const io = new Server(server, { 
  cors: { origin: "*" },
  maxHttpBufferSize: 1e7,
  pingInterval: 25000, 
  pingTimeout: 60000   
});

// Salas em memória RAM
const salasAtivas = {
  'SALA_GERAL': {
    senha: null,
    criador: 'SISTEMA',
    tokens: []
  }
}; 

// 📦 FUNÇÃO NOVA: Carrega os tokens do banco assim que o servidor liga!
async function carregarTokensDoBanco() {
  try {
    const doc = await db.collection('Salas').doc('SALA_GERAL').get();
    if (doc.exists) {
      salasAtivas['SALA_GERAL'].tokens = doc.data().tokens || [];
      console.log(`📦 BEM-VINDO DE VOLTA! ${salasAtivas['SALA_GERAL'].tokens.length} tokens recuperados do cofre.`);
    } else {
      console.log('📦 Primeira vez! Criando o cofre da SALA_GERAL no banco...');
      await db.collection('Salas').doc('SALA_GERAL').set({ tokens: [] });
    }
  } catch (error) {
    console.log('❌ Erro ao carregar do banco:', error);
  }
}
// Aciona a busca imediatamente
carregarTokensDoBanco();

// 💾 FUNÇÃO NOVA: Salva um token no banco pra sempre
async function salvarTokenNoBanco(token) {
  try {
    const salaRef = db.collection('Salas').doc('SALA_GERAL');
    // arrayUnion garante que o mesmo token não seja salvo duas vezes!
    await salaRef.update({
      tokens: admin.firestore.FieldValue.arrayUnion(token)
    });
    console.log(`💾 Token guardado no cofre do Firestore!`);
  } catch (error) {
    console.log('❌ Erro ao salvar token:', error);
  }
}

// Rastreador
function atualizarContagemSala(codigoSala) {
  const room = io.sockets.adapter.rooms.get(codigoSala);
  const qtdOnline = room ? room.size : 0;
  io.to(codigoSala).emit('atualizar_contagem_online', qtdOnline);
}

// Envio de Push Notification
async function enviarNotificacao(tokensDestino, tituloPush = '⚡ Energia Recarregada!', corpoPush = 'Sua vida no ViverMais recarregou. Venha bater seu recorde!') {
  const validTokens = tokensDestino.filter(t => t && typeof t === 'string' && t.startsWith('ExponentPushToken'));
  
  if (!validTokens || validTokens.length === 0) return;

  const mensagensPush = validTokens.map(token => ({
    to: token,
    sound: 'default',
    title: tituloPush,
    body: corpoPush,
    priority: 'high', 
    channelId: 'default',
    data: { segredo: true }, 
  }));

  try {
    const resposta = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(mensagensPush),
    });
    const resultado = await resposta.json();
    console.log(`🔔 RELATÓRIO PUSH:`, JSON.stringify(resultado));
  } catch (error) {
    console.log('❌ Erro Crítico ao enviar push:', error);
  }
}

io.on('connection', (socket) => {
  socket.on('ping_fantasma', () => socket.emit('pong_fantasma'));

  socket.on('criar_sala', ({ codigo, senha, tokenPush }) => {
    if (!salasAtivas[codigo]) {
      salasAtivas[codigo] = { senha, criador: socket.id, tokens: [] };
    }
    if (tokenPush && !salasAtivas[codigo].tokens.includes(tokenPush)) {
      salasAtivas[codigo].tokens.push(tokenPush);
    }
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
      callback({ status: 'erro', msg: 'Código ou Senha incorretos!' });
    }
  });

  socket.on('entrar_sala_geral', ({ tokenPush }) => {
    const codigo = 'SALA_GERAL';
    socket.data.salaAtual = codigo;
    socket.join(codigo);
    
    const sala = salasAtivas[codigo];
    
    if (tokenPush && !sala.tokens.includes(tokenPush)) {
      sala.tokens.push(tokenPush);
      // 🚀 SALVANDO NO BANCO DE DADOS EM TEMPO REAL
      salvarTokenNoBanco(tokenPush);
    }

    atualizarContagemSala(codigo);

    if (sala.tokens.length > 1) {
      const tokensParaAvisar = sala.tokens.filter(t => t !== tokenPush);
      enviarNotificacao(tokensParaAvisar, '🏆 Novo Competidor!', 'Alguém acabou de entrar no app ViverMais. Será que vão bater seu recorde?');
    }
  });

  socket.on('alerta_global_enviar', (msg) => {
    io.emit('alerta_geral_recebido', msg);
    const todosTokens = new Set();
    Object.values(salasAtivas).forEach(sala => sala.tokens.forEach(t => todosTokens.add(t)));
    enviarNotificacao(Array.from(todosTokens), '🚨 ATENÇÃO GLOBAL', 'Alguém acionou o modo RANKING global. Acesse o app agora!');
  });

  socket.on('enviar_fantasma', (dados) => {
    socket.to(dados.sala).emit('receber_fantasma', {
      ...dados,
      id: Math.random().toString(36).substring(2, 10), 
      hora: new Date().toLocaleTimeString()
    });

    const sala = salasAtivas[dados.sala];
    if (sala && sala.tokens && sala.tokens.length > 0) {
      const tokensParaAvisar = sala.tokens.filter(t => t !== dados.tokenRemetente);
      enviarNotificacao(tokensParaAvisar, '💬 Novo Recorde!', 'Alguém registrou um novo ranking, acesse agora.');
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
server.listen(PORT, () => console.log(`🚀 Servidor ViverMais rodando na porta ${PORT}`));
