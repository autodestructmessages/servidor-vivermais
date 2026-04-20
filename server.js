const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);

// ⚠️ OTIMIZAÇÃO MAX: Limite de 10MB + Ajustes para evitar que a conexão hiberne
const io = new Server(server, { 
  cors: { origin: "*" },
  maxHttpBufferSize: 1e7,
  pingInterval: 25000, // Dispara verificação a cada 25s
  pingTimeout: 60000   // Dá até 60s para o celular responder antes de derrubar
});

// Salas em memória RAM (Volátil: Desaparece completamente ao reiniciar o servidor)
const salasAtivas = {
  'SALA_GERAL': {
    senha: null,
    criador: 'SISTEMA',
    tokens: []
  }
}; 

// 🧹 LIXEIRO AUTOMÁTICO DE SALAS VAZIAS (A cada 30 minutos)
// Impede que o servidor fique com a memória cheia de salas abandonadas
setInterval(() => {
  console.log('🧹 Lixeiro passando: Verificando salas inativas...');
  let salasLimpas = 0;

  for (const codigoSala in salasAtivas) {
    // A regra de ouro: NUNCA apagar a SALA_GERAL
    if (codigoSala === 'SALA_GERAL') continue;

    // Verifica quantas pessoas estão conectadas fisicamente naquela sala agora
    const room = io.sockets.adapter.rooms.get(codigoSala);
    const qtdOnline = room ? room.size : 0;

    // Se a sala estiver totalmente vazia (0 pessoas online), nós a deletamos da RAM
    if (qtdOnline === 0) {
      delete salasAtivas[codigoSala];
      salasLimpas++;
      console.log(`🗑️ Sala [${codigoSala}] foi apagada da memória.`);
    }
  }

  if (salasLimpas > 0) {
    console.log(`✅ Limpeza concluída: ${salasLimpas} sala(s) fantasma(s) eliminada(s).`);
  }
}, 30 * 60 * 1000); // 30 minutos (em milissegundos)

// 👁️ FUNÇÃO NOVA: Rastreador de Usuários Online na Sala
// Pega direto da placa de rede virtual do Socket, é instantâneo e não pesa na RAM.
function atualizarContagemSala(codigoSala) {
  const room = io.sockets.adapter.rooms.get(codigoSala);
  const qtdOnline = room ? room.size : 0;
  // Emite a quantidade de pessoas para todos que estão dentro dessa sala específica
  io.to(codigoSala).emit('atualizar_contagem_online', qtdOnline);
}

// 🎯 FUNÇÃO PUSH UPGRADED: Prioridade Máxima Forçada
async function enviarNotificacao(tokensDestino, tituloPush = '⚡ Energia Recarregada!', corpoPush = 'Sua vida no ViverMais recarregou. Venha bater seu recorde no Reflexo Rápido!') {
  if (!tokensDestino || tokensDestino.length === 0) return;

  const mensagensPush = tokensDestino.map(token => ({
    to: token,
    sound: 'default',
    title: tituloPush,
    body: corpoPush,
    priority: 'high', // ⚠️ CRUCIAL: Força o Android/iOS a acordar e exibir na hora
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
    console.log(`🔔 Push (Prioridade HIGH) disparado para ${tokensDestino.length} aparelho(s)!`);
  } catch (error) {
    console.log('❌ Erro ao enviar push:', error);
  }
}

io.on('connection', (socket) => {
  console.log('⚡ Agente Conectado:', socket.id);

  // 0. HEARTBEAT MODO FANTASMA: Mantém a conexão aberta e tira do modo 'economia'
  socket.on('ping_fantasma', () => {
    socket.emit('pong_fantasma');
  });

  // 1. Criar Sala com Senha
  socket.on('criar_sala', ({ codigo, senha, tokenPush }) => {
    salasAtivas[codigo] = { 
      senha, 
      criador: socket.id,
      tokens: tokenPush ? [tokenPush] : [] 
    };
    
    socket.data.salaAtual = codigo; // Guarda a info para limpar quando desconectar
    socket.join(codigo);
    
    console.log(`🔒 Sala Criada: ${codigo} | Token Registrado: ${tokenPush ? 'Sim' : 'Não'}`);
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

      console.log(`👤 Agente acessou a sala privada: ${codigo}`);
      callback({ status: 'ok' });
      atualizarContagemSala(codigo);
    } else {
      console.log(`❌ Tentativa de acesso falha na sala: ${codigo}`);
      callback({ status: 'erro', msg: 'Código ou Senha incorretos!' });
    }
  });

  // 3. Entrar na SALA_GERAL (Singleton Seguro)
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

    // Notifica os OUTROS usuários da sala geral que alguém novo entrou
    if (sala.tokens.length > 1) {
      const tokensParaAvisar = sala.tokens.filter(t => t !== tokenPush);
      enviarNotificacao(tokensParaAvisar, '🏆 Novo Competidor!', 'Alguém acabou de entrar no app ViverMais. Será que vão bater seu recorde?');
    }
  });

  // 4. Disparar Alerta Global
  socket.on('alerta_global_enviar', (msg) => {
    console.log(`🚨 ALERTA GLOBAL DISPARADO: ${msg}`);
    
    // 1. Emite via Socket para o app vibrar na hora e abrir o Alert na tela 
    io.emit('alerta_geral_recebido', msg);

    // 2. Coleta TODOS os tokens de TODAS as salas ativas para mandar um Push Notification
    const todosTokens = new Set();
    Object.values(salasAtivas).forEach(sala => {
      sala.tokens.forEach(t => todosTokens.add(t));
    });

    enviarNotificacao(Array.from(todosTokens), '⏳ Atualização Diária', 'Lembre-se de fazer seus exercícios mentais diários. Acesse o app agora!');
  });

  // 5. Enviar Mensagem Fantasma (Texto, Foto ou Áudio)
  socket.on('enviar_fantasma', (dados) => {
    // Dispara a mensagem para o front-end (retransmissão em tempo real)
    socket.to(dados.sala).emit('receber_fantasma', {
      ...dados,
      id: Math.random().toString(36).substring(2, 10), 
      hora: new Date().toLocaleTimeString()
    });

    // PUSH: Pega os tokens da sala e avisa que tem mensagem!
    const sala = salasAtivas[dados.sala];
    if (sala && sala.tokens && sala.tokens.length > 0) {
      const tokensParaAvisar = sala.tokens.filter(t => t !== dados.tokenRemetente);
      enviarNotificacao(tokensParaAvisar);
    }
  });

  // 6. Saída Voluntária da Sala (Para atualizar os números de quem ficou)
  socket.on('sair_sala', () => {
    const salaAtual = socket.data.salaAtual;
    if (salaAtual) {
      socket.leave(salaAtual);
      socket.data.salaAtual = null;
      console.log(`🚪 Agente saiu da sala: ${salaAtual}`);
      atualizarContagemSala(salaAtual);
    }
  });

  // 7. Desconexão Abrupta (Quando o app é fechado)
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
