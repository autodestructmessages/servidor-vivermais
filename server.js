const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, { 
  cors: { origin: "*" },
  maxHttpBufferSize: 1e7 
});

const salasAtivas = {}; 

io.on('connection', (socket) => {
  console.log('⚡ Agente Conectado:', socket.id);

  socket.on('criar_sala', ({ codigo, senha }) => {
    salasAtivas[codigo] = { senha, criador: socket.id };
    socket.join(codigo);
    console.log(`🔒 Sala Criada: ${codigo} com senha: ${senha}`);
  });

  socket.on('entrar_sala_privada', ({ codigo, senha }, callback) => {
    const sala = salasAtivas[codigo];
    if (sala && sala.senha === senha) {
      socket.join(codigo);
      callback({ status: 'ok' });
    } else {
      callback({ status: 'erro', msg: 'Código ou Senha incorretos!' });
    }
  });

  socket.on('enviar_fantasma', (dados) => {
    socket.to(dados.sala).emit('receber_fantasma', {
      ...dados,
      id: Math.random().toString(36).substring(2, 10),
      hora: new Date().toLocaleTimeString()
    });
  });

  socket.on('disconnect', () => {
    console.log('🚫 Agente Desconectado:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Servidor Fantasma rodando na porta ${PORT}`));
