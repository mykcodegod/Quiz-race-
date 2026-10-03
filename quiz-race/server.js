'use strict';

const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const { parseQuestions, extractText } = require('./parser');

const PORT = Number(process.env.PORT) || 3000;
const REVEAL_MS = 4000;
const MAX_NAME = 20;
const MAX_UPLOAD = 20 * 1024 * 1024;

/* ------------------------------------------------------------------ */
/* Network helpers                                                      */
/* ------------------------------------------------------------------ */

function isV4(i) {
  return i.family === 'IPv4' || i.family === 4;
}

function addressRank(ip) {
  if (/^192\.168\.56\./.test(ip)) return 3; // VirtualBox host-only adapter
  if (/^192\.168\./.test(ip)) return 0;
  if (/^10\./.test(ip)) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  return 4;
}

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) {
      if (isV4(i) && !i.internal) out.push({ name, ip: i.address });
    }
  }
  out.sort((a, b) => addressRank(a.ip) - addressRank(b.ip));
  return out;
}

function normalizeAddr(a) {
  return String(a || '').replace(/^::ffff:/, '');
}

// True when the request comes from this PC (localhost or the PC's own LAN IP).
function isLocalAddr(addr) {
  const a = normalizeAddr(addr);
  if (a === '127.0.0.1' || a === '::1') return true;
  return lanAddresses().some((x) => x.ip === a);
}

async function buildJoinCandidates() {
  let addrs = lanAddresses();
  if (process.env.HOST_IP) addrs = [{ name: 'HOST_IP', ip: process.env.HOST_IP }];
  if (addrs.length === 0) addrs = [{ name: 'localhost', ip: 'localhost' }];
  return Promise.all(
    addrs.map(async (a) => {
      const url = `http://${a.ip}:${PORT}`;
      const qr = await QRCode.toDataURL(url, { margin: 1, width: 480, errorCorrectionLevel: 'M' });
      return { name: a.name, ip: a.ip, url, qr };
    })
  );
}

/* ------------------------------------------------------------------ */
/* Game state (single room, in memory)                                  */
/* ------------------------------------------------------------------ */

const game = {
  status: 'LOBBY', // LOBBY | IN_PROGRESS | PAUSED | FINISHED
  decks: [], // Array of { id, title, uploader, fileName, questions, warnings, playedCount }
  activeDeckId: null,
  settings: { timeLimitSec: 15, speedBonus: true, autoMode: true, lastManPressure: false, pressureTimeSec: 10, submitMode: false },
  players: new Map(), // secret id -> player
  qIndex: -1,
  phase: null, // 'question' | 'reveal' | null
  phaseMs: 0,
  endsAt: 0,
  remainingMs: 0, // frozen value while paused
  counts: null,
  handle: null,
  descOpen: false,
  pausedForDesc: false,
  pressureTriggered: false,
};

let nextPid = 1;
let joinCandidates = [];

function getActiveDeck() {
  return game.decks.find(d => d.id === game.activeDeckId) || null;
}

const currentQuestion = () => {
  const d = getActiveDeck();
  return d ? d.questions[game.qIndex] : null;
};
const connectedPlayers = () => [...game.players.values()].filter((p) => p.connected);

function clearTimer() {
  if (game.handle) {
    clearTimeout(game.handle);
    game.handle = null;
  }
}

function startPhase(phase, ms) {
  clearTimer();
  game.phase = phase;
  game.phaseMs = ms;
  game.endsAt = ms > 0 ? Date.now() + ms : 0;
  if (ms > 0) {
    game.handle = setTimeout(onPhaseEnd, ms);
  } else {
    game.handle = null;
  }
}

function remaining() {
  if (game.status === 'PAUSED') return game.remainingMs;
  if (!game.phase || game.phaseMs === 0) return 0;
  return Math.max(0, game.endsAt - Date.now());
}

function onPhaseEnd() {
  game.handle = null;
  if (game.status !== 'IN_PROGRESS') return;
  if (game.settings.autoMode) {
    if (game.phase === 'question') closeQuestion();
    else if (game.phase === 'reveal') nextQuestion();
  }
}

function nextQuestion() {
  game.qIndex += 1;
  const d = getActiveDeck();
  if (d) d.playedCount = game.qIndex;
  
  for (const p of game.players.values()) {
    p.answer = null;
    p.gain = 0;
  }
  game.counts = null;
  game.descOpen = false;
  game.pausedForDesc = false;
  game.pressureTriggered = false;
  if (!d || game.qIndex >= d.questions.length) {
    if (d) d.playedCount = d.questions.length;
    return finishGame();
  }
  startPhase('question', game.settings.timeLimitSec * 1000);
  broadcast();
}

// Scores are applied here, not when a player answers, so the scoreboard
// never leaks who answered correctly before the question closes.
function closeQuestion() {
  if (game.phase !== 'question') return;
  const q = currentQuestion();
  game.counts = q.options.map(() => 0);
  for (const p of game.players.values()) {
    if (p.answer) {
      game.counts[p.answer.choice] += 1;
      // Calculate speed bonus if phaseMs > 0, else give flat points
      if (game.settings.speedBonus && game.phaseMs > 0) {
        p.gain = 500 + Math.round((500 * Math.max(0, game.endsAt - p.answer.time)) / game.phaseMs);
      } else {
        p.gain = 1000;
      }
      p.score += p.gain;
    } else {
      p.gain = 0;
    }
  }
  startPhase('reveal', REVEAL_MS);
  broadcast();
}

function finishGame() {
  clearTimer();
  game.status = 'FINISHED';
  game.phase = null;
  broadcast();
}

// Returns true if it closed the question.
function checkAllAnswered() {
  if (game.status !== 'IN_PROGRESS' || game.phase !== 'question') return false;
  const active = connectedPlayers();
  if (active.length > 0 && active.every((p) => p.answer)) {
    if (game.settings.autoMode) {
      closeQuestion();
      return true;
    }
  }
  return false;
}

function triggerPressure() {
  game.pressureTriggered = true;
  const pressureMs = game.settings.pressureTimeSec * 1000;
  
  if (game.phaseMs === 0) {
    startPhase('question', pressureMs);
  } else {
    const rem = remaining();
    if (rem > pressureMs) {
      startPhase('question', pressureMs);
    }
  }
}

/* ------------------------------------------------------------------ */
/* State sent to clients                                                */
/* ------------------------------------------------------------------ */

function scoreboard() {
  const sorted = [...game.players.values()].sort(
    (a, b) => b.score - a.score || a.joinedAt - b.joinedAt
  );
  let prevScore = null;
  let prevRank = 0;
  return sorted.map((p, i) => {
    const rank = p.score === prevScore ? prevRank : i + 1;
    prevScore = p.score;
    prevRank = rank;
    return {
      pid: p.pid,
      rank,
      name: p.name,
      score: p.score,
      connected: p.connected,
      answered: game.phase === 'question' ? !!p.answer : undefined,
      gain: game.phase === 'reveal' ? p.gain : undefined,
    };
  });
}

function getRevealedChoices() {
  const q = currentQuestion();
  if (!q) return null;
  const res = q.options.map(() => []);
  for (const p of game.players.values()) {
    if (p.answer) res[p.answer.choice].push(p.name);
  }
  return res;
}

function baseState() {
  const q = game.phase ? currentQuestion() : null;
  const reveal = game.phase === 'reveal' && q;
  const d = getActiveDeck();
  return {
    status: game.status,
    phase: game.phase,
    remainingMs: remaining(),
    phaseMs: game.phaseMs,
    qNumber: game.qIndex + 1,
    qTotal: d ? d.questions.length : 0,
    question: q ? { text: q.text, options: q.options, description: reveal ? q.description : null } : null,
    correctIndex: reveal ? q.correctIndex : null,
    counts: reveal ? game.counts : null,
    revealedChoices: reveal ? getRevealedChoices() : null,
    board: scoreboard(),
    playerCount: connectedPlayers().length,
    descOpen: game.descOpen,
    pausedForDesc: game.pausedForDesc,
    settings: game.settings,
  };
}

function sendState(socket, base) {
  const s = { ...base };
  if (!socket.data.isHost && socket.data.playerId) {
    const p = game.players.get(socket.data.playerId);
    if (p) {
      s.me = {
        pid: p.pid,
        name: p.name,
        score: p.score,
        choice: p.answer ? p.answer.choice : null,
        gain: game.phase === 'reveal' ? p.gain : null,
      };
    }
  }
  socket.emit('state', s);
}

function broadcast() {
  const base = baseState();
  io.sockets.sockets.forEach((socket) => sendState(socket, base));
}

function decksPayload() {
  return {
    decks: game.decks.map((d) => ({
      id: d.id,
      title: d.title,
      uploader: d.uploader,
      fileName: d.fileName,
      count: d.questions.length,
      playedCount: d.playedCount,
      warnings: d.warnings,
      questions: d.questions.map((q) => ({
        text: q.text,
        options: q.options,
        correctIndex: q.correctIndex,
        description: q.description,
      })),
    })),
    activeDeckId: game.activeDeckId
  };
}

function emitToHosts(event, payload) {
  io.sockets.sockets.forEach((s) => {
    if (s.data.isHost) s.emit(event, payload);
  });
}

function cleanName(v) {
  return String(v || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                 */
/* ------------------------------------------------------------------ */

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.disable('x-powered-by');

const localOnly = (req, res, next) => {
  if (isLocalAddr(req.socket.remoteAddress)) return next();
  res.status(403).send('The host page can only be opened on the PC that runs the server.');
};

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'player.html')));
app.get('/host', localOnly, (req, res) =>
  res.sendFile(path.join(__dirname, 'private', 'host.html'))
);
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD } });

app.post('/api/upload', localOnly, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 20 MB.' : 'Upload failed.';
      return res.status(400).json({ ok: false, error: msg });
    }
    if (game.status !== 'LOBBY') {
      return res.status(409).json({ ok: false, error: 'Questions can only be changed in the lobby.' });
    }
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file received.' });

    let fileName = req.file.originalname || 'questions';
    // Some multer versions hand back UTF-8 names decoded as latin1.
    if (/^[\x00-\xff]*$/.test(fileName)) fileName = Buffer.from(fileName, 'latin1').toString('utf8');

    try {
      const text = await extractText(req.file.buffer, fileName);
      const { questions, warnings } = parseQuestions(text);
      if (questions.length === 0) {
        return res.status(422).json({ ok: false, error: 'No usable questions found in that file.', warnings });
      }
      const newDeck = {
        id: crypto.randomUUID(),
        title: fileName,
        uploader: 'Host',
        fileName,
        questions,
        warnings,
        playedCount: 0
      };
      game.decks.push(newDeck);
      game.activeDeckId = newDeck.id;
      emitToHosts('decks', decksPayload());
      res.json({ ok: true });
    } catch (e) {
      res.status(422).json({ ok: false, error: e.message || 'Could not read that file.' });
    }
  });
});

app.post('/api/upload-player', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ ok: false, error: 'Upload failed.' });
    if (game.status !== 'LOBBY') return res.status(409).json({ ok: false, error: 'Cannot upload now.' });
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file received.' });
    
    let fileName = req.file.originalname || 'questions';
    if (/^[\x00-\xff]*$/.test(fileName)) fileName = Buffer.from(fileName, 'latin1').toString('utf8');
    
    const title = String(req.body.title || fileName).trim();
    const pid = req.body.playerId;
    const p = game.players.get(pid);
    const uploader = p ? p.name : 'Player';

    try {
      const text = await extractText(req.file.buffer, fileName);
      const { questions, warnings } = parseQuestions(text);
      if (questions.length === 0) return res.status(422).json({ ok: false, error: 'No usable questions.' });
      
      const newDeck = {
        id: crypto.randomUUID(),
        title,
        uploader,
        fileName,
        questions,
        warnings,
        playedCount: 0
      };
      game.decks.push(newDeck);
      if (!game.activeDeckId) game.activeDeckId = newDeck.id;
      emitToHosts('decks', decksPayload());
      res.json({ ok: true });
    } catch (e) {
      res.status(422).json({ ok: false, error: 'Could not read that file.' });
    }
  });
});

/* ------------------------------------------------------------------ */
/* Sockets                                                              */
/* ------------------------------------------------------------------ */

io.on('connection', (socket) => {
  /* ---- host ---- */
  socket.on('host:join', () => {
    if (!isLocalAddr(socket.handshake.address)) return socket.emit('host:denied');
    socket.data.isHost = true;
    socket.emit('host:info', { candidates: joinCandidates });
    socket.emit('decks', decksPayload());
    sendState(socket, baseState());
  });

  const hostOnly = (fn) => (...args) => {
    if (socket.data.isHost) fn(...args);
  };

  socket.on('host:select_deck', hostOnly((id) => {
    if (game.status !== 'LOBBY') return;
    if (game.decks.some(d => d.id === id)) {
      game.activeDeckId = id;
      emitToHosts('decks', decksPayload());
    }
  }));

  socket.on(
    'host:start',
    hostOnly((opts = {}) => {
      if (game.status !== 'LOBBY' || !getActiveDeck() || game.players.size === 0) return;
      const t = Math.round(Number(opts.timeLimitSec));
      game.settings.timeLimitSec = Number.isFinite(t) ? Math.max(0, t) : 15;
      game.settings.speedBonus = opts.speedBonus !== false;
      game.settings.autoMode = opts.autoMode !== false;
      game.settings.lastManPressure = !!opts.lastManPressure;
      game.settings.pressureTimeSec = Number.isFinite(Number(opts.pressureTimeSec)) ? Math.max(1, Number(opts.pressureTimeSec)) : 10;
      game.settings.submitMode = !!opts.submitMode;
      
      for (const p of game.players.values()) {
        p.score = 0;
        p.answer = null;
        p.gain = 0;
      }
      game.status = 'IN_PROGRESS';
      
      const d = getActiveDeck();
      // Resume from where left off, or restart if completely played
      game.qIndex = (d.playedCount >= d.questions.length) ? -1 : d.playedCount - 1;
      nextQuestion();
    })
  );

  socket.on('host:next_phase', hostOnly(() => {
    if (game.status !== 'IN_PROGRESS' && game.status !== 'PAUSED') return;
    if (game.phase === 'question') {
      closeQuestion();
    } else if (game.phase === 'reveal') {
      nextQuestion();
    }
  }));

  socket.on(
    'host:pause',
    hostOnly(() => {
      if (game.status === 'PAUSED' && game.pausedForDesc) {
        game.pausedForDesc = false;
        broadcast();
      } else if (game.status === 'IN_PROGRESS') {
        game.remainingMs = remaining();
        clearTimer();
        game.status = 'PAUSED';
        game.pausedForDesc = false;
        broadcast();
      }
    })
  );

  socket.on(
    'host:resume',
    hostOnly(() => {
      if (game.status !== 'PAUSED') return;
      game.status = 'IN_PROGRESS';
      game.pausedForDesc = false;
      game.descOpen = false;
      game.endsAt = Date.now() + game.remainingMs;
      game.handle = setTimeout(onPhaseEnd, game.remainingMs);
      broadcast();
    })
  );

  // Back to the lobby with the same questions. Connected players stay in.
  socket.on(
    'host:reset',
    hostOnly(() => {
      clearTimer();
      game.status = 'LOBBY';
      game.phase = null;
      game.qIndex = -1;
      game.counts = null;
      for (const [id, p] of game.players) {
        if (!p.connected) game.players.delete(id);
        else {
          p.score = 0;
          p.answer = null;
          p.gain = 0;
        }
      }
      broadcast();
    })
  );

  /* ---- players ---- */
  socket.on('player:join', (data = {}) => {
    const id = typeof data.playerId === 'string' ? data.playerId.slice(0, 64) : '';
    const existing = id ? game.players.get(id) : null;

    if (existing) {
      // Known player coming back (phone slept, Wi-Fi blip, page reload).
      existing.socketId = socket.id;
      existing.connected = true;
      socket.data.playerId = id;
      socket.emit('joined', { id, name: existing.name });
      broadcast();
      return;
    }

    if (game.status !== 'LOBBY') {
      return socket.emit('join:rejected', { message: 'Session already started. Join the next round!' });
    }

    const name = cleanName(data.name);
    if (!name) return socket.emit('join:error', { message: 'Enter a name to join.' });
    const taken = [...game.players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase());
    if (taken) return socket.emit('join:error', { message: 'That name is taken. Pick another.' });

    const player = {
      id: crypto.randomUUID(),
      pid: nextPid++,
      name,
      score: 0,
      connected: true,
      socketId: socket.id,
      joinedAt: Date.now(),
      answer: null,
      gain: 0,
    };
    game.players.set(player.id, player);
    socket.data.playerId = player.id;
    socket.emit('joined', { id: player.id, name });
    broadcast();
  });

  socket.on('player:answer', (data = {}) => {
    const p = game.players.get(socket.data.playerId);
    if (!p || game.status !== 'IN_PROGRESS' || game.phase !== 'question' || p.answer) return;
    const q = currentQuestion();
    const choice = Number(data.choice);
    if (!Number.isInteger(choice) || choice < 0 || choice >= q.options.length) return;

    const correct = choice === q.correctIndex;
    p.answer = { choice, correct, time: Date.now() };
    
    if (game.settings.lastManPressure && !game.pressureTriggered) {
      const active = connectedPlayers();
      const answered = active.filter(pl => pl.answer).length;
      if (active.length > 0 && answered / active.length >= 0.8) {
        triggerPressure();
      }
    }

    if (!checkAllAnswered()) broadcast();
  });

  socket.on('player:submit_question', () => { /* deprecated text submit */ });

  socket.on('desc:toggle', (isOpen) => {
    if (game.phase !== 'reveal') return;
    
    game.descOpen = !!isOpen;
    
    if (game.descOpen) {
      if (game.status === 'IN_PROGRESS') {
        game.remainingMs = remaining();
        clearTimer();
        game.status = 'PAUSED';
        game.pausedForDesc = true;
      }
    } else {
      if (game.status === 'PAUSED' && game.pausedForDesc) {
        game.status = 'IN_PROGRESS';
        game.pausedForDesc = false;
        game.endsAt = Date.now() + game.remainingMs;
        game.handle = setTimeout(onPhaseEnd, game.remainingMs);
      }
    }
    broadcast();
  });

  socket.on('disconnect', () => {
    const id = socket.data.playerId;
    if (!id) return;
    const p = game.players.get(id);
    if (!p || p.socketId !== socket.id) return; // already replaced by a newer connection
    if (game.status === 'LOBBY') game.players.delete(id);
    else p.connected = false;
    broadcast();
    checkAllAnswered();
  });
});

/* ------------------------------------------------------------------ */
/* Start                                                                */
/* ------------------------------------------------------------------ */

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Close the other program or run: set PORT=3001 && node server.js`);
  } else {
    console.error(e);
  }
  process.exit(1);
});

buildJoinCandidates().then((candidates) => {
  joinCandidates = candidates;
  server.listen(PORT, '0.0.0.0', () => {
    console.log('\nዱነጊ-ጀማ is running.\n');
    console.log(`  Host page (open on this PC):  http://localhost:${PORT}/host`);
    candidates.forEach((c) => console.log(`  Players join at:              ${c.url}   (${c.name})`));
    console.log('\nIf players cannot connect, allow Node.js through Windows Firewall on private networks.\n');
  });
});
