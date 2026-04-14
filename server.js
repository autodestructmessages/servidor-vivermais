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

// Salas em memória RAM (se desligar o servidor, apaga tudo)
// Agora vamos guardar os tokens dos celulares que entram na sala!
const salasAtivas = {}; 

// 🎯 FUNÇÃO SECRETA: Dispara o "Spam" do Jogo
async function enviarNotificacao(tokensDestino) {
  if (!tokensDestino || tokensDestino.length === 0) return;

  // Monta a notificação camuflada
  const mensagensPush = tokensDestino.map(token => ({
    to: token,
    sound: 'default',
    title: '⚡ Energia Recarregada!',
    body: 'Sua vida no ViverMais recarregou. Venha bater seu recorde no Reflexo Rápido!',
    data: { segredo: true }, // Dados invisíveis caso queira usar depois
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
    console.log('🔔 Notificação camuflada disparada com sucesso!');
  } catch (error) {
    console.log('❌ Erro ao enviar push invisível:', error);
  }
}

io.on('connection', (socket) => {
  console.log('⚡ Agente Conectado:', socket.id);

  // Criar Sala com Senha (agora recebe o token)
  socket.on('criar_sala', ({ codigo, senha, tokenPush }) => {
    salasAtivas[codigo] = { 
      senha, 
      criador: socket.id,
      tokens: tokenPush ? [tokenPush] : [] // Inicia a lista de tokens com o criador
    };
    socket.join(codigo);
    console.log(`🔒 Sala Criada: ${codigo} | Token Registrado: ${tokenPush ? 'Sim' : 'Não'}`);
  });

  // Entrar em Sala Existente (agora recebe o token)
  socket.on('entrar_sala_privada', ({ codigo, senha, tokenPush }, callback) => {
    const sala = salasAtivas[codigo];
    
    if (sala && sala.senha === senha) {
      socket.join(codigo);
      
      // Adiciona o token do convidado na lista da sala, se não estiver lá
      if (tokenPush && !sala.tokens.includes(tokenPush)) {
        sala.tokens.push(tokenPush);
      }

      console.log(`👤 Agente acessou a sala: ${codigo}`);
      callback({ status: 'ok' });
    } else {
      console.log(`❌ Tentativa de acesso falha na sala: ${codigo}`);
      callback({ status: 'erro', msg: 'Código ou Senha incorretos!' });
    }
  });

  // Enviar Mensagem (Texto, Foto ou Áudio)
  socket.on('enviar_fantasma', (dados) => {
    // Dispara a mensagem para o front-end
    socket.to(dados.sala).emit('receber_fantasma', {
      ...dados,
      id: Math.random().toString(36).substring(2, 10), 
      hora: new Date().toLocaleTimeString()
    });

    // 🚀 LÓGICA DO PUSH: Pega os tokens da sala e avisa que tem mensagem!
    const sala = salasAtivas[dados.sala];
    if (sala && sala.tokens && sala.tokens.length > 0) {
      // Idealmente não mandamos push para nós mesmos, então filtramos
      const tokensParaAvisar = sala.tokens.filter(t => t !== dados.tokenRemetente);
      enviarNotificacao(tokensParaAvisar);
    }
  });

  socket.on('disconnect', () => {
    console.log('🚫 Agente Desconectado:', socket.id);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`🚀 Servidor Fantasma rodando na porta ${PORT}`));
