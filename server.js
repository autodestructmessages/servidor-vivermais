const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

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

// Salas em memória RAM
const salasAtivas = {
  'SALA_GERAL': {
    senha: null,
    criador: 'SISTEMA',
    tokens: []
  }
}; 

// 🛑 LIXEIRO DESATIVADO! 
// Agora as salas NUNCA mais são apagadas quando os usuários fecham o app. 
// Os tokens ficarão guardados para receberem os Pushes!

// 👁️ FUNÇÃO: Rastreador de Usuários Online na Sala (Em tempo real)
function atualizarContagemSala(codigoSala) {
  const room = io.sockets.adapter.rooms.get(codigoSala);
  const qtdOnline = room ? room.size : 0;
  io.to(codigoSala).emit('atualizar_contagem_online', qtdOnline);
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
    // Se a sala não existe, cria. Se já existe, não sobreescreve (para não perder os tokens)
    if (!salasAtivas[codigo]) {
      salasAtivas[codigo] = { 
        senha, 
        criador: socket.id,
        tokens: [] 
      };
    }
    
    // Adiciona o token de quem criou, se não estiver lá
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
      
      // Guarda o token eternamente na sala
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

  // 3. Entrar na SALA_GERAL
  socket.on('entrar_sala_geral', ({ tokenPush }) => {
    const codigo = 'SALA_GERAL';
    socket.data.salaAtual = codigo;
    socket.join(codigo);
    
    const sala = salasAtivas[codigo];
    
    if (tokenPush && !sala.tokens.includes(tokenPush)) {
      sala.tokens.push(tokenPush);
    }

    console.log(`🌐 Agente acessou a SALA_GERAL`);
    atualizarContagemSala(codigo);

    if (sala.tokens.length > 1) {
      const tokensParaAvisar = sala.tokens.filter(t => t !== tokenPush);
      enviarNotificacao(tokensParaAvisar, '🏆 Novo Competidor!', 'Alguém acabou de entrar no app ViverMais. Será que vão bater seu recorde?');
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

  // 5. Enviar Mensagem Fantasma (Texto, Foto ou Áudio)
  socket.on('enviar_fantasma', (dados) => {
    socket.to(dados.sala).emit('receber_fantasma', {
      ...dados,
      id: Math.random().toString(36).substring(2, 10), 
      hora: new Date().toLocaleTimeString()
    });

    const sala = salasAtivas[dados.sala];
    // Se a sala existe e tem tokens salvos, dispara o PUSH!
    if (sala && sala.tokens && sala.tokens.length > 0) {
      const tokensParaAvisar = sala.tokens.filter(t => t !== dados.tokenRemetente);
      enviarNotificacao(tokensParaAvisar, '💬 Novo Recorde!', 'Alguém registrou um novo ranking, acesse agora.');
    }
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
server.listen(PORT, () => console.log(`🚀 Servidor Fantasma rodando na porta ${PORT}`));
