const express  = require('express');
const http     = require('http');
const socketIo = require('socket.io');
const crypto   = require('crypto');
const path     = require('path');

const app    = express();
const server = http.createServer(app);

const io = socketIo(server, {
  transports:        ['websocket'],
  pingInterval:      3000,
  pingTimeout:       8000,
  maxHttpBufferSize: 2e5,   // 200kb — generous for game states
  cors: { origin: '*' }
});

// ── Routes ───────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.sendFile(path.resolve(__dirname, 'landing.html')));
app.use(express.static(path.join(__dirname)));
// Deep link: /join/ABCD → remote.html?room=ABCD
app.get('/join/:code', (req, res) =>
  res.redirect(`/remote.html?room=${req.params.code.toUpperCase()}`)
);

// ── Constants ─────────────────────────────────────────────────────────────────
const MAX_PLAYERS   = 4;
const PLAYER_COLORS = ['#00ffff', '#ff44ff', '#4488ff', '#ffff00'];
const GRACE_MS      = 20000;  // 20s reconnect window

// ═══════════════════════════════════════════════════════════════════════════════
//  ROOM
//  Pure relay — zero game logic. The Invisible Host (Player 1) owns the loop.
//  Server job: route packets, manage slots, enforce grace periods.
// ═══════════════════════════════════════════════════════════════════════════════
class Room {
  constructor(code, mode = 'remote') {
    this.code    = code;
    this.mode    = mode;        // 'remote' | 'local'
    this.players = new Map();   // socketId → playerData
    this.ghosts  = new Map();   // fingerprint → ghost {slot,color,fp,...}
    this.ready   = new Set();   // slots that hit Ready
    this.votes   = new Set();   // slots that voted restart
    this.started = false;
    this.hostSid = null;        // Player 1's socket — the Invisible Host
    console.log(`[ROOM ${code}] Created (${mode})`);
  }

  // ── Slot management ───────────────────────────────────────────────────────
  freeSlot() {
    const taken = new Set([
      ...[...this.players.values()].map(p => p.slot),
      ...[...this.ghosts.values()].map(g => g.slot)
    ]);
    for (let i = 1; i <= MAX_PLAYERS; i++) if (!taken.has(i)) return i;
    return null;
  }

  // ── Join / reconnect ──────────────────────────────────────────────────────
  join(socket, fp) {
    // --- Reconnect path ---
    if (fp && this.ghosts.has(fp)) {
      const g = this.ghosts.get(fp);
      clearTimeout(g._timeout);
      this.ghosts.delete(fp);
      const pd = { ...g, sid: socket.id, connected: true };
      delete pd._timeout;
      this.players.set(socket.id, pd);
      if (pd.slot === 1) this.hostSid = socket.id;

      socket.emit('join-ok', {
        slot: pd.slot, color: pd.color, code: this.code,
        isHost: pd.slot === 1, mode: this.mode, reconnect: true
      });
      this.broadcastLobby();

      // Tell host so it can re-enable that player in the game loop
      if (this.started) this.relayToHost('player-reconnected', { slot: pd.slot });
      console.log(`[ROOM ${this.code}] P${pd.slot} RECONNECTED`);
      return pd;
    }

    // --- Fresh join ---
    const slot = this.freeSlot();
    if (!slot) {
      socket.emit('join-failed', { reason: 'Room is full (max 4 players)' });
      return null;
    }
    const pd = {
      sid: socket.id, slot, fp: fp || socket.id,
      color: PLAYER_COLORS[slot - 1], connected: true
    };
    this.players.set(socket.id, pd);
    if (slot === 1) this.hostSid = socket.id;

    socket.emit('join-ok', {
      slot: pd.slot, color: pd.color, code: this.code,
      isHost: pd.slot === 1, mode: this.mode, reconnect: false
    });
    this.broadcastLobby();
    console.log(`[ROOM ${this.code}] P${slot} joined (${[...this.players.size]} total)`);
    return pd;
  }

  // ── Disconnect → grace period ─────────────────────────────────────────────
  disconnect(sid) {
    const pd = this.players.get(sid);
    if (!pd) return;
    this.players.delete(sid);
    this.ready.delete(pd.slot);

    // Start grace window — player can rejoin same slot
    pd._timeout = setTimeout(() => {
      this.ghosts.delete(pd.fp);
      this.broadcastAll('player-left', { slot: pd.slot });
      console.log(`[ROOM ${this.code}] P${pd.slot} grace expired`);
    }, GRACE_MS);
    this.ghosts.set(pd.fp, pd);

    this.broadcastAll('player-dc', { slot: pd.slot });
    this.broadcastLobby();
    console.log(`[ROOM ${this.code}] P${pd.slot} DC (grace ${GRACE_MS}ms)`);
  }

  // ── Ready / Start ─────────────────────────────────────────────────────────
  setReady(sid) {
    const pd = this.players.get(sid);
    if (!pd || this.started) return;
    this.ready.add(pd.slot);
    this.broadcastLobby();
    console.log(`[ROOM ${this.code}] P${pd.slot} READY (${this.ready.size}/${this.players.size})`);
    if (this.ready.size >= this.players.size && this.players.size >= 1) {
      this.started = true;
      this.broadcastAll('game-start', { mode: this.mode });
      console.log(`[ROOM ${this.code}] ▶ GAME START`);
    }
  }

  // ── Restart vote ──────────────────────────────────────────────────────────
  castVote(sid) {
    const pd = this.players.get(sid);
    if (!pd) return;
    this.votes.add(pd.slot);
    this.broadcastAll('vote-update', { votes: this.votes.size, needed: this.players.size });
    if (this.votes.size >= this.players.size) {
      this.votes.clear();
      this.ready.clear();
      this.started = false;
      this.broadcastAll('game-restart', {});
      console.log(`[ROOM ${this.code}] ↺ RESTART`);
    }
  }

  // ── Relay helpers ─────────────────────────────────────────────────────────
  // Host → all players (skips host itself)
  relayFromHost(event, data) {
    for (const [sid, pd] of this.players) {
      if (pd.slot === 1) continue;
      const s = io.sockets.sockets.get(sid);
      if (s) s.emit(event, data);
    }
  }

  // Any player → host
  relayToHost(event, data) {
    if (!this.hostSid) return;
    const s = io.sockets.sockets.get(this.hostSid);
    if (s) s.emit(event, data);
  }

  // Broadcast to everyone
  broadcastAll(event, data) {
    for (const [sid] of this.players) {
      const s = io.sockets.sockets.get(sid);
      if (s) s.emit(event, data);
    }
  }

  broadcastLobby() {
    const list = [...this.players.values()].map(p => ({
      slot: p.slot, color: p.color, ready: this.ready.has(p.slot)
    }));
    this.broadcastAll('lobby-state', { players: list, code: this.code, mode: this.mode });
  }

  get isEmpty() { return this.players.size === 0 && this.ghosts.size === 0; }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SOCKET HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════
const rooms = new Map();

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I,O,0,1 — confusing on mobile
  let code;
  do {
    code = Array.from(crypto.randomBytes(4))
      .map(b => chars[b % chars.length])
      .join('');
  } while (rooms.has(code));
  return code;
}

io.on('connection', socket => {
  let myRoom = null;
  console.log(`[SRV] ⊕ ${socket.id.slice(0, 8)}`);

  // ── Create room (becomes Player 1 / Invisible Host) ─────────────────────
  socket.on('create-room', ({ fp, mode } = {}) => {
    const code = genCode();
    const room = new Room(code, mode || 'remote');
    rooms.set(code, room);
    socket.join(code);
    myRoom = room;
    room.join(socket, fp || socket.id);
  });

  // ── Join existing room ───────────────────────────────────────────────────
  socket.on('join-room', ({ code, fp } = {}) => {
    const key = (code || '').toUpperCase().trim();
    const room = rooms.get(key);
    if (!room) { socket.emit('join-failed', { reason: `Room "${key}" not found` }); return; }
    socket.join(key);
    myRoom = room;
    room.join(socket, fp);
  });

  // ── Lobby ────────────────────────────────────────────────────────────────
  socket.on('set-ready', () => myRoom && myRoom.setReady(socket.id));

  // ── HOST → PLAYERS: game state (60fps, compact JSON) ────────────────────
  socket.on('host-state', data => {
    if (myRoom) myRoom.relayFromHost('game-state', data);
  });

  // ── HOST → PLAYERS: one-shot events (explosions, banners, pickups) ───────
  socket.on('host-event', data => {
    if (myRoom) myRoom.relayFromHost('game-event', data);
  });

  // ── PLAYER → HOST: joystick + buttons ────────────────────────────────────
  socket.on('player-input', data => {
    if (!myRoom) return;
    const pd = myRoom.players.get(socket.id);
    if (pd) myRoom.relayToHost('remote-input', { slot: pd.slot, ...data });
  });

  // ── PLAYER → HOST: mystery box purchase ──────────────────────────────────
  socket.on('buy-box', () => {
    if (!myRoom) return;
    const pd = myRoom.players.get(socket.id);
    if (pd) myRoom.relayToHost('remote-buy-box', { slot: pd.slot });
  });

  // ── Restart vote ──────────────────────────────────────────────────────────
  socket.on('vote-restart', () => myRoom && myRoom.castVote(socket.id));

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[SRV] ⊖ ${socket.id.slice(0, 8)}`);
    if (!myRoom) return;
    myRoom.disconnect(socket.id);
    // Reap truly empty rooms after grace
    setTimeout(() => {
      if (myRoom && myRoom.isEmpty) {
        rooms.delete(myRoom.code);
        console.log(`[ROOM ${myRoom.code}] Reaped`);
        myRoom = null;
      }
    }, GRACE_MS + 2000);
  });
});

// ── Boot ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║   Z-TEAM  ·  Invisible Host Relay v3    ║');
  console.log('  ╠══════════════════════════════════════════╣');
  console.log(`  ║  Port : ${String(PORT).padEnd(33)}║`);
  console.log('  ║  Model: Host-authority · Server=relay   ║');
  console.log('  ║  Lag  : 1 hop (host phone → server → ★) ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
});
