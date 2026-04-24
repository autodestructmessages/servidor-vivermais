const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// 1️⃣ Salas em memória RAM
const salasAtivas = {
  'SALA_GERAL': {
    senha: null,
    criador: 'SISTEMA',
    tokens: [],
    mensagemPendente: null // 🗝️ Cofre Temporário: Só guarda enquanto ninguém lê
  }
}; 

let ultimoPushEntrada = 0;

// 2️⃣ 🔐 FIREBASE (Apenas para os Tokens de Notificação)
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
let db = null;

try {
  const serviceAccount = require('./firebase-key.json');
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  db = getFirestore('vivermais'); 
  console.log('✅ FIREBASE CONECTADO: Sistema de PUSH pronto.');
} catch (error) {
  console.log('⚠️ MODO SEGURANÇA: Firebase offline. Pushes podem não funcionar.');
}

// Funções de banco (Tokens)
async function carregarTokensDoBanco() {
  if (!db) return;
  try {
    const doc = await db.collection('Salas').doc('SALA_GERAL').get();
    if (doc.exists) salasAtivas['SALA_GERAL'].tokens = doc.data().tokens || [];
  } catch (e) { console.log('Erro ao carregar tokens:', e.message); }
}
if (db) carregarTokensDoBanco();

async function salvarTokenNoBanco(token) {
  if (!db) return;
  try {
    await db.collection('Salas').doc('SALA_GERAL').update({
      tokens: admin.firestore.FieldValue.arrayUnion(token)
    });
  } catch (e) { console.log('Erro ao salvar token'); }
}

const app = express();
app.use(cors());
app.get('/keepalive', (req, res) => res.send('Servidor ViverMais Ativo!'));

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

async function enviarNotificacao(tokensDestino, titulo, corpo) {
  const validTokens = tokensDestino.filter(t => t && t.startsWith('ExponentPushToken'));
  if (validTokens.length === 0) return;

  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validTokens.map(token => ({
        to: token, sound: 'default', title: titulo, body: corpo, priority: 'high'
      }))),
    });
  } catch (e) { console.log('Erro no Push'); }
}

io.on('connection', (socket) => {
  
  // 3. Entrar na SALA_GERAL
  socket.on('entrar_sala_geral', ({ tokenPush }) => {
    const codigo = 'SALA_GERAL';
    socket.data.salaAtual = codigo;
    socket.join(codigo);
    
    const sala = salasAtivas[codigo];
    
    if (tokenPush && !sala.tokens.includes(tokenPush)) {
      sala.tokens.push(tokenPush);
      salvarTokenNoBanco(tokenPush);
    }

    const qtdOnline = atualizarContagemSala(codigo);

    // 🗝️ AÇÃO DO COFRE: Se tiver mensagem pendente e agora tem gente na sala, entrega e apaga!
    if (qtdOnline > 1 && sala.mensagemPendente) {
      console.log('📦 Entregando mensagem do cofre temporário...');
      // Envia para quem acabou de entrar
      socket.emit('receber_fantasma', sala.mensagemPendente);
      // Apaga do servidor IMEDIATAMENTE (Segurança Total)
      sala.mensagemPendente = null; 
    }

    // 🤖 Aviso para o usuário sozinho
    if (qtdOnline === 1) {
      socket.emit('receber_fantasma', {
        id: 'SISTEMA_AVISO',
        texto: '🛡️ AGUARDANDO AGENTE: Suas mensagens serão enviadas automaticamente assim que o próximo agente entrar.',
        hora: new Date().toLocaleTimeString()
      });
    }

    // Notificação Push de entrada com trava (2 minutos)
    const agora = Date.now();
    if (sala.tokens.length > 1 && (agora - ultimoPushEntrada > 120000)) {
      const tokensParaAvisar = sala.tokens.filter(t => t !== tokenPush);
      enviarNotificacao(tokensParaAvisar, '🏆 Novo Competidor!', 'Alguém acessou o app ViverMais.');
      ultimoPushEntrada = agora;
    }
  });

  // 5. Enviar Mensagem Fantasma (Com Inteligência de Entrega)
  socket.on('enviar_fantasma', (dados) => {
    const sala = salasAtivas[dados.sala];
    const room = io.sockets.adapter.rooms.get(dados.sala);
    const qtdOnline = room ? room.size : 0;

    const mensagemFinal = {
      ...dados,
      id: Math.random().toString(36).substring(2, 10), 
      hora: new Date().toLocaleTimeString()
    };

    if (qtdOnline <= 1) {
      // 💾 Ninguém online? Guarda no cofre de RAM
      if (sala) {
        sala.mensagemPendente = mensagemFinal;
        console.log('🔒 Mensagem guardada no cofre de RAM (Aguardando parceiro)');
      }
    } else {
      // 🚀 Tem gente online? Envia direto
      socket.to(dados.sala).emit('receber_fantasma', mensagemFinal);
    }
  });

  socket.on('disconnect', () => {
    if (socket.data.salaAtual) atualizarContagemSala(socket.data.salaAtual);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`🚀 Servidor Blindado rodando na porta ${PORT}`));
