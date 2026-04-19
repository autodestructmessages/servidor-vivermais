const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);

// ⚠️ AUMENTAMOS O LIMITE PARA 10MB (maxHttpBufferSize)
const io = new Server(server, { 
  cors: { origin: "*" },
  maxHttpBufferSize: 1e7 
});

// Salas em memória RAM
const salasAtivas = {
  // Inicializamos a Sala Geral por padrão para que ela sempre exista
  'SALA GERAL': {
    senha: null,
    criador: 'SISTEMA',
    tokens: []
  }
}; 

// 🎯 FUNÇÃO SECRETA UPGRADED: Agora podemos mudar o texto do Push!
async function enviarNotificacao(tokensDestino, tituloPush = '⚡ Energia Recarregada!', corpoPush = 'Sua vida no ViverMais recarregou. Venha bater seu recorde no Reflexo Rápido!') {
  if (!tokensDestino || tokensDestino.length === 0) return;

  // Monta a notificação (camuflada ou de alerta)
  const mensagensPush = tokensDestino.map(token => ({
    to: token,
    sound: 'default',
    title: tituloPush,
    body: corpoPush,
    data: { segredo: true }, 
  }));

  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(mensagensPush),
    });
    console.log('🔔 Push disparado para', tokensDestino.length, 'aparelho(s)!');
  } catch (error) {
    console.log('❌ Erro ao enviar push:', error);
  }
}

io.on('connection', (socket) => {
  console.log('⚡ Agente Conectado:', socket.id);

  // 1. Criar Sala com Senha
  socket.on('criar_sala', ({ codigo, senha, tokenPush }) => {
    salasAtivas[codigo] = { 
      senha, 
      criador: socket.id,
      tokens: tokenPush ? [tokenPush] : [] 
    };
    socket.join(codigo);
    console.log(`🔒 Sala Criada: ${codigo} | Token Registrado: ${tokenPush ? 'Sim' : 'Não'}`);
  });

  // 2. Entrar em Sala Existente
  socket.on('entrar_sala_privada', ({ codigo, senha, tokenPush }, callback) => {
    const sala = salasAtivas[codigo];
    
    if (sala && sala.senha === senha) {
      socket.join(codigo);
      
      if (tokenPush && !sala.tokens.includes(tokenPush)) {
        sala.tokens.push(tokenPush);
      }

      console.log(`👤 Agente acessou a sala privada: ${codigo}`);
      callback({ status: 'ok' });
    } else {
      console.log(`❌ Tentativa de acesso falha na sala: ${codigo}`);
      callback({ status: 'erro', msg: 'Código ou Senha incorretos!' });
    }
  });

  // 🌟 NOVO: Entrar na SALA GERAL
  socket.on('entrar_sala_geral', ({ tokenPush }) => {
    const codigo = 'SALA GERAL';
    socket.join(codigo);
    
    const sala = salasAtivas[codigo];
    
    if (tokenPush && !sala.tokens.includes(tokenPush)) {
      sala.tokens.push(tokenPush);
    }

    console.log(`🌐 Agente acessou a SALA GERAL`);

    // Notifica os OUTROS usuários da sala geral que alguém novo entrou
    if (sala.tokens.length > 1) {
      const tokensParaAvisar = sala.tokens.filter(t => t !== tokenPush);
      // Usamos um texto disfarçado de "Novo Recorde" para avisar que alguém logou
      enviarNotificacao(tokensParaAvisar, '🏆 Novo Competidor!', 'Alguém acabou de entrar no app ViverMais. Será que vão bater seu recorde?');
    }
  });

  // 🚨 NOVO: Disparar Alerta Global
  socket.on('alerta_global_enviar', (msg) => {
    console.log(`🚨 ALERTA GLOBAL DISPARADO: ${msg}`);
    
    // 1. Emite via Socket para o app vibrar na hora e abrir o Alert na tela (para quem está com app aberto)
    io.emit('alerta_geral_recebido', msg);

    // 2. Coleta TODOS os tokens de TODAS as salas ativas para mandar um Push Notification (para quem tá com app fechado)
    const todosTokens = new Set();
    Object.values(salasAtivas).forEach(sala => {
      sala.tokens.forEach(t => todosTokens.add(t));
    });

    // Envia o Push. Aqui o ideal é manter um texto inofensivo, para caso alguém veja a tela bloqueada!
    enviarNotificacao(Array.from(todosTokens), '⏳ Atualização Diária', 'Lembre-se de fazer seus exercícios mentais diários. Acesse o app agora!');
  });

  // 3. Enviar Mensagem (Texto, Foto ou Áudio)
  socket.on('enviar_fantasma', (dados) => {
    // Dispara a mensagem para o front-end
    socket.to(dados.sala).emit('receber_fantasma', {
      ...dados,
      id: Math.random().toString(36).substring(2, 10), 
      hora: new Date().toLocaleTimeString()
    });

    // PUSH: Pega os tokens da sala e avisa que tem mensagem!
    const sala = salasAtivas[dados.sala];
    if (sala && sala.tokens && sala.tokens.length > 0) {
      const tokensParaAvisar = sala.tokens.filter(t => t !== dados.tokenRemetente);
      // Aqui usamos os textos padrão originais disfarçados
      enviarNotificacao(tokensParaAvisar);
    }
  });

  socket.on('disconnect', () => {
    console.log('🚫 Agente Desconectado:', socket.id);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`🚀 Servidor Fantasma rodando na porta ${PORT}`));
