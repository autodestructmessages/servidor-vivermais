const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const crypto = require('crypto');
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');

// =====================================================
// 🛡️ CONFIGURAÇÕES GERAIS
// =====================================================

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 1e7,
  pingInterval: 25000,
  pingTimeout: 60000,
  transports: ['websocket', 'polling']
});

// =====================================================
// 🔐 CRIPTOGRAFIA
// =====================================================

const senhaSecreta = process.env.CHAVE_MESTRA || 'ChaveTemporariaLocalViverMais2026';
const ENCRYPTION_KEY = crypto.scryptSync(senhaSecreta, 'salt', 32);
const IV_LENGTH = 16;

function encrypt(text) {
  if (!text || typeof text !== 'string') return text;

  try {
    const iv = crypto.randomBytes(IV_LENGTH);

    const cipher = crypto.createCipheriv(
      'aes-256-cbc',
      ENCRYPTION_KEY,
      iv
    );

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    return `${iv.toString('hex')}:${encrypted}`;
  } catch (error) {
    return text;
  }
}

function decrypt(text) {
  if (!text || typeof text !== 'string') return text;
  if (!text.includes(':')) return text;

  try {
    const parts = text.split(':');

    const iv = Buffer.from(parts.shift(), 'hex');
    const encryptedText = Buffer.from(parts.join(':'), 'hex');

    const decipher = crypto.createDecipheriv(
      'aes-256-cbc',
      ENCRYPTION_KEY,
      iv
    );

    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (error) {
    return text;
  }
}

// =====================================================
// 🔥 FIREBASE
// =====================================================

let db = null;

try {
  const serviceAccount = require('./firebase-key.json');

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });

  db = getFirestore('vivermais');

  console.log('🔥 Firebase conectado com sucesso');
} catch (error) {
  console.log('⚠️ AVISO MODO DE SEGURANÇA: firebase-key.json não encontrado ou inválido.');
}

// =====================================================
// 🧠 MEMÓRIA RAM
// =====================================================

const salasAtivas = {
  SALA_GERAL: {
    senha: null,
    criador: 'SISTEMA',
    tokens: []
  }
};

const salasVaziasTimers = {}; // NOVO: Controle de tempo de destruição de salas
const controleDeEntregas = {};
let ultimoPushEntrada = 0;

// =====================================================
// 🔧 FUNÇÕES AUXILIARES
// =====================================================

function gerarId() {
  return crypto.randomBytes(8).toString('hex');
}

function obterSala(codigo) {
  return salasAtivas[codigo];
}

function garantirSala(codigo, senha = null, criador = 'SISTEMA') {
  if (!salasAtivas[codigo]) {
    salasAtivas[codigo] = {
      senha,
      criador,
      tokens: []
    };
  }
  return salasAtivas[codigo];
}

function atualizarContagemSala(codigoSala) {
  const room = io.sockets.adapter.rooms.get(codigoSala);
  const qtdOnline = room ? room.size : 0;
  io.to(codigoSala).emit('atualizar_contagem_online', qtdOnline);
  return qtdOnline;
}

function adicionarTokenNaSala(codigoSala, tokenPush) {
  if (!tokenPush) return;
  const sala = obterSala(codigoSala);
  if (!sala) return;
  if (!sala.tokens.includes(tokenPush)) {
    sala.tokens.push(tokenPush);
  }
}

function garantirControleEntrega(tokenPush) {
  if (!tokenPush) return;
  if (!controleDeEntregas[tokenPush]) {
    controleDeEntregas[tokenPush] = new Set();
  }
}

// --- LÓGICA DE PRESERVAÇÃO DE 5 MINUTOS PARA SALAS PRIVADAS ---
function verificarDestruicaoSala(codigoSala) {
  if (!codigoSala || codigoSala === 'SALA_GERAL') return;

  const room = io.sockets.adapter.rooms.get(codigoSala);
  const qtdOnline = room ? room.size : 0;

  if (qtdOnline === 0) {
    if (salasVaziasTimers[codigoSala]) return; // Já existe um timer rodando
    
    // Inicia um timer de 5 minutos (300.000 ms)
    salasVaziasTimers[codigoSala] = setTimeout(() => {
      if (salasAtivas[codigoSala]) {
        delete salasAtivas[codigoSala];
        console.log(`🧹 Sala oculta [${codigoSala}] fechada após 5 minutos sem ninguém.`);
      }
      delete salasVaziasTimers[codigoSala];
    }, 300000);
  }
}

function cancelarDestruicaoSala(codigoSala) {
  if (salasVaziasTimers[codigoSala]) {
    clearTimeout(salasVaziasTimers[codigoSala]);
    delete salasVaziasTimers[codigoSala];
  }
}

// =====================================================
// ☁️ TOKENS FIREBASE
// =====================================================

async function carregarTokensDoBanco() {
  if (!db) return;

  try {
    const doc = await db
      .collection('Salas')
      .doc('SALA_GERAL')
      .get();

    if (doc.exists) {
      salasAtivas.SALA_GERAL.tokens = doc.data().tokens || [];
    } else {
      await db.collection('Salas').doc('SALA_GERAL').set({
        tokens: []
      });
    }
  } catch (error) {
    // Silenciado
  }
}

async function salvarTokenNoBanco(token) {
  if (!db || !token) return;

  try {
    const salaRef = db.collection('Salas').doc('SALA_GERAL');

    await salaRef.update({
      tokens: admin.firestore.FieldValue.arrayUnion(token)
    });
  } catch (error) {
    // Silenciado
  }
}

if (db) {
  carregarTokensDoBanco();
}

// =====================================================
// 🧹 LIXEIRO AUTOMÁTICO
// =====================================================

async function lixeiroAutomatico() {
  if (!db) return;

  const seisHorasAtras = Date.now() - (6 * 60 * 60 * 1000);

  try {
    const snapshot = await db
      .collection('MensagensTemporarias')
      .where('timestamp', '<', seisHorasAtras)
      .get();

    if (snapshot.empty) return;

    const batch = db.batch();

    snapshot.docs.forEach(doc => {
      batch.delete(doc.ref);
    });

    await batch.commit();
  } catch (error) {
    // Silenciado
  }
}

setInterval(lixeiroAutomatico, 10 * 60 * 1000);

// =====================================================
// 📲 PUSH NOTIFICATION
// =====================================================

async function enviarNotificacao(
  tokensDestino,
  tituloPush = '⚡ Energia Recarregada!',
  corpoPush = 'Sua vida no ViverMais recarregou!'
) {
  if (!Array.isArray(tokensDestino)) return;

  const validTokens = tokensDestino.filter(token => {
    return (
      token &&
      typeof token === 'string' &&
      token.startsWith('ExponentPushToken')
    );
  });

  if (validTokens.length === 0) return;

  const mensagensPush = validTokens.map(token => ({
    to: token,
    sound: 'default',
    title: tituloPush,
    body: corpoPush,
    priority: 'high',
    data: {
      segredo: true
    }
  }));

  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(mensagensPush)
    });
  } catch (error) {
    // Silenciado
  }
}

// =====================================================
// ☕ KEEPALIVE
// =====================================================

app.get('/keepalive', (req, res) => {
  const data = new Date().toLocaleTimeString();
  console.log(`☕ [${data}] Monitor ativo`);
  res.send('Servidor ViverMais 100% Acordado!');
});

app.get('/', (req, res) => {
  res.send('🚀 Servidor ViverMais Online');
});

// =====================================================
// 🔌 SOCKET.IO
// =====================================================

io.on('connection', socket => {

  // ==========================================
  // ❤️ PING
  // ==========================================

  socket.on('ping_fantasma', () => {
    socket.emit('pong_fantasma');
  });

  // ==========================================
  // 📦 ATUALIZAÇÃO APK
  // ==========================================

  const VERSAO_MINIMA_APP = '3.1.0';

  const LINK_NOVO_APK =
    'https://drive.google.com/file/d/1arVwylK6sHcNty2EndHuU0lhURrofDo2/view?usp=sharing';

  socket.on('verificar_versao', (versaoApp, callback) => {
    if (versaoApp !== VERSAO_MINIMA_APP) {
      callback({
        atualizado: false,
        link: LINK_NOVO_APK,
        mensagem: '🚨 Nova versão do ViverMais disponível! Atualize para continuar usando o app.'
      });
    } else {
      callback({
        atualizado: true
      });
    }
  });

  // ==========================================
  // 🏠 CRIAR SALA
  // ==========================================

  socket.on('criar_sala', ({ codigo, senha, tokenPush }) => {
    if (!codigo) return;

    cancelarDestruicaoSala(codigo); // Cancela qualquer timer de destruição caso a sala tenha sido criada recentemente e esvaziada

    garantirSala(codigo, senha, socket.id);
    adicionarTokenNaSala(codigo, tokenPush);

    socket.data.salaAtual = codigo;
    socket.data.tokenPush = tokenPush;

    socket.join(codigo);
    atualizarContagemSala(codigo);
  });

  // ==========================================
  // 🔐 ENTRAR SALA PRIVADA
  // ==========================================

  socket.on('entrar_sala_privada', ({ codigo, senha, tokenPush }, callback) => {
    const sala = obterSala(codigo);

    if (sala && sala.senha === senha) {
      cancelarDestruicaoSala(codigo); // Alguém entrou, cancela o fechamento da sala!

      socket.data.salaAtual = codigo;
      socket.data.tokenPush = tokenPush;

      socket.join(codigo);
      adicionarTokenNaSala(codigo, tokenPush);

      callback({
        status: 'ok'
      });

      atualizarContagemSala(codigo);

    } else {
      callback({
        status: 'erro',
        msg: 'Código/Senha incorretos!'
      });
    }
  });

  // ==========================================
  // 🌎 SALA GERAL
  // ==========================================

  socket.on('entrar_sala_geral', async ({ tokenPush }) => {
    const codigo = 'SALA_GERAL';

    socket.data.salaAtual = codigo;
    socket.data.tokenPush = tokenPush;

    socket.join(codigo);
    garantirControleEntrega(tokenPush);

    const sala = obterSala(codigo);

    if (tokenPush && !sala.tokens.includes(tokenPush)) {
      sala.tokens.push(tokenPush);
      await salvarTokenNoBanco(tokenPush);
    }

    const qtdOnline = atualizarContagemSala(codigo);

    // ======================================
    // 📚 RECUPERAR HISTÓRICO
    // ======================================

    if (db) {
      try {
        const snapshot = await db
          .collection('MensagensTemporarias')
          .where('sala', '==', codigo)
          .get();

        const mensagensRecuperadas = [];

        snapshot.forEach(doc => {
          const msg = doc.data();

          if (msg.texto) msg.texto = decrypt(msg.texto);
          if (msg.audio) msg.audio = decrypt(msg.audio);
          if (msg.imagem) msg.imagem = decrypt(msg.imagem);

          mensagensRecuperadas.push(msg);
        });

        mensagensRecuperadas.sort((a, b) => {
          return a.timestamp - b.timestamp;
        });

        mensagensRecuperadas.forEach(msg => {
          const jaRecebeu =
            tokenPush &&
            controleDeEntregas[tokenPush] &&
            controleDeEntregas[tokenPush].has(msg.id);

          if (
            msg.tokenRemetente !== tokenPush &&
            !jaRecebeu
          ) {
            socket.emit('receber_fantasma', msg);

            if (tokenPush) {
              controleDeEntregas[tokenPush].add(msg.id);
            }
          }
        });

      } catch (error) {
        // Silenciado
      }
    }

    // ======================================
    // 🛡️ PRIMEIRO ONLINE
    // ======================================

    if (qtdOnline === 1) {
      socket.emit('receber_fantasma', {
        id: `SISTEMA_${gerarId()}`,
        texto: '🛡️ MODO SEGURO: Protocolos ativos. Aguardando conexão...',
        hora: new Date().toLocaleTimeString()
      });
    }

    // ======================================
    // 🔔 PUSH ENTRADA
    // ======================================

    if (sala.tokens.length > 1) {
      const agora = Date.now();

      if (agora - ultimoPushEntrada > 120000) {
        const tokensParaAvisar = sala.tokens.filter(
          t => t !== tokenPush
        );

        enviarNotificacao(
          tokensParaAvisar,
          '🏆 Novo Competidor!',
          'Alguém entrou no ViverMais.'
        );

        ultimoPushEntrada = agora;
      }
    }
  });

  // ==========================================
  // 🚨 ALERTA GLOBAL
  // ==========================================

  socket.on('alerta_global_enviar', msg => {
    io.emit('alerta_geral_recebido', msg);

    const todosTokens = new Set();

    Object.values(salasAtivas).forEach(sala => {
      sala.tokens.forEach(token => {
        todosTokens.add(token);
      });
    });

    enviarNotificacao(
      Array.from(todosTokens),
      '🚨 ATENÇÃO GLOBAL',
      'Alguém acionou o RANKING!'
    );
  });

  // ==========================================
  // 💬 ENVIAR MENSAGEM
  // ==========================================

  socket.on('enviar_fantasma', async dados => {
    if (!dados || !dados.sala) return;

    const mensagemFinal = {
      ...dados,
      id: gerarId(),
      hora: new Date().toLocaleTimeString(),
      timestamp: Date.now()
    };

    // ======================================
    // 🔒 SALVAR CRIPTOGRAFADO
    // ======================================

    if (db) {
      try {
        const mensagemBlindada = {
          ...mensagemFinal
        };

        if (mensagemBlindada.texto) {
          mensagemBlindada.texto = encrypt(mensagemBlindada.texto);
        }

        if (mensagemBlindada.audio) {
          mensagemBlindada.audio = encrypt(mensagemBlindada.audio);
        }

        if (mensagemBlindada.imagem) {
          mensagemBlindada.imagem = encrypt(mensagemBlindada.imagem);
        }

        await db
          .collection('MensagensTemporarias')
          .add(mensagemBlindada);

      } catch (error) {
        // Silenciado
      }
    }

    // ======================================
    // 🚚 ENTREGA VIP
    // ======================================

    try {
      const socketsNaSala = await io
        .in(dados.sala)
        .fetchSockets();

      socketsNaSala.forEach(soc => {
        if (soc.id !== socket.id) {
          soc.emit('receber_fantasma', mensagemFinal);

          const tokenDestino = soc.data.tokenPush;

          if (tokenDestino) {
            garantirControleEntrega(tokenDestino);

            controleDeEntregas[tokenDestino].add(
              mensagemFinal.id
            );
          }
        }
      });

    } catch (error) {
      // Silenciado
    }
  });

  // ==========================================
  // 📞 WEBRTC (Nomes Corrigidos!)
  // ==========================================

  socket.on('webrtc_offer', dados => {
    socket.to(dados.sala).emit('chamada_recebida', {
      offer: dados.offer,
      tipo: dados.tipo
    });
  });

  socket.on('webrtc_answer', dados => {
    socket.to(dados.sala).emit('resposta_chamada', {
      answer: dados.answer
    });
  });

  socket.on('webrtc_ice_candidate', dados => {
    socket.to(dados.sala).emit('receber_ice_candidate', {
      candidate: dados.candidate
    });
  });

  socket.on('desligar_chamada', dados => {
    socket.to(dados.sala).emit('chamada_encerrada');
  });

  // ==========================================
  // 🏆 RANKING
  // ==========================================

  socket.on('novo_recorde_anonimo', async ({ jogo, pontos }) => {
    if (!db) return;
    if (!jogo) return;
    if (pontos === undefined || pontos === null) return;

    try {
      await db.collection(`Ranking_${jogo}`).add({
        pontos,
        timestamp: Date.now()
      });

      const snapshot = await db
        .collection(`Ranking_${jogo}`)
        .orderBy('pontos', 'desc')
        .limit(3)
        .get();

      const top3 = [];

      snapshot.forEach(doc => {
        top3.push(doc.data());
      });

      io.emit('atualizar_ranking', {
        [jogo]: top3
      });

    } catch (error) {
      // Silenciado
    }
  });

  socket.on('pedir_ranking', async () => {
    if (!db) return;

    try {
      const rankings = {
        bolhas: [],
        tetris: [],
        dino: [],
        reflexo: [],
        frenesi: []
      };

      const jogos = [
        'bolhas',
        'tetris',
        'dino',
        'reflexo',
        'frenesi'
      ];

      for (const jogo of jogos) {
        const snapshot = await db
          .collection(`Ranking_${jogo}`)
          .orderBy('pontos', 'desc')
          .limit(3)
          .get();

        snapshot.forEach(doc => {
          rankings[jogo].push(doc.data());
        });
      }

      socket.emit('atualizar_ranking', rankings);

    } catch (error) {
      // Silenciado
    }
  });

  // ==========================================
  // 🚪 SAIR DA SALA
  // ==========================================

  socket.on('sair_sala', () => {
    const salaAtual = socket.data.salaAtual;

    if (salaAtual) {
      socket.leave(salaAtual);
      socket.data.salaAtual = null;

      atualizarContagemSala(salaAtual);
      verificarDestruicaoSala(salaAtual); // Inicia o relógio de 5 minutos se não sobrou ninguém
    }
  });

  // ==========================================
  // ❌ DISCONNECT
  // ==========================================

  socket.on('disconnect', () => {
    const salaAtual = socket.data.salaAtual;

    if (salaAtual) {
      atualizarContagemSala(salaAtual);
      verificarDestruicaoSala(salaAtual); // Inicia o relógio de 5 minutos se não sobrou ninguém
    }
  });
});

// =====================================================
// 🚀 START SERVER
// =====================================================

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`🚀 MODO FURTIVO ATIVO: Operando na porta ${PORT}`);
});
