const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// 1️⃣ Salas em memória RAM (Movida para o topo para o Firebase conseguir salvar os dados nela)
const salasAtivas = {
  'SALA_GERAL': {
    senha: null,
    criador: 'SISTEMA',
    tokens: []
  }
}; 

// 🛑 TRAVA ANTI-SPAM (Evita que o celular apite toda hora se a conexão de alguém cair e voltar)
let ultimoPushEntrada = 0;

// 2️⃣ 🔐 INÍCIO DA BLINDAGEM DO FIREBASE
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');

let db = null;

try {
  // Tenta ler o arquivo secreto do Render
  const serviceAccount = require('./firebase-key.json');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  
  // 👇 Conectando no banco com o nome correto que você criou no painel: 'vivermais'
  db = getFirestore('vivermais'); 
  
  console.log('✅ FIREBASE CONECTADO: Cofre ativado com sucesso!');
} catch (error) {
  // Se o arquivo não existir ou der erro, o servidor não morre!
  console.log('⚠️ AVISO MODO DE SEGURANÇA: Arquivo firebase-key.json não encontrado ou inválido.');
  console.log('⚠️ O servidor vai continuar rodando 100%, mas salvando apenas na memória RAM por enquanto.');
}

// 📦 FUNÇÕES DO COFRE (Só funcionam se o banco conectou)
async function carregarTokensDoBanco() {
  if (!db) return; // Aborta se não tiver banco
  try {
    const doc = await db.collection('Salas').doc('SALA_GERAL').get();
    if (doc.exists) {
      salasAtivas['SALA_GERAL'].tokens = doc.data().tokens || [];
      console.log(`📦 BEM-VINDO DE VOLTA! ${salasAtivas['SALA_GERAL'].tokens.length} tokens recuperados do cofre.`);
    } else {
      await db.collection('Salas').doc('SALA_GERAL').set({ tokens: [] });
      console.log(`✨ Primeira vez! Cofre SALA_GERAL criado com sucesso no Firebase.`);
    }
  } catch (error) {
    if (error.code === 5) {
      console.log('❌ ALERTA FIREBASE: O banco de dados FIRESTORE "vivermais" não foi encontrado ou não existe!');
    } else {
      console.log('❌ Erro ao carregar do banco:', error);
    }
  }
}

if (db) {
  carregarTokensDoBanco(); // Aciona na inicialização
}

async function salvarTokenNoBanco(token) {
  if (!db) return; // Aborta se não tiver banco
  try {
    const salaRef = db.collection('Salas').doc('SALA_GERAL');
    await salaRef.update({
      tokens: admin.firestore.FieldValue.arrayUnion(token)
    });
    console.log(`💾 Token guardado no cofre do Firestore!`);
  } catch (error) {
    console.log('❌ Erro ao salvar token:', error);
  }
}

// 🧹 O LIXEIRO AUTOMÁTICO (Apaga mensagens com mais de 30 minutos)
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
    console.log(`🧹 LIXEIRO DA SEGURANÇA: ${snapshot.size} mensagens antigas foram varridas da internet para sempre.`);
  } catch (e) { 
    console.log('Erro no lixeiro:', e.message); 
  }
}

// O lixeiro passa a cada 10 minutos varrendo a base
setInterval(lixeiroAutomatico, 10 * 60 * 1000);
// 🔐 FIM DA BLINDAGEM DO FIREBASE

const app = express();
app.use(cors());

// ☕ ROTA DO CAFÉ: Usada por robôs externos para manter o servidor acordado
app.get('/keepalive', (req, res) => {
  const data = new Date().toLocaleTimeString();
  console.log(`☕ [${data}] Bebendo café para não dormir... Servidor imortal!`);
  res.send('Servidor ViverMais 100% Acordado!');
});

const server = http.createServer(app);

// ⚠️ OTIMIZAÇÃO MAX: Limite de 10MB + Ajustes para evitar que a conexão hiberne
const io = new Server(server, { 
  cors: { origin: "*" },
  maxHttpBufferSize: 1e7,
  pingInterval: 25000, 
  pingTimeout: 60000   
});

// 👁️ FUNÇÃO: Rastreador de Usuários Online na Sala (Em tempo real)
function atualizarContagemSala(codigoSala) {
  const room = io.sockets.adapter.rooms.get(codigoSala);
  const qtdOnline = room ? room.size : 0;
  io.to(codigoSala).emit('atualizar_contagem_online', qtdOnline);
  return qtdOnline; // Retornando a quantidade para usar na lógica de mensagens
}

// 🎯 FUNÇÃO PUSH COM PRIORIDADE MAX
async function enviarNotificacao(tokensDestino, tituloPush = '⚡ Energia Recarregada!', corpoPush = 'Sua vida no ViverMais recarregou. Venha bater seu recorde!') {
  const validTokens = tokensDestino.filter(t => t && typeof t === 'string' && t.startsWith('ExponentPushToken'));
  
  if (!validTokens || validTokens.length === 0) {
    console.log('❌ PUSH CANCELADO: Nenhum token válido recebido.');
    return;
  }

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
    console.log(`🔔 RELATÓRIO PUSH (Tentativa para ${validTokens.length} aparelho(s)):`, JSON.stringify(resultado));
  } catch (error) {
    console.log('❌ Erro Crítico ao enviar push:', error);
  }
}

io.on('connection', (socket) => {
  console.log('⚡ Agente Conectado:', socket.id);

  socket.on('ping_fantasma', () => {
    socket.emit('pong_fantasma');
  });

  // 1. Criar Sala com Senha
  socket.on('criar_sala', ({ codigo, senha, tokenPush }) => {
    if (!salasAtivas[codigo]) {
      salasAtivas[codigo] = { senha, criador: socket.id, tokens: [] };
    }
    
    if (tokenPush && !salasAtivas[codigo].tokens.includes(tokenPush)) {
      salasAtivas[codigo].tokens.push(tokenPush);
    }
    
    socket.data.salaAtual = codigo;
    socket.join(codigo);
    
    console.log(`🔒 Sala [${codigo}] Ativa | Token Salvo para PUSH!`);
    atualizarContagemSala(codigo);
  });

  // 2. Entrar em Sala Existente
  socket.on('entrar_sala_privada', ({ codigo, senha, tokenPush }, callback) => {
    const sala = salasAtivas[codigo];
    
    if (sala && sala.senha === senha) {
      socket.data.salaAtual = codigo;
      socket.join(codigo);
      
      if (tokenPush && !sala.tokens.includes(tokenPush)) {
        sala.tokens.push(tokenPush);
      }

      console.log(`👤 Agente entrou na sala: ${codigo}`);
      callback({ status: 'ok' });
      atualizarContagemSala(codigo);
    } else {
      console.log(`❌ Tentativa de acesso falha na sala: ${codigo}`);
      callback({ status: 'erro', msg: 'Código ou Senha incorretos!' });
    }
  });

  // 3. Entrar na SALA_GERAL (A MÁGICA ACONTECE AQUI)
  socket.on('entrar_sala_geral', async ({ tokenPush }) => {
    const codigo = 'SALA_GERAL';
    socket.data.salaAtual = codigo;
    socket.join(codigo);
    
    const sala = salasAtivas[codigo];
    
    if (tokenPush && !sala.tokens.includes(tokenPush)) {
      sala.tokens.push(tokenPush);
      salvarTokenNoBanco(tokenPush);
    }

    console.log(`🌐 Agente acessou a SALA_GERAL`);
    const qtdOnline = atualizarContagemSala(codigo);

    // 🚀 1. BUSCA AS MENSAGENS DOS ÚLTIMOS 30 MINUTOS NO FIREBASE
    if (db) {
      try {
        const snapshot = await db.collection('MensagensTemporarias').where('sala', '==', codigo).get();
        const mensagensRecuperadas = [];
        
        snapshot.forEach(doc => mensagensRecuperadas.push(doc.data()));
        
        // Organiza por tempo (as mais velhas primeiro, para ler na ordem certa)
        mensagensRecuperadas.sort((a, b) => a.timestamp - b.timestamp);
        
        // Entrega as mensagens de volta para o agente que acabou de entrar
        mensagensRecuperadas.forEach(msg => {
          socket.emit('receber_fantasma', msg);
        });
      } catch (error) {
        console.log("Erro ao buscar histórico recente:", error);
      }
    }

    // 🤖 2. MENSAGEM DE SISTEMA SE ESTIVER SOZINHO
    if (qtdOnline === 1) {
      socket.emit('receber_fantasma', {
        id: 'SISTEMA_' + Math.random().toString(36).substring(2, 8),
        texto: '🛡️ MODO SEGURO: Suas mensagens ficam salvas por 30 minutos aguardando outro agente.',
        hora: new Date().toLocaleTimeString()
      });
    }

    // 🔔 3. NOTIFICAÇÃO PUSH COM TRAVA DE 2 MINUTOS (FIM DO SPAM)
    if (sala.tokens.length > 1) {
      const agora = Date.now();
      if (agora - ultimoPushEntrada > 120000) { // 120.000 ms = 2 minutos
        const tokensParaAvisar = sala.tokens.filter(t => t !== tokenPush);
        enviarNotificacao(tokensParaAvisar, '🏆 Novo Competidor!', 'Alguém acabou de entrar no app ViverMais. Será que vão bater seu recorde?');
        ultimoPushEntrada = agora; // Atualiza o relógio da trava
      }
    }
  });

  // 4. Disparar Alerta Global
  socket.on('alerta_global_enviar', (msg) => {
    console.log(`🚨 ALERTA GLOBAL DISPARADO: ${msg}`);
    io.emit('alerta_geral_recebido', msg);

    const todosTokens = new Set();
    Object.values(salasAtivas).forEach(sala => {
      sala.tokens.forEach(t => todosTokens.add(t));
    });

    enviarNotificacao(Array.from(todosTokens), '🚨 ATENÇÃO GLOBAL', 'Alguém acionou o modo RANKING global. Acesse o app agora!');
  });

  // 5. Enviar Mensagem Fantasma (Agora com Persistência Automática)
  socket.on('enviar_fantasma', async (dados) => {
    const mensagemFinal = {
      ...dados,
      id: Math.random().toString(36).substring(2, 10), 
      hora: new Date().toLocaleTimeString(),
      timestamp: Date.now() // Carimbo de tempo vital para o lixeiro funcionar
    };

    // 💾 SALVA A MENSAGEM NO FIREBASE (Gaveta criada automaticamente!)
    if (db) {
      try {
        await db.collection('MensagensTemporarias').add(mensagemFinal);
      } catch (error) {
        console.log("Erro ao salvar mensagem temporária no cofre.");
      }
    }

    // 🚀 ENVIA PARA QUEM ESTIVER ONLINE NA MESMA HORA (Modo Silencioso, sem Push)
    socket.to(dados.sala).emit('receber_fantasma', mensagemFinal);
  });

  // 6. Saída Voluntária
  socket.on('sair_sala', () => {
    const salaAtual = socket.data.salaAtual;
    if (salaAtual) {
      socket.leave(salaAtual);
      socket.data.salaAtual = null;
      console.log(`🚪 Agente saiu da sala: ${salaAtual}`);
      atualizarContagemSala(salaAtual);
    }
  });

  // 7. Desconexão Abrupta
  socket.on('disconnect', () => {
    console.log('🚫 Agente Desconectado:', socket.id);
    const salaAtual = socket.data.salaAtual;
    if (salaAtual) {
      atualizarContagemSala(salaAtual);
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`🚀 Servidor Fantasma Blindado rodando na porta ${PORT}`));
