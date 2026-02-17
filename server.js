
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static(path.join(__dirname, 'public')));

const MAX_PLAYERS = 4;
const PLAYER_COLORS = ['#00ff00', '#ff4444', '#4488ff', '#ffff00'];
const HEARTBEAT_INTERVAL_MS = 2000;
const GRACE_PERIOD_MS = 10000;
const gameRooms = new Map();

class GameRoom {
  constructor(roomCode) {
    this.roomCode = roomCode;
    this.hostSocket = null;
    this.players = new Map();
    this.disconnectedPlayers = new Map();
    this.restartVotes = new Set();
    this.readyPlayers = new Set(); // Tracks who has hit READY
    this.gameStarted = false;
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

    // Tell everyone the updated lobby state
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

  // ── READY UP SYSTEM ───────────────────────────────────────────────
  // When a player hits READY, add their slot to the ready set
  // Once everyone is ready, start the 3 second countdown on host

  handleReady(socketId) {
    const player = this.players.get(socketId);
    if (!player || this.gameStarted) return;

    this.readyPlayers.add(player.slotNumber);
    console.log(`[ROOM ${this.roomCode}] Player ${player.slotNumber} is READY (${this.readyPlayers.size}/${this.players.size})`);

    // Tell host to update lobby display
    this.broadcastLobbyState();

    // Check if everyone is ready
    if (this.readyPlayers.size >= this.players.size && this.players.size >= 1) {
      this.gameStarted = true;
      console.log(`[ROOM ${this.roomCode}] All players ready - starting countdown!`);

      // Tell host to start countdown
      if (this.hostSocket) this.hostSocket.emit('all-ready');

      // Tell all controllers game is starting
      for (let [sid] of this.players) {
        const sock = io.sockets.sockets.get(sid);
        if (sock) sock.emit('game-starting');
      }
    }
  }

  // Send current lobby state to host for display
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

  // ── RESTART VOTE SYSTEM ───────────────────────────────────────────

  handleRestartVote(socketId) {
    const player = this.players.get(socketId);
    if (!player) return;

    this.restartVotes.add(player.slotNumber);
    console.log(`[ROOM ${this.roomCode}] Restart vote from Player ${player.slotNumber} (${this.restartVotes.size}/${this.players.size})`);

    for (let [sid, p] of this.players) {
      const sock = io.sockets.sockets.get(sid);
      if (sock) {
        sock.emit('restart-vote-update', {
          votes: this.restartVotes.size,
          needed: this.players.size
        });
      }
    }

    if (this.restartVotes.size >= this.players.size) {
      console.log(`[ROOM ${this.roomCode}] All players voted YES - restarting!`);
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

  broadcastGameState(gameState) {
    for (let [socketId, player] of this.players) {
      const socket = io.sockets.sockets.get(socketId);
      if (socket && player.connected) {
        const playerState = gameState.players ? gameState.players[player.slotNumber - 1] : null;
        if (playerState) {
          socket.emit('game-state-update', {
            health: playerState.health,
            ammo: playerState.ammo,
            isAlive: playerState.isAlive,
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
    const room = new GameRoom(roomCode);
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

  // Player hits READY button
  socket.on('player-ready', (data) => {
    const room = gameRooms.get(data.roomCode);
    if (room) room.handleReady(socket.id);
  });

  socket.on('player-input', (data) => {
    const room = gameRooms.get(data.roomCode);
    if (room) room.relayPlayerInput(socket.id, data.input);
  });

  socket.on('restart-vote', (data) => {
    const room = gameRooms.get(data.roomCode);
    if (room) room.handleRestartVote(socket.id);
  });

  socket.on('game-state-broadcast', (data) => {
    const room = gameRooms.get(data.roomCode);
    if (room) room.broadcastGameState(data.gameState);
  });

  socket.on('pong', () => {
    for (let room of gameRooms.values()) {
      if (room.players.has(socket.id)) { room.updateLastPong(socket.id); break; }
    }
  });

  socket.on('disconnect', () => {
    console.log(`[SERVER] Disconnected: ${socket.id}`);
    for (let [roomCode, room] of gameRooms.entries()) {
      if (room.players.has(socket.id)) {
        room.handleDisconnect(socket.id);
        break;
      }
      if (room.hostSocket && room.hostSocket.id === socket.id) {
        room.destroy();
        gameRooms.delete(roomCode);
      }
    }
  });
});

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('============================================');
  console.log('  Zombie Survival Server Running');
  console.log('============================================');
  console.log(`  Host URL    : http://localhost:${PORT}`);
  console.log(`  Controller  : http://YOUR-IP:${PORT}/controller.html`);
  console.log('============================================');
});