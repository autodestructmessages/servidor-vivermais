// VIVERMAIS V4.3 — SERVIDOR DE CHAT, RANKING E SINALIZAÇÃO WEBRTC DIRECIONADA
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
// 📡 CONFIGURAÇÃO STUN/TURN PARA CHAMADAS ENTRE REDES
// =====================================================

// Preferencialmente configure estas variáveis no Render:
// TURN_URLS=turn:host:3478?transport=udp,turn:host:3478?transport=tcp,turns:host:5349?transport=tcp
// TURN_USERNAME=usuario_temporario_ou_rotativo
// TURN_CREDENTIAL=senha_temporaria_ou_rotativa
//
// As URLs públicas podem permanecer no código, mas usuário e senha são lidos
// exclusivamente do ambiente do Render para evitar vazamento de credenciais.
const TURN_URLS = (
  process.env.TURN_URLS ||
  [
    'turn:global.relay.metered.ca:80?transport=udp',
    'turn:global.relay.metered.ca:80?transport=tcp',
    'turn:global.relay.metered.ca:443?transport=udp',
    'turn:global.relay.metered.ca:443?transport=tcp',
    'turns:global.relay.metered.ca:443?transport=tcp'
  ].join(',')
)
  .split(',')
  .map(item => item.trim())
  .filter(Boolean);

const TURN_USERNAME = process.env.TURN_USERNAME || '';

const TURN_CREDENTIAL = process.env.TURN_CREDENTIAL || '';

if (TURN_USERNAME && TURN_CREDENTIAL) {
  console.log(`[WEBRTC] TURN carregado do ambiente com ${TURN_URLS.length} rota(s), sem expor credenciais.`);
} else {
  console.log('[WEBRTC] AVISO: TURN_USERNAME ou TURN_CREDENTIAL ausente; chamadas entre redes poderão depender apenas de STUN.');
}

function montarConfiguracaoICE() {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' }
  ];

  if (
    TURN_URLS.length > 0 &&
    TURN_USERNAME &&
    TURN_CREDENTIAL
  ) {
    iceServers.push({
      urls: TURN_URLS,
      username: TURN_USERNAME,
      credential: TURN_CREDENTIAL
    });
  }

  return {
    iceServers,
    iceCandidatePoolSize: 10
  };
}

// =====================================================
// 🔐 CRIPTOGRAFIA NO SERVIDOR
// =====================================================

// A chave deve ser definida no painel do Render por CHAVE_MESTRA.
// O fallback mantém compatibilidade com o ambiente atual, mas deve ser trocado em produção.
const senhaSecreta =
  process.env.CHAVE_MESTRA ||
  'ChaveTemporariaLocalViverMais2026';

// Mantemos o mesmo salt da versão atual para que mensagens já armazenadas
// durante as últimas 48 horas continuem descriptografáveis após a atualização.
const ENCRYPTION_KEY = crypto.scryptSync(
  senhaSecreta,
  'salt',
  32
);

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
    console.log('[CRIPTOGRAFIA] Falha ao criptografar:', error);
    throw error;
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

    let decrypted = decipher.update(
      encryptedText,
      'hex',
      'utf8'
    );

    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    console.log('[CRIPTOGRAFIA] Falha ao descriptografar conteúdo antigo:', error.message);
    return text;
  }
}

// Fotos do app podem chegar como objeto { base64, legenda, mimeType }.
// Para armazenar tudo criptografado sem quebrar mensagens antigas, o servidor
// serializa objetos em JSON e registra o formato usado.
function protegerConteudoParaBanco(conteudo) {
  if (conteudo === undefined || conteudo === null) {
    return {
      conteudoProtegido: conteudo,
      conteudoFormato: 'nulo'
    };
  }

  if (typeof conteudo === 'string') {
    return {
      conteudoProtegido: encrypt(conteudo),
      conteudoFormato: 'string'
    };
  }

  return {
    conteudoProtegido: encrypt(JSON.stringify(conteudo)),
    conteudoFormato: 'json'
  };
}

function restaurarConteudoDoBanco(mensagem) {
  if (!mensagem || mensagem.conteudo === undefined) {
    return mensagem;
  }

  const copia = { ...mensagem };

  if (
    copia.conteudoFormato === 'json' &&
    typeof copia.conteudo === 'string'
  ) {
    try {
      copia.conteudo = JSON.parse(decrypt(copia.conteudo));
      return copia;
    } catch (error) {
      console.log('[CRIPTOGRAFIA] JSON de mídia inválido:', error.message);
      return copia;
    }
  }

  if (
    copia.conteudoFormato === 'string' &&
    typeof copia.conteudo === 'string'
  ) {
    copia.conteudo = decrypt(copia.conteudo);
    return copia;
  }

  // Compatibilidade com documentos antigos, que não tinham conteudoFormato.
  if (typeof copia.conteudo === 'string') {
    copia.conteudo = decrypt(copia.conteudo);
  }

  return copia;
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

const salasVaziasTimers = {};
const controleDeEntregas = {};
const mensagensProcessadas = new Map();
const chamadasAtivas = new Map();

// Lista fechada de modalidades aceitas no ranking. A validação impede que um
// cliente alterado crie coleções arbitrárias no Firestore.
const JOGOS_RANKING = Object.freeze([
  'bolhas',
  'reflexo',
  'frenesi',
  'dino',
  'tetris',
  'cobrinha',
  'quebra_blocos',
  'memoria',
  'torre',
  'meteoros'
]);

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

function obterChavePresencaSocket(socketId) {
  const socketSala = io.sockets.sockets.get(socketId);
  const deviceId = socketSala?.data?.deviceId;

  return deviceId
    ? `device:${deviceId}`
    : `socket:${socketId}`;
}

function contarDispositivosUnicosNaSala(codigoSala) {
  const room = io.sockets.adapter.rooms.get(codigoSala);
  if (!room) return 0;

  const dispositivos = new Set();

  room.forEach(socketId => {
    dispositivos.add(
      obterChavePresencaSocket(socketId)
    );
  });

  return dispositivos.size;
}

function atualizarContagemSala(codigoSala) {
  const qtdOnline =
    contarDispositivosUnicosNaSala(codigoSala);

  io.to(codigoSala).emit(
    'atualizar_contagem_online',
    qtdOnline
  );

  console.log(
    `[PRESENÇA] Sala ${codigoSala}: ${qtdOnline} dispositivo(s) único(s).`
  );

  return qtdOnline;
}

// Quando o aparelho troca Wi-Fi por dados móveis, o Socket.IO cria uma nova
// conexão antes de a antiga expirar. Esta função remove imediatamente a conexão
// antiga do mesmo deviceId para impedir contagem duplicada e mistura no WebRTC.
async function substituirConexaoAnteriorDoDispositivo(
  socketAtual,
  codigoSala,
  deviceId
) {
  if (!socketAtual || !codigoSala || !deviceId) {
    return;
  }

  const socketsNaSala = await io
    .in(codigoSala)
    .fetchSockets();

  const duplicadas = socketsNaSala.filter(item =>
    item.id !== socketAtual.id &&
    item.data?.deviceId === deviceId
  );

  for (const socketAntigo of duplicadas) {
    try {
      console.log(
        `[PRESENÇA] Substituindo socket antigo ${socketAntigo.id} pelo novo ${socketAtual.id} do dispositivo ${deviceId}.`
      );

      socketAntigo.emit('sessao_substituida', {
        motivo: 'O mesmo dispositivo reconectou por outra rede.'
      });

      socketAntigo.data.salaAtual = null;
      await socketAntigo.leave(codigoSala);
      socketAntigo.disconnect(true);
    } catch (erro) {
      console.log(
        `[PRESENÇA] Falha ao remover socket duplicado ${socketAntigo.id}:`,
        erro
      );
    }
  }
}

function adicionarTokenNaSala(codigoSala, tokenPush) {
  if (!tokenPush) return;
  const sala = obterSala(codigoSala);
  if (!sala) return;
  if (!sala.tokens.includes(tokenPush)) {
    sala.tokens.push(tokenPush);
  }
}

function garantirControleEntrega(chaveIdentificacao) {
  if (!chaveIdentificacao) return;
  if (!controleDeEntregas[chaveIdentificacao]) {
    controleDeEntregas[chaveIdentificacao] = new Set();
  }
}

function verificarDestruicaoSala(codigoSala) {
  if (!codigoSala || codigoSala === 'SALA_GERAL') return;

  const qtdOnline =
    contarDispositivosUnicosNaSala(codigoSala);

  // Atualizado para 48 HORAS (172800000 ms) para acompanhar a retenção de mensagens
  if (qtdOnline === 0) {
    if (salasVaziasTimers[codigoSala]) return; 
    
    salasVaziasTimers[codigoSala] = setTimeout(() => {
      if (salasAtivas[codigoSala]) {
        delete salasAtivas[codigoSala];
        console.log(`🧹 Sala oculta [${codigoSala}] fechada após 48 horas sem ninguém.`);
      }
      delete salasVaziasTimers[codigoSala];
    }, 172800000); // 48 horas
  }
}

function cancelarDestruicaoSala(codigoSala) {
  if (salasVaziasTimers[codigoSala]) {
    clearTimeout(salasVaziasTimers[codigoSala]);
    delete salasVaziasTimers[codigoSala];
  }
}


function normalizarCodigoSala(codigo) {
  if (typeof codigo !== 'string') return '';
  return codigo.trim().replace(/\s+/g, '').toUpperCase().slice(0, 30);
}

function idMensagemValido(id) {
  return (
    typeof id === 'string' &&
    id.length >= 8 &&
    id.length <= 160 &&
    /^[A-Za-z0-9_.:-]+$/.test(id)
  );
}

function socketEstaNaSala(socket, codigoSala) {
  return Boolean(
    socket &&
    codigoSala &&
    socket.rooms &&
    socket.rooms.has(codigoSala)
  );
}

function chaveMensagemProcessada(codigoSala, id) {
  return `${codigoSala}:${id}`;
}

function registrarMensagemProcessada(codigoSala, id, metadados = {}) {
  mensagensProcessadas.set(
    chaveMensagemProcessada(codigoSala, id),
    {
      timestampRegistro: Date.now(),
      ...metadados
    }
  );
}

function obterMensagemProcessada(codigoSala, id) {
  return mensagensProcessadas.get(
    chaveMensagemProcessada(codigoSala, id)
  );
}

function obterChaveDispositivo(deviceId, tokenPush) {
  return deviceId || tokenPush || null;
}

async function mensagemJaExisteNoBanco(codigoSala, id) {
  if (!db) return null;

  try {
    const snapshot = await db
      .collection('MensagensTemporarias')
      .where('id', '==', id)
      .get();

    const documento = snapshot.docs.find(doc => {
      const dados = doc.data();
      return dados.sala === codigoSala;
    });

    if (!documento) return null;

    return restaurarConteudoDoBanco(documento.data());
  } catch (error) {
    console.log(
      `[DEDUPLICAÇÃO] Falha ao procurar ${id} no banco:`,
      error
    );
    return null;
  }
}

async function entregarHistoricoDaSala(
  socket,
  codigoSala,
  tokenPush,
  deviceId
) {
  if (!db || !codigoSala) return 0;

  const chaveIdentificacao = obterChaveDispositivo(
    deviceId,
    tokenPush
  );

  garantirControleEntrega(chaveIdentificacao);

  try {
    const snapshot = await db
      .collection('MensagensTemporarias')
      .where('sala', '==', codigoSala)
      .get();

    const mensagensRecuperadas = [];

    snapshot.forEach(doc => {
      mensagensRecuperadas.push(
        restaurarConteudoDoBanco(doc.data())
      );
    });

    mensagensRecuperadas.sort(
      (a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0)
    );

    let entregues = 0;

    for (const msg of mensagensRecuperadas) {
      if (!msg?.id) continue;

      const jaRecebeu =
        chaveIdentificacao &&
        controleDeEntregas[chaveIdentificacao]?.has(msg.id);

      const ehPropria =
        (msg.deviceId && msg.deviceId === deviceId) ||
        (
          msg.tokenRemetente &&
          tokenPush &&
          msg.tokenRemetente === tokenPush
        );

      if (ehPropria || jaRecebeu) continue;

      const {
        tokenRemetente,
        deviceId: deviceIdRemetente,
        ...mensagemPublica
      } = msg;

      socket.emit(
        'receber_fantasma',
        mensagemPublica
      );

      // O ID só entra no controle de entregas após o aplicativo responder
      // confirmar_entrega. Se a conexão cair antes disso, o histórico será reenviado.
      entregues += 1;
    }

    console.log(
      `[HISTÓRICO] ${entregues} mensagem(ns) entregue(s) para socket ${socket.id} na sala ${codigoSala}.`
    );

    return entregues;
  } catch (error) {
    console.log(
      `[HISTÓRICO] Falha ao recuperar sala ${codigoSala}:`,
      error
    );
    return 0;
  }
}

// Limpa somente índices auxiliares em RAM. As mensagens do Firestore continuam
// obedecendo rigorosamente à retenção de 48 horas já configurada.
setInterval(() => {
  const limite = Date.now() - (72 * 60 * 60 * 1000);

  for (const [chave, dados] of mensagensProcessadas.entries()) {
    if (Number(dados?.timestampRegistro || 0) < limite) {
      mensagensProcessadas.delete(chave);
    }
  }

  for (const [callId, chamada] of chamadasAtivas.entries()) {
    if (Number(chamada?.criadaEm || 0) < Date.now() - (2 * 60 * 60 * 1000)) {
      chamadasAtivas.delete(callId);
    }
  }
}, 10 * 60 * 1000);

// =====================================================
// ☁️ TOKENS FIREBASE
// =====================================================

async function carregarTokensDoBanco() {
  if (!db) return;
  try {
    const doc = await db.collection('Salas').doc('SALA_GERAL').get();
    if (doc.exists) {
      salasAtivas.SALA_GERAL.tokens = doc.data().tokens || [];
    } else {
      await db.collection('Salas').doc('SALA_GERAL').set({ tokens: [] });
    }
  } catch (error) {}
}

async function salvarTokenNoBanco(token) {
  if (!db || !token) return;
  try {
    const salaRef = db.collection('Salas').doc('SALA_GERAL');
    await salaRef.update({
      tokens: admin.firestore.FieldValue.arrayUnion(token)
    });
  } catch (error) {}
}

if (db) {
  carregarTokensDoBanco();
}

// =====================================================
// 🧹 LIXEIRO AUTOMÁTICO (Mantém 48h rigorosamente)
// =====================================================

async function lixeiroAutomatico() {
  if (!db) return;

  // AUMENTADO PARA 48 HORAS
  const tempoRetencao = Date.now() - (48 * 60 * 60 * 1000);

  try {
    const snapshot = await db
      .collection('MensagensTemporarias')
      .where('timestamp', '<', tempoRetencao)
      .get();

    if (snapshot.empty) return;

    const batch = db.batch();
    snapshot.docs.forEach(doc => {
      batch.delete(doc.ref);
    });

    await batch.commit();
  } catch (error) {}
}

// O lixeiro passa a cada 10 minutos para verificar se tem algo velho pra deletar
setInterval(lixeiroAutomatico, 10 * 60 * 1000);

// =====================================================
// 📲 PUSH NOTIFICATION
// =====================================================

async function enviarNotificacao(tokensDestino, tituloPush = '⚡ Energia Recarregada!', corpoPush = 'Sua vida no ViverMais recarregou!') {
  if (!Array.isArray(tokensDestino)) return;

  const validTokens = tokensDestino.filter(token => {
    return (token && typeof token === 'string' && token.startsWith('ExponentPushToken'));
  });

  if (validTokens.length === 0) return;

  const mensagensPush = validTokens.map(token => ({
    to: token,
    sound: 'default',
    title: tituloPush,
    body: corpoPush,
    priority: 'high',
    data: { segredo: true }
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
  } catch (error) {}
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
  socket.data.conectadoEm = Date.now();

  console.log(`[SOCKET] Conexão anônima aberta: ${socket.id}`);

  const responder = (callback, payload) => {
    if (typeof callback === 'function') {
      callback(payload);
    }
  };

  const obterChamadaDoSocket = callId => {
    if (!callId) return null;
    return chamadasAtivas.get(callId) || null;
  };

  const obterOutroParticipante = (chamada, socketIdAtual) => {
    if (!chamada) return null;
    if (chamada.chamador === socketIdAtual) return chamada.receptor;
    if (chamada.receptor === socketIdAtual) return chamada.chamador;
    return null;
  };

  const encerrarChamadasDoSocket = motivo => {
    for (const [callId, chamada] of chamadasAtivas.entries()) {
      if (
        chamada.chamador !== socket.id &&
        chamada.receptor !== socket.id
      ) {
        continue;
      }

      const outroSocketId = obterOutroParticipante(
        chamada,
        socket.id
      );

      if (outroSocketId) {
        io.to(outroSocketId).emit('chamada_encerrada', {
          callId,
          motivo
        });
      }

      chamadasAtivas.delete(callId);
      console.log(`[WEBRTC] Chamada ${callId} removida: ${motivo}`);
    }
  };

  // ❤️ PING
  socket.on('ping_fantasma', () => {
    socket.emit('pong_fantasma');
  });

  // 📦 ATUALIZAÇÃO APK
  const VERSAO_MINIMA_APP = '15.0.0';
  const LINK_NOVO_APK =
    'https://drive.google.com/drive/folders/1GmDMyRgzQBhdVTWmclKZ2V_pjiCtrhRZ?usp=sharing';

  socket.on('verificar_versao', (versaoApp, callback) => {
    if (versaoApp !== VERSAO_MINIMA_APP) {
      responder(callback, {
        atualizado: false,
        link: LINK_NOVO_APK,
        mensagem:
          '🚨 Nova versão do ViverMais disponível! Atualize para continuar usando o app.'
      });
      return;
    }

    responder(callback, { atualizado: true });
  });

  // 📡 CONFIGURAÇÃO ICE
  socket.on('obter_config_ice', callback => {
    const configuracao = montarConfiguracaoICE();

    console.log(
      `[WEBRTC] Configuração ICE fornecida para ${socket.id}: ${configuracao.iceServers.length} grupo(s).`
    );

    responder(callback, configuracao);
  });

  // ✍️ DIGITANDO
  socket.on('digitando', dados => {
    if (!dados?.sala) return;

    const codigoSala = normalizarCodigoSala(dados.sala);

    if (!socketEstaNaSala(socket, codigoSala)) {
      console.log(
        `[DIGITANDO] Evento rejeitado: ${socket.id} não pertence à sala ${codigoSala}.`
      );
      return;
    }

    socket.to(codigoSala).emit('alguem_digitando', {
      isTyping: Boolean(dados.isTyping),
      deviceId: socket.data.deviceId || dados.deviceId || null
    });
  });

  // 👀 CONFIRMAÇÃO REAL DE LEITURA
  socket.on('mensagem_lida', async (dados, callback) => {
    if (!dados?.sala || !dados?.id) {
      responder(callback, {
        status: 'erro',
        msg: 'Dados de leitura incompletos.'
      });
      return;
    }

    const codigoSala = normalizarCodigoSala(dados.sala);

    if (!socketEstaNaSala(socket, codigoSala)) {
      responder(callback, {
        status: 'erro',
        msg: 'Socket não pertence à sala informada.'
      });
      return;
    }

    const lidaEm = Date.now();

    socket.to(codigoSala).emit('mensagem_lida', {
      id: dados.id,
      lida: true,
      lidaEm
    });

    if (db) {
      try {
        const snapshot = await db
          .collection('MensagensTemporarias')
          .where('id', '==', dados.id)
          .get();

        const documentosDaSala = snapshot.docs.filter(doc => {
          return doc.data().sala === codigoSala;
        });

        if (documentosDaSala.length > 0) {
          const batch = db.batch();

          documentosDaSala.forEach(doc => {
            batch.update(doc.ref, {
              lida: true,
              lidaEm
            });
          });

          await batch.commit();
        }

        console.log(
          `[LEITURA] Mensagem ${dados.id} marcada como lida na sala ${codigoSala}.`
        );
      } catch (error) {
        console.log(
          '[LEITURA] Erro ao atualizar status no banco:',
          error
        );
      }
    }

    responder(callback, {
      status: 'ok',
      id: dados.id,
      lidaEm
    });
  });

  // Sincroniza confirmações que aconteceram enquanto o remetente estava offline.
  socket.on(
    'sincronizar_status_leitura',
    async (dados, callback) => {
      if (
        !dados?.sala ||
        !Array.isArray(dados.ids)
      ) {
        responder(callback, {
          status: 'erro',
          mensagens: []
        });
        return;
      }

      const codigoSala = normalizarCodigoSala(dados.sala);

      if (!socketEstaNaSala(socket, codigoSala)) {
        responder(callback, {
          status: 'erro',
          mensagens: []
        });
        return;
      }

      const idsSolicitados = new Set(
        dados.ids
          .filter(id => typeof id === 'string')
          .slice(0, 100)
      );

      if (!db || idsSolicitados.size === 0) {
        responder(callback, {
          status: 'ok',
          mensagens: []
        });
        return;
      }

      try {
        const snapshot = await db
          .collection('MensagensTemporarias')
          .where('sala', '==', codigoSala)
          .get();

        const mensagens = [];

        snapshot.forEach(doc => {
          const msg = doc.data();

          if (idsSolicitados.has(msg.id)) {
            mensagens.push({
              id: msg.id,
              lida: Boolean(msg.lida),
              lidaEm: msg.lidaEm || null
            });
          }
        });

        responder(callback, {
          status: 'ok',
          mensagens
        });
      } catch (error) {
        console.log(
          '[LEITURA] Falha na sincronização:',
          error
        );

        responder(callback, {
          status: 'erro',
          mensagens: []
        });
      }
    }
  );

  // 🏠 CRIAR SALA
  socket.on(
    'criar_sala',
    async (
      {
        codigo,
        senha,
        tokenPush,
        deviceId
      } = {},
      callback
    ) => {
      const codigoNormalizado = normalizarCodigoSala(codigo);

      if (!codigoNormalizado || !senha) {
        responder(callback, {
          status: 'erro',
          msg: 'Código e senha são obrigatórios.'
        });
        return;
      }

      if (salasAtivas[codigoNormalizado]) {
        responder(callback, {
          status: 'erro',
          msg: 'Já existe uma sala ativa com esse código.'
        });
        return;
      }

      cancelarDestruicaoSala(codigoNormalizado);
      garantirSala(
        codigoNormalizado,
        senha,
        socket.id
      );

      adicionarTokenNaSala(
        codigoNormalizado,
        tokenPush
      );

      socket.data.salaAtual = codigoNormalizado;
      socket.data.tokenPush = tokenPush || null;
      socket.data.deviceId = deviceId || null;

      await substituirConexaoAnteriorDoDispositivo(
        socket,
        codigoNormalizado,
        deviceId
      );

      await socket.join(codigoNormalizado);
      atualizarContagemSala(codigoNormalizado);

      console.log(
        `[SALA] Sala privada ${codigoNormalizado} criada por socket anônimo.`
      );

      responder(callback, {
        status: 'ok',
        codigo: codigoNormalizado
      });
    }
  );

  // 🔐 ENTRAR SALA PRIVADA
  socket.on(
    'entrar_sala_privada',
    async (
      {
        codigo,
        senha,
        tokenPush,
        deviceId
      } = {},
      callback
    ) => {
      const codigoNormalizado = normalizarCodigoSala(codigo);
      const sala = obterSala(codigoNormalizado);

      if (!sala || sala.senha !== senha) {
        responder(callback, {
          status: 'erro',
          msg: 'Código/Senha incorretos!'
        });
        return;
      }

      cancelarDestruicaoSala(codigoNormalizado);

      socket.data.salaAtual = codigoNormalizado;
      socket.data.tokenPush = tokenPush || null;
      socket.data.deviceId = deviceId || null;

      await substituirConexaoAnteriorDoDispositivo(
        socket,
        codigoNormalizado,
        deviceId
      );

      await socket.join(codigoNormalizado);
      adicionarTokenNaSala(
        codigoNormalizado,
        tokenPush
      );

      atualizarContagemSala(codigoNormalizado);

      responder(callback, {
        status: 'ok',
        codigo: codigoNormalizado
      });

      await entregarHistoricoDaSala(
        socket,
        codigoNormalizado,
        tokenPush,
        deviceId
      );

      console.log(
        `[SALA] Socket ${socket.id} entrou na sala privada ${codigoNormalizado}.`
      );
    }
  );

  // 🌎 SALA GERAL
  socket.on(
    'entrar_sala_geral',
    async (
      {
        tokenPush,
        deviceId
      } = {},
      callback
    ) => {
      const codigo = 'SALA_GERAL';

      socket.data.salaAtual = codigo;
      socket.data.tokenPush = tokenPush || null;
      socket.data.deviceId = deviceId || null;

      await substituirConexaoAnteriorDoDispositivo(
        socket,
        codigo,
        deviceId
      );

      await socket.join(codigo);

      const chaveIdentificacao = obterChaveDispositivo(
        deviceId,
        tokenPush
      );

      garantirControleEntrega(chaveIdentificacao);

      const sala = obterSala(codigo);

      if (
        tokenPush &&
        !sala.tokens.includes(tokenPush)
      ) {
        sala.tokens.push(tokenPush);
        await salvarTokenNoBanco(tokenPush);
      }

      const qtdOnline = atualizarContagemSala(codigo);

      responder(callback, {
        status: 'ok',
        codigo,
        qtdOnline
      });

      await entregarHistoricoDaSala(
        socket,
        codigo,
        tokenPush,
        deviceId
      );

      // A antiga mensagem "MODO SEGURO..." foi removida.
      // A ausência de outra pessoa é indicada somente pela contagem online.

      if (sala.tokens.length > 1) {
        const agora = Date.now();

        if (agora - ultimoPushEntrada > 120000) {
          const tokensParaAvisar = sala.tokens.filter(
            token => token !== tokenPush
          );

          enviarNotificacao(
            tokensParaAvisar,
            '🏆 Novo Competidor!',
            'Alguém entrou no ViverMais.'
          );

          ultimoPushEntrada = agora;
        }
      }

      console.log(
        `[SALA] Socket ${socket.id} entrou na sala geral. Online: ${qtdOnline}.`
      );
    }
  );

  // 🚚 CONFIRMAÇÃO DE ENTREGA AO DISPOSITIVO
  socket.on('confirmar_entrega', dados => {
    if (!dados?.id || !dados?.sala) return;

    const codigoSala = normalizarCodigoSala(dados.sala);

    if (!socketEstaNaSala(socket, codigoSala)) return;

    const chaveDestino = obterChaveDispositivo(
      dados.deviceId || socket.data.deviceId,
      socket.data.tokenPush
    );

    if (!chaveDestino) return;

    garantirControleEntrega(chaveDestino);
    controleDeEntregas[chaveDestino].add(dados.id);

    console.log(
      `[ENTREGA] Dispositivo anônimo confirmou ${dados.id}.`
    );
  });

  // 🚨 ALERTA GLOBAL
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

  // 💬 ENVIAR MENSAGEM COM ID ESTÁVEL, DEDUPLICAÇÃO E ACK
  socket.on(
    'enviar_fantasma',
    async (dados, callback) => {
      if (!dados?.sala) {
        responder(callback, {
          status: 'erro',
          msg: 'Sala ausente.'
        });
        return;
      }

      const codigoSala = normalizarCodigoSala(dados.sala);

      if (!socketEstaNaSala(socket, codigoSala)) {
        responder(callback, {
          status: 'erro',
          msg: 'Reconecte-se à sala antes de enviar.'
        });
        return;
      }

      const idFinal = idMensagemValido(dados.id)
        ? dados.id
        : gerarId();

      let tamanhoConteudo = 0;

      try {
        tamanhoConteudo =
          typeof dados.conteudo === 'string'
            ? dados.conteudo.length
            : JSON.stringify(dados.conteudo || '').length;
      } catch (error) {
        tamanhoConteudo = Number.MAX_SAFE_INTEGER;
      }

      if (
        !dados.conteudo ||
        tamanhoConteudo > 9_000_000
      ) {
        responder(callback, {
          status: 'erro',
          msg: 'Conteúdo vazio ou acima do limite.'
        });
        return;
      }

      const processadaEmMemoria = obterMensagemProcessada(
        codigoSala,
        idFinal
      );

      if (processadaEmMemoria) {
        responder(callback, {
          status: 'ok',
          id: idFinal,
          hora: processadaEmMemoria.hora,
          timestamp: processadaEmMemoria.timestamp,
          duplicada: true
        });

        console.log(
          `[DEDUPLICAÇÃO] Reenvio ${idFinal} reconhecido em RAM.`
        );
        return;
      }

      const existenteNoBanco =
        await mensagemJaExisteNoBanco(
          codigoSala,
          idFinal
        );

      if (existenteNoBanco) {
        registrarMensagemProcessada(
          codigoSala,
          idFinal,
          {
            hora: existenteNoBanco.hora,
            timestamp: existenteNoBanco.timestamp
          }
        );

        responder(callback, {
          status: 'ok',
          id: idFinal,
          hora: existenteNoBanco.hora,
          timestamp: existenteNoBanco.timestamp,
          duplicada: true
        });

        console.log(
          `[DEDUPLICAÇÃO] Reenvio ${idFinal} reconhecido no Firestore.`
        );
        return;
      }

      const timestamp = Date.now();
      const hora = new Date(timestamp)
        .toLocaleTimeString();

      const mensagemFinal = {
        ...dados,
        id: idFinal,
        sala: codigoSala,
        autor: 'Remetente',
        deviceId:
          socket.data.deviceId ||
          dados.deviceId ||
          null,
        tokenRemetente:
          socket.data.tokenPush ||
          dados.tokenRemetente ||
          null,
        pendente: false,
        hora,
        timestamp,
        lida: false,
        lidaEm: null
      };

      if (db) {
        try {
          const mensagemBlindada = {
            ...mensagemFinal
          };

          const {
            conteudoProtegido,
            conteudoFormato
          } = protegerConteudoParaBanco(
            mensagemBlindada.conteudo
          );

          mensagemBlindada.conteudo =
            conteudoProtegido;

          mensagemBlindada.conteudoFormato =
            conteudoFormato;

          await db
            .collection('MensagensTemporarias')
            .add(mensagemBlindada);

          console.log(
            `[BANCO] Mensagem ${idFinal} salva criptografada.`
          );
        } catch (error) {
          console.log(
            `[BANCO] Falha ao salvar ${idFinal}:`,
            error
          );

          responder(callback, {
            status: 'erro',
            msg: 'Falha ao persistir a mensagem.'
          });
          return;
        }
      }

      registrarMensagemProcessada(
        codigoSala,
        idFinal,
        { hora, timestamp }
      );

      const {
        tokenRemetente,
        deviceId,
        ...mensagemPublica
      } = mensagemFinal;

      try {
        const socketsNaSala = await io
          .in(codigoSala)
          .fetchSockets();

        for (const destino of socketsNaSala) {
          if (destino.id === socket.id) continue;

          destino.emit(
            'receber_fantasma',
            mensagemPublica
          );

          // Não marcamos como entregue neste ponto. O destinatário confirma
          // explicitamente pelo evento confirmar_entrega após processar a mensagem.
        }

        console.log(
          `[ENTREGA] Mensagem ${idFinal} distribuída na sala ${codigoSala}.`
        );
      } catch (error) {
        console.log(
          `[ENTREGA] Falha ao distribuir ${idFinal}:`,
          error
        );
      }

      responder(callback, {
        status: 'ok',
        id: idFinal,
        hora,
        timestamp,
        duplicada: false
      });
    }
  );

  // 📞 WEBRTC DIRECIONADO PARA EXATAMENTE DOIS PARTICIPANTES
  socket.on(
    'webrtc_offer',
    async (dados, callback) => {
      if (!dados?.sala || !dados?.offer) {
        responder(callback, {
          status: 'erro',
          msg: 'Oferta inválida.'
        });
        return;
      }

      const codigoSala = normalizarCodigoSala(
        dados.sala
      );

      if (!socketEstaNaSala(socket, codigoSala)) {
        responder(callback, {
          status: 'erro',
          msg: 'Você não pertence à sala.'
        });
        return;
      }

      const socketsNaSala = await io
        .in(codigoSala)
        .fetchSockets();

      const deviceIdOrigem = socket.data.deviceId || null;
      const destinosPorDispositivo = new Map();

      socketsNaSala.forEach(item => {
        if (item.id === socket.id) return;

        // Uma reconexão do próprio aparelho não pode ser tratada como outro
        // participante da chamada.
        if (
          deviceIdOrigem &&
          item.data?.deviceId === deviceIdOrigem
        ) {
          return;
        }

        const chave =
          item.data?.deviceId
            ? `device:${item.data.deviceId}`
            : `socket:${item.id}`;

        const existente = destinosPorDispositivo.get(chave);

        if (
          !existente ||
          Number(item.data?.conectadoEm || 0) >
            Number(existente.data?.conectadoEm || 0)
        ) {
          destinosPorDispositivo.set(chave, item);
        }
      });

      const destinos = [
        ...destinosPorDispositivo.values()
      ];

      if (destinos.length === 0) {
        responder(callback, {
          status: 'erro',
          msg: 'Nenhuma outra pessoa está online.'
        });
        return;
      }

      if (destinos.length > 1) {
        responder(callback, {
          status: 'erro',
          msg:
            'A chamada individual exige exatamente duas pessoas na sala.'
        });
        return;
      }

      const destino = destinos[0];
      const callId = gerarId();

      chamadasAtivas.set(callId, {
        callId,
        sala: codigoSala,
        chamador: socket.id,
        receptor: destino.id,
        tipo:
          dados.tipo === 'video'
            ? 'video'
            : 'audio',
        criadaEm: Date.now()
      });

      socket.data.callId = callId;
      destino.data.callId = callId;

      destino.emit('chamada_recebida', {
        callId,
        origemSocketId: socket.id,
        offer: dados.offer,
        tipo:
          dados.tipo === 'video'
            ? 'video'
            : 'audio'
      });

      responder(callback, {
        status: 'ok',
        callId,
        destinoSocketId: destino.id
      });

      console.log(
        `[WEBRTC] Oferta ${callId}: ${socket.id} -> ${destino.id}.`
      );
    }
  );

  socket.on('webrtc_answer', dados => {
    const chamada = obterChamadaDoSocket(
      dados?.callId
    );

    if (!chamada || !dados?.answer) {
      console.log('[WEBRTC] Resposta ignorada: chamada inexistente.');
      return;
    }

    const destinoCorreto = obterOutroParticipante(
      chamada,
      socket.id
    );

    if (
      !destinoCorreto ||
      (
        dados.destinoSocketId &&
        dados.destinoSocketId !== destinoCorreto
      )
    ) {
      console.log(
        `[WEBRTC] Resposta inválida para ${dados?.callId}.`
      );
      return;
    }

    io.to(destinoCorreto).emit(
      'resposta_chamada',
      {
        callId: dados.callId,
        origemSocketId: socket.id,
        answer: dados.answer
      }
    );

    console.log(
      `[WEBRTC] Resposta ${dados.callId}: ${socket.id} -> ${destinoCorreto}.`
    );
  });

  socket.on('webrtc_ice_candidate', dados => {
    const chamada = obterChamadaDoSocket(
      dados?.callId
    );

    if (!chamada || !dados?.candidate) {
      return;
    }

    const destinoCorreto = obterOutroParticipante(
      chamada,
      socket.id
    );

    if (
      !destinoCorreto ||
      (
        dados.destinoSocketId &&
        dados.destinoSocketId !== destinoCorreto
      )
    ) {
      console.log(
        `[WEBRTC] ICE inválido para ${dados?.callId}.`
      );
      return;
    }

    io.to(destinoCorreto).emit(
      'receber_ice_candidate',
      {
        callId: dados.callId,
        origemSocketId: socket.id,
        candidate: dados.candidate
      }
    );
  });

  socket.on(
    'webrtc_restart_offer',
    (dados, callback) => {
      const chamada = obterChamadaDoSocket(
        dados?.callId
      );

      if (!chamada || !dados?.offer) {
        responder(callback, {
          status: 'erro',
          msg: 'Chamada ou oferta de reinício inválida.'
        });
        return;
      }

      const destinoCorreto = obterOutroParticipante(
        chamada,
        socket.id
      );

      if (
        !destinoCorreto ||
        (
          dados.destinoSocketId &&
          dados.destinoSocketId !== destinoCorreto
        )
      ) {
        responder(callback, {
          status: 'erro',
          msg: 'Destino do reinício ICE inválido.'
        });
        return;
      }

      io.to(destinoCorreto).emit(
        'webrtc_restart_offer_received',
        {
          callId: dados.callId,
          origemSocketId: socket.id,
          offer: dados.offer
        }
      );

      responder(callback, {
        status: 'ok'
      });

      console.log(
        `[WEBRTC] Oferta de reinício ICE ${dados.callId}: ${socket.id} -> ${destinoCorreto}.`
      );
    }
  );

  socket.on(
    'webrtc_restart_answer',
    (dados, callback) => {
      const chamada = obterChamadaDoSocket(
        dados?.callId
      );

      if (!chamada || !dados?.answer) {
        responder(callback, {
          status: 'erro',
          msg: 'Chamada ou resposta de reinício inválida.'
        });
        return;
      }

      const destinoCorreto = obterOutroParticipante(
        chamada,
        socket.id
      );

      if (
        !destinoCorreto ||
        (
          dados.destinoSocketId &&
          dados.destinoSocketId !== destinoCorreto
        )
      ) {
        responder(callback, {
          status: 'erro',
          msg: 'Destino da resposta de reinício inválido.'
        });
        return;
      }

      io.to(destinoCorreto).emit(
        'webrtc_restart_answer_received',
        {
          callId: dados.callId,
          origemSocketId: socket.id,
          answer: dados.answer
        }
      );

      responder(callback, {
        status: 'ok'
      });

      console.log(
        `[WEBRTC] Resposta de reinício ICE ${dados.callId}: ${socket.id} -> ${destinoCorreto}.`
      );
    }
  );

  socket.on('webrtc_request_restart', dados => {
    const chamada = obterChamadaDoSocket(
      dados?.callId
    );

    if (!chamada) return;

    const destinoCorreto = obterOutroParticipante(
      chamada,
      socket.id
    );

    if (
      !destinoCorreto ||
      (
        dados.destinoSocketId &&
        dados.destinoSocketId !== destinoCorreto
      )
    ) {
      return;
    }

    io.to(destinoCorreto).emit(
      'webrtc_restart_requested',
      {
        callId: dados.callId,
        origemSocketId: socket.id,
        motivo:
          dados.motivo ||
          'O outro aparelho perdeu a rota de mídia.'
      }
    );

    console.log(
      `[WEBRTC] Reinício ICE solicitado em ${dados.callId}: ${socket.id} -> ${destinoCorreto}.`
    );
  });

  // Encaminha uma nova oferta SDP para recuperar apenas a mídia de vídeo sem
  // destruir a chamada de áudio que já está funcionando.
  socket.on('webrtc_media_offer', (dados, callback) => {
    const chamada = obterChamadaDoSocket(dados?.callId);
    if (!chamada || !dados?.offer) {
      responder(callback, { status: 'erro', msg: 'Chamada ou oferta de mídia inválida.' });
      return;
    }

    const destinoCorreto = obterOutroParticipante(chamada, socket.id);
    if (
      !destinoCorreto ||
      (dados.destinoSocketId && dados.destinoSocketId !== destinoCorreto)
    ) {
      responder(callback, { status: 'erro', msg: 'Destino da renegociação inválido.' });
      return;
    }

    io.to(destinoCorreto).emit('webrtc_media_offer_received', {
      callId: dados.callId,
      origemSocketId: socket.id,
      offer: dados.offer,
      motivo: dados.motivo || 'recuperação de vídeo'
    });

    responder(callback, { status: 'ok' });
    console.log(`[WEBRTC] Oferta de mídia ${dados.callId}: ${socket.id} -> ${destinoCorreto}.`);
  });

  // Encaminha a resposta da renegociação para o peer que gerou a nova oferta.
  socket.on('webrtc_media_answer', (dados, callback) => {
    const chamada = obterChamadaDoSocket(dados?.callId);
    if (!chamada || !dados?.answer) {
      responder(callback, { status: 'erro', msg: 'Chamada ou resposta de mídia inválida.' });
      return;
    }

    const destinoCorreto = obterOutroParticipante(chamada, socket.id);
    if (
      !destinoCorreto ||
      (dados.destinoSocketId && dados.destinoSocketId !== destinoCorreto)
    ) {
      responder(callback, { status: 'erro', msg: 'Destino da resposta de mídia inválido.' });
      return;
    }

    io.to(destinoCorreto).emit('webrtc_media_answer_received', {
      callId: dados.callId,
      origemSocketId: socket.id,
      answer: dados.answer
    });

    responder(callback, { status: 'ok' });
    console.log(`[WEBRTC] Resposta de mídia ${dados.callId}: ${socket.id} -> ${destinoCorreto}.`);
  });

  // Permite que o receptor peça ao chamador uma nova oferta. Manter o chamador
  // como ofertante evita glare e estados de sinalização concorrentes.
  socket.on('webrtc_request_media_renegotiation', dados => {
    const chamada = obterChamadaDoSocket(dados?.callId);
    if (!chamada) return;

    const destinoCorreto = obterOutroParticipante(chamada, socket.id);
    if (
      !destinoCorreto ||
      (dados.destinoSocketId && dados.destinoSocketId !== destinoCorreto)
    ) return;

    io.to(destinoCorreto).emit('webrtc_media_renegotiation_requested', {
      callId: dados.callId,
      origemSocketId: socket.id,
      motivo: dados.motivo || 'o outro aparelho não recebeu frames de vídeo'
    });

    console.log(`[WEBRTC] Renegociação de mídia solicitada em ${dados.callId}: ${socket.id} -> ${destinoCorreto}.`);
  });

  socket.on('webrtc_reject', dados => {
    const chamada = obterChamadaDoSocket(
      dados?.callId
    );

    if (!chamada) return;

    const destinoCorreto = obterOutroParticipante(
      chamada,
      socket.id
    );

    if (destinoCorreto) {
      io.to(destinoCorreto).emit(
        'chamada_recusada',
        {
          callId: dados.callId,
          motivo:
            dados.motivo ||
            'Chamada recusada.'
        }
      );
    }

    chamadasAtivas.delete(dados.callId);
    console.log(`[WEBRTC] Chamada ${dados.callId} recusada.`);
  });

  socket.on('webrtc_busy', dados => {
    const destinoSocketId = dados?.destinoSocketId;

    if (!destinoSocketId) return;

    io.to(destinoSocketId).emit(
      'chamada_ocupada',
      {
        callId: dados.callId,
        motivo:
          'A outra pessoa já está em uma chamada.'
      }
    );

    if (dados.callId) {
      chamadasAtivas.delete(dados.callId);
    }
  });

  socket.on('desligar_chamada', dados => {
    const chamada = obterChamadaDoSocket(
      dados?.callId
    );

    if (!chamada) return;

    const destinoCorreto = obterOutroParticipante(
      chamada,
      socket.id
    );

    if (destinoCorreto) {
      io.to(destinoCorreto).emit(
        'chamada_encerrada',
        {
          callId: dados.callId,
          motivo:
            dados.motivo ||
            'Chamada encerrada.'
        }
      );
    }

    chamadasAtivas.delete(dados.callId);
    console.log(`[WEBRTC] Chamada ${dados.callId} encerrada.`);
  });

  // 🏆 RANKING GLOBAL ANÔNIMO
  socket.on('novo_recorde_anonimo', async ({ jogo, pontos } = {}) => {
    const pontosValidos = Math.max(0, Math.min(100000000, Math.floor(Number(pontos) || 0)));

    if (!db || !JOGOS_RANKING.includes(jogo) || pontosValidos <= 0) {
      console.log(`[RANKING] Resultado rejeitado. jogo=${jogo}; pontos=${pontos}.`);
      return;
    }

    try {
      await db.collection(`Ranking_${jogo}`).add({
        pontos: pontosValidos,
        timestamp: Date.now()
      });

      const snapshot = await db
        .collection(`Ranking_${jogo}`)
        .orderBy('pontos', 'desc')
        .limit(3)
        .get();

      const top3 = snapshot.docs.map(documento => documento.data());
      io.emit('atualizar_ranking', { [jogo]: top3 });
      console.log(`[RANKING] Recorde anônimo registrado: ${jogo}=${pontosValidos}.`);
    } catch (error) {
      console.log(`[RANKING] Falha ao registrar ${jogo}:`, error);
    }
  });

  // Carrega as dez modalidades de forma isolada: falha em uma coleção não
  // impede o retorno das demais classificações.
  socket.on('pedir_ranking', async () => {
    if (!db) return;

    const rankings = JOGOS_RANKING.reduce(
      (mapa, jogo) => ({ ...mapa, [jogo]: [] }),
      {}
    );

    for (const jogo of JOGOS_RANKING) {
      try {
        const snapshot = await db
          .collection(`Ranking_${jogo}`)
          .orderBy('pontos', 'desc')
          .limit(3)
          .get();
        rankings[jogo] = snapshot.docs.map(documento => documento.data());
      } catch (error) {
        console.log(`[RANKING] Falha ao carregar ${jogo}:`, error.message);
      }
    }

    socket.emit('atualizar_ranking', rankings);
  });

  // 🚪 SAIR DA SALA / DISCONNECT
  const lidarComSaida = motivo => {
    const salaAtual = socket.data.salaAtual;

    encerrarChamadasDoSocket(
      motivo || 'Participante desconectado.'
    );

    if (salaAtual) {
      socket.leave(salaAtual);
      socket.data.salaAtual = null;
      atualizarContagemSala(salaAtual);
      verificarDestruicaoSala(salaAtual);
    }
  };

  socket.on('sair_sala', () => {
    lidarComSaida('Participante saiu da sala.');
  });

  socket.on('disconnect', motivo => {
    lidarComSaida('Participante desconectado.');
    console.log(
      `[SOCKET] Conexão anônima ${socket.id} encerrada: ${motivo}`
    );
  });
});

// =====================================================
// 🚀 START SERVER
// =====================================================

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 MODO FURTIVO ATIVO: Operando na porta ${PORT}`);
});
