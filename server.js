const express  = require('express');
const http     = require('http');
const socketIo = require('socket.io');
const crypto   = require('crypto');
const path     = require('path');

const app    = express();
const server = http.createServer(app);

// ── Phase 1: force WebSocket transport for stable Render.com connections ──
const io = socketIo(server, {
  transports: ['websocket'],
  cors: { origin: '*' }
});

// ── Landing page as root — must come BEFORE express.static ──────────────
app.get('/', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'landing.html'));
});

app.use(express.static(path.join(__dirname)));

// ── Phase 1: /join/:roomCode deep link ────────────────────────────────────
// Allows shareable URLs like https://yourapp.onrender.com/join/AB12
// Redirects phones straight to controller with the room code pre-filled
app.get('/join/:roomCode', (req, res) => {
  const code = req.params.roomCode.toUpperCase();
  res.redirect(`/controller.html?room=${code}`);
});

const MAX_PLAYERS          = 4;
const PLAYER_COLORS        = ['#00ffff', '#ff44ff', '#4488ff', '#ffff00'];
const HEARTBEAT_INTERVAL_MS = 2000;
const GRACE_PERIOD_MS      = 10000;
const gameRooms            = new Map();

class GameRoom {
  constructor(roomCode) {
    this.roomCode           = roomCode;
    this.hostSocket         = null;
    this.players            = new Map();
    this.disconnectedPlayers = new Map();
    this.restartVotes       = new Set();
    this.readyPlayers       = new Set();
    this.gameStarted        = false;
    console.log(`[ROOM ${roomCode}] Created`);
  }

  static generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code;
    do {
      const randomBytes = crypto.randomBytes(4);
      code = Array.from(randomBytes).map(byte => chars[byte % chars.length]).join('');
    } while (gameRooms.has(code));
    return code;
  }

  setHost(socket) {
    this.hostSocket = socket;
    socket.emit('room-created', { roomCode: this.roomCode });
    console.log(`[ROOM ${this.roomCode}] Host connected`);
  }

  findAvailableSlot() {
    for (let i = 1; i <= MAX_PLAYERS; i++) {
      if (!this.isSlotOccupied(i)) return i;
    }
    return null;
  }

  isSlotOccupied(slotNumber) {
    for (let player of this.players.values()) {
      if (player.slotNumber === slotNumber && player.connected) return true;
    }
    for (let player of this.disconnectedPlayers.values()) {
      if (player.slotNumber === slotNumber) return true;
    }
    return false;
  }

  addPlayer(socket, deviceFingerprint = null) {
    if (deviceFingerprint && this.disconnectedPlayers.has(deviceFingerprint)) {
      return this.reconnectPlayer(socket, deviceFingerprint);
    }
    const slotNumber = this.findAvailableSlot();
    if (slotNumber === null) {
      socket.emit('join-failed', { reason: 'Room is full' });
      return null;
    }
    const playerData = {
      socketId: socket.id,
      slotNumber,
      color: PLAYER_COLORS[slotNumber - 1],
      connected: true,
      lastPong: Date.now(),
      deviceFingerprint: socket.id
    };
    this.players.set(socket.id, playerData);
    if (this.hostSocket) {
      this.hostSocket.emit('player-joined', {
        playerId: socket.id,
        slotNumber,
        color: playerData.color
      });
    }
    this.broadcastLobbyState();
    console.log(`[ROOM ${this.roomCode}] Player ${slotNumber} joined`);
    return playerData;
  }

  reconnectPlayer(socket, deviceFingerprint) {
    const disconnectedPlayer = this.disconnectedPlayers.get(deviceFingerprint);
    if (!disconnectedPlayer) return null;
    if (disconnectedPlayer.gracePeriodTimeout) clearTimeout(disconnectedPlayer.gracePeriodTimeout);
    const playerData = { ...disconnectedPlayer, socketId: socket.id, connected: true, lastPong: Date.now() };
    this.players.set(socket.id, playerData);
    this.disconnectedPlayers.delete(deviceFingerprint);
    if (this.hostSocket) {
      this.hostSocket.emit('player-reconnected', {
        playerId: socket.id,
        slotNumber: playerData.slotNumber,
        color: playerData.color
      });
    }
    this.broadcastLobbyState();
    console.log(`[ROOM ${this.roomCode}] Player ${playerData.slotNumber} reconnected`);
    return playerData;
  }

  handleDisconnect(socketId) {
    const player = this.players.get(socketId);
    if (!player) return;
    this.disconnectedPlayers.set(player.deviceFingerprint, player);
    this.players.delete(socketId);
    this.restartVotes.delete(player.slotNumber);
    this.readyPlayers.delete(player.slotNumber);
    if (this.hostSocket) this.hostSocket.emit('player-disconnected', { slotNumber: player.slotNumber });
    player.gracePeriodTimeout = setTimeout(() => {
      this.disconnectedPlayers.delete(player.deviceFingerprint);
      if (this.hostSocket) this.hostSocket.emit('player-removed', { slotNumber: player.slotNumber });
    }, GRACE_PERIOD_MS);
    console.log(`[ROOM ${this.roomCode}] Player ${player.slotNumber} disconnected`);
  }

  startHeartbeat(socket) {
    const interval = setInterval(() => {
      const player = this.players.get(socket.id);
      if (!player) { clearInterval(interval); return; }
      socket.emit('ping');
      if (Date.now() - player.lastPong > HEARTBEAT_INTERVAL_MS * 2) {
        clearInterval(interval);
        this.handleDisconnect(socket.id);
      }
    }, HEARTBEAT_INTERVAL_MS);
    const player = this.players.get(socket.id);
    if (player) player.heartbeatInterval = interval;
  }

  updateLastPong(socketId) {
    const player = this.players.get(socketId);
    if (player) player.lastPong = Date.now();
  }

  relayPlayerInput(socketId, inputData) {
    const player = this.players.get(socketId);
    if (!player || !this.hostSocket) return;
    this.hostSocket.emit('player-input', { slotNumber: player.slotNumber, input: inputData });
  }

  handleMysteryBoxPurchase(data) {
    if (!this.hostSocket) return;
    this.hostSocket.emit('mystery-box-purchase', { slotNumber: data.slotNumber });
    console.log(`[ROOM ${this.roomCode}] Player ${data.slotNumber} used mystery box`);
  }

  handleReady(socketId) {
    const player = this.players.get(socketId);
    if (!player || this.gameStarted) return;
    this.readyPlayers.add(player.slotNumber);
    console.log(`[ROOM ${this.roomCode}] Player ${player.slotNumber} is READY (${this.readyPlayers.size}/${this.players.size})`);
    this.broadcastLobbyState();
    if (this.readyPlayers.size >= this.players.size && this.players.size >= 1) {
      this.gameStarted = true;
      console.log(`[ROOM ${this.roomCode}] All players ready - starting!`);
      if (this.hostSocket) this.hostSocket.emit('all-ready');
      for (let [sid] of this.players) {
        const sock = io.sockets.sockets.get(sid);
        if (sock) sock.emit('game-starting');
      }
    }
  }

  broadcastLobbyState() {
    if (!this.hostSocket) return;
    const lobbyPlayers = [];
    for (let player of this.players.values()) {
      lobbyPlayers.push({
        slotNumber: player.slotNumber,
        color: player.color,
        ready: this.readyPlayers.has(player.slotNumber)
      });
    }
    this.hostSocket.emit('lobby-update', { players: lobbyPlayers });
  }

  handleRestartVote(socketId) {
    const player = this.players.get(socketId);
    if (!player) return;
    this.restartVotes.add(player.slotNumber);
    console.log(`[ROOM ${this.roomCode}] Restart vote from Player ${player.slotNumber} (${this.restartVotes.size}/${this.players.size})`);
    for (let [sid, p] of this.players) {
      const sock = io.sockets.sockets.get(sid);
      if (sock) sock.emit('restart-vote-update', { votes: this.restartVotes.size, needed: this.players.size });
    }
    if (this.restartVotes.size >= this.players.size) {
      console.log(`[ROOM ${this.roomCode}] All voted YES - restarting!`);
      this.restartVotes.clear();
      this.readyPlayers.clear();
      this.gameStarted = false;
      if (this.hostSocket) this.hostSocket.emit('restart-game');
      for (let [sid] of this.players) {
        const sock = io.sockets.sockets.get(sid);
        if (sock) sock.emit('game-restarting');
      }
    }
  }

  // ── Phase 1: relay explosion events from host to all controllers ──────
  // Host sends { x, y, color } — server fans it out, clients render their own particles
  broadcastExplosion(data) {
    for (let [sid] of this.players) {
      const sock = io.sockets.sockets.get(sid);
      if (sock) sock.emit('explosion', data);
    }
  }

  broadcastGameState(gameState) {
    for (let [socketId, player] of this.players) {
      const socket = io.sockets.sockets.get(socketId);
      if (socket && player.connected) {
        const playerState = gameState.players ? gameState.players[player.slotNumber - 1] : null;
        if (playerState) {
          socket.emit('game-state-update', {
            health: playerState.health,
            ammo:   playerState.ammo === Infinity ? -1 : playerState.ammo,
            isAlive: playerState.isAlive,
            points: playerState.points,
            weapon: playerState.weapon,
            canUseMysteryBox: playerState.canUseMysteryBox,
            wave: gameState.wave || 1,
            zombiesRemaining: gameState.zombiesRemaining || 0,
            gameOver: gameState.gameOver || false
          });
        }
      }
    }
  }

  destroy() {
    for (let player of this.disconnectedPlayers.values()) {
      if (player.gracePeriodTimeout) clearTimeout(player.gracePeriodTimeout);
    }
    for (let player of this.players.values()) {
      if (player.heartbeatInterval) clearInterval(player.heartbeatInterval);
    }
    this.players.clear();
    this.disconnectedPlayers.clear();
    this.restartVotes.clear();
    this.readyPlayers.clear();
    console.log(`[ROOM ${this.roomCode}] Destroyed`);
  }
}

io.on('connection', (socket) => {
  console.log(`[SERVER] Connected: ${socket.id}`);

  socket.on('create-room', () => {
    const roomCode = GameRoom.generateRoomCode();
    const room     = new GameRoom(roomCode);
    gameRooms.set(roomCode, room);
    room.setHost(socket);
    socket.join(roomCode);
  });

  socket.on('join-room', (data) => {
    const { roomCode, deviceFingerprint } = data;
    const room = gameRooms.get(roomCode);
    if (!room) { socket.emit('join-failed', { reason: 'Room not found' }); return; }
    const playerData = room.addPlayer(socket, deviceFingerprint);
    if (!playerData) return;
    socket.join(roomCode);
    socket.emit('join-success', {
      slotNumber: playerData.slotNumber,
      color: playerData.color,
      deviceFingerprint: playerData.deviceFingerprint,
      roomCode
    });
    room.startHeartbeat(socket);
  });

  socket.on('player-ready',         (data) => { const r = gameRooms.get(data.roomCode); if (r) r.handleReady(socket.id); });
  socket.on('player-input',         (data) => { const r = gameRooms.get(data.roomCode); if (r) r.relayPlayerInput(socket.id, data.input); });
  socket.on('mystery-box-purchase', (data) => { const r = gameRooms.get(data.roomCode); if (r) r.handleMysteryBoxPurchase(data); });
  socket.on('restart-vote',         (data) => { const r = gameRooms.get(data.roomCode); if (r) r.handleRestartVote(socket.id); });
  socket.on('game-state-broadcast', (data) => { const r = gameRooms.get(data.roomCode); if (r) r.broadcastGameState(data.gameState); });

  // ── Phase 1: explosion relay ──────────────────────────────────────────
  socket.on('explosion', (data) => {
    const r = gameRooms.get(data.roomCode);
    if (r) r.broadcastExplosion({ x: data.x, y: data.y, color: data.color });
  });

  socket.on('pong', () => {
    for (let room of gameRooms.values()) {
      if (room.players.has(socket.id)) { room.updateLastPong(socket.id); break; }
    }
  });

  socket.on('disconnect', () => {
    console.log(`[SERVER] Disconnected: ${socket.id}`);
    for (let [roomCode, room] of gameRooms.entries()) {
      if (room.players.has(socket.id)) { room.handleDisconnect(socket.id); break; }
      if (room.hostSocket && room.hostSocket.id === socket.id) {
        room.destroy();
        gameRooms.delete(roomCode);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('============================================');
  console.log('  Zombie Survival Server — Phase 1');
  console.log('============================================');
  console.log(`  Port     : ${PORT}`);
  console.log(`  Transports: websocket only`);
  console.log(`  Deep link : /join/:roomCode`);
  console.log('============================================');
});
