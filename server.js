server
const express  = require('express');
const http     = require('http');
const socketIo = require('socket.io');
const crypto   = require('crypto');
const path     = require('path');

const app    = express();
const server = http.createServer(app);

const io = socketIo(server, {
  transports: ['websocket'],
  // LAG FIX 1: Tune socket.io for low latency
  pingInterval: 5000,
  pingTimeout:  10000,
  cors: { origin: '*' }
});

app.get('/', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'landing.html'));
});

app.use(express.static(path.join(__dirname)));

app.get('/join/:roomCode', (req, res) => {
  const code = req.params.roomCode.toUpperCase();
  res.redirect(`/remote.html?room=${code}`);
});

// ================================================================
// CONSTANTS
// ================================================================
const TICK_RATE    = 30;
const TICK_MS      = 1000 / TICK_RATE;

const WEAPONS = {
  pistol:     { damage: 1,  fireRate: 10, ammoCapacity: 30  },
  smg:        { damage: 1,  fireRate: 5,  ammoCapacity: 60,  rarity: 'common'    },
  shotgun:    { damage: 3,  fireRate: 20, ammoCapacity: 24,  rarity: 'common'    },
  ar:         { damage: 2,  fireRate: 7,  ammoCapacity: 45,  rarity: 'rare'      },
  lmg:        { damage: 2,  fireRate: 8,  ammoCapacity: 100, rarity: 'rare'      },
  raygun:     { damage: 5,  fireRate: 12, ammoCapacity: 20,  rarity: 'legendary' },
  thundergun: { damage: 10, fireRate: 30, ammoCapacity: 8,   rarity: 'legendary' }
};

const ZOMBIE_TYPES = {
  regular: { size: 28, color: '#00cc00', borderColor: '#00ff00', speed: 0.9, hp: 2,  points: 60,  weight: 70 },
  runner:  { size: 20, color: '#cccc00', borderColor: '#ffff00', speed: 1.8, hp: 1,  points: 80,  weight: 20 },
  tank:    { size: 40, color: '#cc0000', borderColor: '#ff0000', speed: 0.5, hp: 8,  points: 150, weight: 10 }
};

const CANVAS_W         = 1334;
const CANVAS_H         = 750;
const PLAYER_SIZE      = 28;
const BULLET_SIZE      = 6;
const BULLET_SPEED     = 8;
const PLAYER_SPEED     = 2.5;
const AMMO_DROP_CHANCE = 0.3;
const HEALTH_DROP_CHANCE = 0.08;
const MYSTERY_BOX_COST = 950;
const BOX_USE_RANGE    = 60;
const MELEE_DAMAGE     = 1;
const MELEE_RANGE      = 55;
const MELEE_ARC        = Math.PI * 0.6;
const WALL             = 6;
const MAX_PLAYERS      = 4;
const PLAYER_COLORS    = ['#00ffff', '#ff44ff', '#4488ff', '#ffff00'];
const GRACE_PERIOD_MS  = 15000;
const BOSS_RADIUS      = 90;
const BOSS_PAD         = BOSS_RADIUS + 35;
const REVIVE_RADIUS    = 40;
const REVIVE_TIME      = 3000;

// ================================================================
// SERVER-SIDE GAME ENGINE
// ================================================================
class ServerGame {
  constructor(room) {
    this.room        = room;
    this.players     = [];
    this.zombies     = [];
    this.bullets     = [];
    this.ammoPacks   = [];
    this.healthPacks = [];
    this.wave        = 1;
    this.waveTotal   = 0;
    this.waveKilled  = 0;
    this.gameOver    = false;
    this.gameStarted = false;
    this.isBossWave  = false;
    this.boss        = null;
    this.mysteryBox  = null;
    this.reviveMap   = new Map();
    this.tickInterval = null;
    this.explosions  = [];

    const spawns = [
      { x: 80,   y: 80  }, { x: 1254, y: 80  },
      { x: 80,   y: 670 }, { x: 1254, y: 670 }
    ];
    for (let i = 0; i < MAX_PLAYERS; i++) {
      this.players[i] = {
        slot: i + 1, x: spawns[i].x, y: spawns[i].y,
        vx: 0, vy: 0, angle: 0,
        color: PLAYER_COLORS[i],
        hp: 100, maxHp: 100,
        ammo: 30, points: 0,
        currentWeapon: 'pistol',
        alive: true, connected: false,
        firing: false, fireCooldown: 0,
        meleeing: false, meleeCooldown: 0,
        savedAmmo: undefined
      };
    }
  }

  start() {
    this.spawnMysteryBox();
    this.startWave();
    this.tickInterval = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    if (this.tickInterval) { clearInterval(this.tickInterval); this.tickInterval = null; }
  }

  restart() {
    this.stop();
    this.zombies = []; this.bullets = []; this.ammoPacks = []; this.healthPacks = [];
    this.wave = 1; this.waveTotal = 0; this.waveKilled = 0;
    this.gameOver = false; this.isBossWave = false; this.boss = null;
    this.reviveMap.clear(); this.explosions = [];
    const spawns = [
      { x: 80, y: 80 }, { x: 1254, y: 80 },
      { x: 80, y: 670 }, { x: 1254, y: 670 }
    ];
    for (let p of this.players) {
      p.x = spawns[p.slot-1].x; p.y = spawns[p.slot-1].y;
      p.vx = 0; p.vy = 0; p.angle = 0;
      p.hp = 100; p.ammo = 30; p.points = 0;
      p.currentWeapon = 'pistol'; p.alive = true;
      p.firing = false; p.fireCooldown = 0;
      p.meleeing = false; p.meleeCooldown = 0;
      p.savedAmmo = undefined;
    }
    this.spawnMysteryBox();
    this.gameStarted = true;
    this.start();
  }

  handleInput(slot, input) {
    const p = this.players[slot - 1];
    if (!p || !p.alive) return;
    if (input.angle !== null && input.angle !== undefined) {
      p.vx = Math.cos(input.angle) * PLAYER_SPEED;
      p.vy = Math.sin(input.angle) * PLAYER_SPEED;
      p.angle = input.angle;
    } else { p.vx = 0; p.vy = 0; }
    p.firing   = !!input.fire;
    p.meleeing = !!input.melee;
  }

  handleMysteryBox(slot) {
    const p = this.players[slot - 1];
    if (!p || !p.alive || !this.mysteryBox) return;
    const dx = p.x - this.mysteryBox.x, dy = p.y - this.mysteryBox.y;
    if (Math.sqrt(dx*dx+dy*dy) > BOX_USE_RANGE || p.points < MYSTERY_BOX_COST) return;
    p.points -= MYSTERY_BOX_COST;
    const weapon = this.rollRandomWeapon();
    p.currentWeapon = weapon;
    p.ammo = WEAPONS[weapon].ammoCapacity;
    setTimeout(() => this.spawnMysteryBox(), 1000);
  }

  rollRandomWeapon() {
    const roll = Math.random() * 100;
    if (roll < 10) {
      const l = Object.keys(WEAPONS).filter(k => WEAPONS[k].rarity === 'legendary');
      return l[Math.floor(Math.random() * l.length)];
    } else if (roll < 40) {
      const r = Object.keys(WEAPONS).filter(k => WEAPONS[k].rarity === 'rare');
      return r[Math.floor(Math.random() * r.length)];
    }
    const c = Object.keys(WEAPONS).filter(k => WEAPONS[k].rarity === 'common');
    return c[Math.floor(Math.random() * c.length)];
  }

  spawnMysteryBox() {
    const margin = 100;
    this.mysteryBox = {
      x: margin + Math.random() * (CANVAS_W - margin * 2),
      y: margin + Math.random() * (CANVAS_H - margin * 2)
    };
  }

  startWave() {
    const playerCount = Math.max(1, this.players.filter(p => p.connected).length);
    this.waveKilled = 0;

    if (this.wave % 5 === 0) {
      this.isBossWave = true;
      this.waveTotal  = 1;
      for (let p of this.players) {
        if (!p.connected) continue;
        p.savedAmmo = p.ammo;
        p.ammo = Infinity;
      }
      this.room.broadcast('wave-event', { type: 'boss', wave: this.wave });
      setTimeout(() => this.spawnBoss(), 2000);
    } else {
      this.isBossWave = false;
      for (let p of this.players) {
        if (!p.connected) continue;
        if (p.savedAmmo !== undefined) {
          const weapon = WEAPONS[p.currentWeapon];
          p.ammo = Math.max(p.savedAmmo, Math.floor(weapon.ammoCapacity * 0.5));
          p.savedAmmo = undefined;
        }
      }
      const baseCount = 3 + (this.wave - 1) * 2;
      this.waveTotal  = Math.ceil(baseCount * (playerCount / 2));
      this.room.broadcast('wave-event', { type: 'normal', wave: this.wave });
      for (let i = 0; i < this.waveTotal; i++) {
        setTimeout(() => this.spawnZombie(), i * 500);
      }
    }
  }

  spawnBoss() {
    const bossHues = ['#8844cc','#cc4488','#4488cc','#44cc88','#cc8844','#cc4444','#44cccc'];
    this.boss = {
      x: CANVAS_W / 2, y: -120,
      dropping: true, dropTarget: CANVAS_H / 2,
      vx: 0, vy: 0, rotation: 0, spinSpeed: 0.03,
      radius: BOSS_RADIUS,
      color: bossHues[Math.floor(Math.random() * bossHues.length)],
      tips: [{ hp: 5, maxHp: 5 }, { hp: 5, maxHp: 5 }, { hp: 5, maxHp: 5 }],
      flashTimer: 0, dead: false
    };
  }

  updateBoss() {
    if (!this.boss) return;
    const b = this.boss;

    if (b.dropping) {
      b.y += 6; b.rotation += b.spinSpeed;
      if (b.y >= b.dropTarget) {
        b.y = b.dropTarget; b.dropping = false;
        b.vx = 3.5; b.vy = 2.5;
      }
      return;
    }

    const tipsAlive = b.tips.filter(t => t.hp > 0).length;
    b.spinSpeed = 0.03 + (3 - tipsAlive) * 0.025;
    b.rotation += b.spinSpeed;

    b.x += b.vx; b.y += b.vy;
    if (b.x - BOSS_PAD < WALL)            { b.x = WALL + BOSS_PAD;            b.vx =  Math.abs(b.vx); }
    if (b.x + BOSS_PAD > CANVAS_W - WALL) { b.x = CANVAS_W - WALL - BOSS_PAD; b.vx = -Math.abs(b.vx); }
    if (b.y - BOSS_PAD < WALL)            { b.y = WALL + BOSS_PAD;            b.vy =  Math.abs(b.vy); }
    if (b.y + BOSS_PAD > CANVAS_H - WALL) { b.y = CANVAS_H - WALL - BOSS_PAD; b.vy = -Math.abs(b.vy); }

    if (b.flashTimer > 0) b.flashTimer--;

    if (b.tips.every(t => t.hp <= 0) && !b.dead) {
      b.dead = true;
      for (let p of this.players) {
        if (p.alive && p.connected) { p.points += 1000; p.hp = p.maxHp; }
      }
      const dropCount = 4 + Math.floor(Math.random() * 4);
      for (let i = 0; i < dropCount; i++) {
        const angle = Math.random() * Math.PI * 2;
        const dist  = 30 + Math.random() * 80;
        this.ammoPacks.push({ x: b.x + Math.cos(angle)*dist, y: b.y + Math.sin(angle)*dist });
      }
      this.explosions.push({ x: b.x, y: b.y, color: b.color, big: true });
      setTimeout(() => {
        this.boss = null;
        this.waveKilled = this.waveTotal;
        this.wave++;
        setTimeout(() => this.startWave(), 3000);
      }, 800);
    }

    const hs = PLAYER_SIZE / 2;
    for (let p of this.players) {
      if (!p.alive || !p.connected) continue;
      const dx = p.x - b.x, dy = p.y - b.y;
      if (Math.sqrt(dx*dx+dy*dy) < b.radius + hs) {
        p.hp -= 1;
        if (p.hp <= 0 && p.alive) { p.alive = false; p.hp = 0; this.checkGameOver(); }
      }
    }
  }

  getBossTipPositions() {
    if (!this.boss) return [];
    const b = this.boss;
    return [0, 1, 2].map(i => {
      const a = b.rotation - Math.PI/2 + i * (2*Math.PI/3);
      return { x: b.x + Math.cos(a)*b.radius, y: b.y + Math.sin(a)*b.radius };
    });
  }

  spawnZombie() {
    const side = Math.floor(Math.random() * 4);
    let x, y;
    if      (side === 0) { x = Math.random()*CANVAS_W; y = -50; }
    else if (side === 1) { x = CANVAS_W+50; y = Math.random()*CANVAS_H; }
    else if (side === 2) { x = Math.random()*CANVAS_W; y = CANVAS_H+50; }
    else                 { x = -50; y = Math.random()*CANVAS_H; }
    const total = Object.values(ZOMBIE_TYPES).reduce((s,t) => s+t.weight, 0);
    let roll = Math.random() * total;
    let type = 'regular';
    for (let t in ZOMBIE_TYPES) { roll -= ZOMBIE_TYPES[t].weight; if (roll <= 0) { type = t; break; } }
    const td = ZOMBIE_TYPES[type];
    this.zombies.push({ x, y, type, hp: td.hp, maxHp: td.hp, speed: td.speed, size: td.size, color: td.color, borderColor: td.borderColor, points: td.points });
  }

  fireBullet(p) {
    const weapon = WEAPONS[p.currentWeapon];
    this.bullets.push({
      x: p.x + Math.cos(p.angle)*PLAYER_SIZE, y: p.y + Math.sin(p.angle)*PLAYER_SIZE,
      vx: Math.cos(p.angle)*BULLET_SPEED, vy: Math.sin(p.angle)*BULLET_SPEED,
      damage: weapon.damage, color: p.color
    });
    if (p.ammo !== Infinity) p.ammo--;
  }

  performMelee(p) {
    this.explosions.push({ x: p.x + Math.cos(p.angle)*MELEE_RANGE*0.5, y: p.y + Math.sin(p.angle)*MELEE_RANGE*0.5, color: p.color, melee: true, angle: p.angle });

    for (let j = this.zombies.length - 1; j >= 0; j--) {
      const z = this.zombies[j];
      const dx = z.x - p.x, dy = z.y - p.y;
      if (Math.sqrt(dx*dx+dy*dy) > MELEE_RANGE + z.size/2) continue;
      let ad = Math.atan2(dy, dx) - p.angle;
      while (ad >  Math.PI) ad -= Math.PI*2;
      while (ad < -Math.PI) ad += Math.PI*2;
      if (Math.abs(ad) > MELEE_ARC/2) continue;
      z.hp -= MELEE_DAMAGE;
      if (z.hp <= 0) {
        p.points += z.points;
        this.ammoPacks.push({ x: z.x, y: z.y });
        if (Math.random() < HEALTH_DROP_CHANCE) this.healthPacks.push({ x: z.x, y: z.y });
        this.explosions.push({ x: z.x, y: z.y, color: z.borderColor });
        this.zombies.splice(j, 1);
        this.waveKilled++;
        if (this.waveKilled >= this.waveTotal && this.zombies.length === 0 && !this.boss) {
          this.wave++; setTimeout(() => this.startWave(), 3000);
        }
      }
    }

    if (this.boss && !this.boss.dead && !this.boss.dropping) {
      const tips = this.getBossTipPositions();
      for (let t = 0; t < tips.length; t++) {
        if (this.boss.tips[t].hp <= 0) continue;
        const dx = tips[t].x - p.x, dy = tips[t].y - p.y;
        if (Math.sqrt(dx*dx+dy*dy) > MELEE_RANGE + 20) continue;
        let ad = Math.atan2(dy, dx) - p.angle;
        while (ad >  Math.PI) ad -= Math.PI*2;
        while (ad < -Math.PI) ad += Math.PI*2;
        if (Math.abs(ad) > MELEE_ARC/2) continue;
        this.boss.tips[t].hp -= MELEE_DAMAGE;
        this.boss.flashTimer = 6;
      }
    }
  }

  updateRevive() {
    const now = Date.now();
    for (let reviver of this.players) {
      if (!reviver.alive || !reviver.connected) { this.reviveMap.delete(reviver.slot); continue; }
      let found = false;
      for (let target of this.players) {
        if (target.alive || !target.connected || target === reviver) continue;
        const dx = target.x - reviver.x, dy = target.y - reviver.y;
        if (Math.sqrt(dx*dx+dy*dy) <= REVIVE_RADIUS) {
          found = true;
          const attempt = this.reviveMap.get(reviver.slot);
          if (!attempt || attempt.targetSlot !== target.slot) {
            this.reviveMap.set(reviver.slot, { targetSlot: target.slot, startTime: now });
          } else if (now - attempt.startTime >= REVIVE_TIME) {
            target.alive = true; target.hp = 50;
            this.reviveMap.delete(reviver.slot);
          }
          break;
        }
      }
      if (!found) this.reviveMap.delete(reviver.slot);
    }
  }

  checkGameOver() {
    if (!this.players.some(p => p.alive && p.connected)) {
      this.gameOver = true;
      this.room.broadcast('game-over', {});
    }
  }

  canUseMysteryBox(p) {
    if (!this.mysteryBox || !p.alive) return false;
    const dx = p.x - this.mysteryBox.x, dy = p.y - this.mysteryBox.y;
    return Math.sqrt(dx*dx+dy*dy) <= BOX_USE_RANGE;
  }

  tick() {
    if (this.gameOver || !this.gameStarted) return;
    this.explosions = [];

    const hs = PLAYER_SIZE / 2;

    for (let p of this.players) {
      if (!p.connected || !p.alive) continue;
      const clamp = hs + WALL;
      p.x = Math.max(clamp, Math.min(CANVAS_W - clamp, p.x + p.vx));
      p.y = Math.max(clamp, Math.min(CANVAS_H - clamp, p.y + p.vy));
      const weapon = WEAPONS[p.currentWeapon];
      p.fireCooldown--; p.meleeCooldown--;
      if (p.firing && (p.ammo > 0 || p.ammo === Infinity) && p.fireCooldown <= 0) {
        this.fireBullet(p); p.fireCooldown = weapon.fireRate;
      }
      if (p.meleeing && p.ammo === 0 && p.ammo !== Infinity && p.meleeCooldown <= 0) {
        this.performMelee(p); p.meleeCooldown = 1;
      }
    }

    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.x += b.vx; b.y += b.vy;
      if (b.x < 0 || b.x > CANVAS_W || b.y < 0 || b.y > CANVAS_H) { this.bullets.splice(i, 1); continue; }
      let hit = false;

      for (let j = this.zombies.length - 1; j >= 0; j--) {
        const z = this.zombies[j];
        const dx = b.x - z.x, dy = b.y - z.y;
        if (Math.sqrt(dx*dx+dy*dy) < z.size/2 + BULLET_SIZE/2) {
          z.hp -= b.damage; hit = true;
          if (z.hp <= 0) {
            let nearest = null, nearestDist = Infinity;
            for (let p of this.players) {
              if (!p.alive || !p.connected) continue;
              const d = Math.sqrt((p.x-z.x)**2 + (p.y-z.y)**2);
              if (d < nearestDist) { nearestDist = d; nearest = p; }
            }
            if (nearest) nearest.points += z.points;
            if (Math.random() < AMMO_DROP_CHANCE) this.ammoPacks.push({ x: z.x, y: z.y });
            if (Math.random() < HEALTH_DROP_CHANCE) this.healthPacks.push({ x: z.x, y: z.y });
            this.explosions.push({ x: z.x, y: z.y, color: z.borderColor });
            this.zombies.splice(j, 1);
            this.waveKilled++;
            if (this.waveKilled >= this.waveTotal && this.zombies.length === 0 && !this.boss) {
              this.wave++; setTimeout(() => this.startWave(), 3000);
            }
          }
          break;
        }
      }
      if (hit) { this.bullets.splice(i, 1); continue; }

      if (this.boss && !this.boss.dead && !this.boss.dropping) {
        const tips = this.getBossTipPositions();
        for (let t = 0; t < tips.length; t++) {
          const dx = b.x - tips[t].x, dy = b.y - tips[t].y;
          if (Math.sqrt(dx*dx+dy*dy) < 22 && this.boss.tips[t].hp > 0) {
            this.boss.tips[t].hp--; this.boss.flashTimer = 6;
            this.bullets.splice(i, 1); hit = true; break;
          }
        }
      }
      if (hit) this.bullets.splice(i, 1);
    }

    for (let z of this.zombies) {
      let nearest = null, nearestDist = Infinity;
      for (let p of this.players) {
        if (!p.alive || !p.connected) continue;
        const d = Math.sqrt((p.x-z.x)**2 + (p.y-z.y)**2);
        if (d < nearestDist) { nearestDist = d; nearest = p; }
      }
      if (!nearest) continue;
      const dx = nearest.x - z.x, dy = nearest.y - z.y;
      const dist = Math.sqrt(dx*dx+dy*dy);
      if (dist > 0) { z.x += (dx/dist)*z.speed; z.y += (dy/dist)*z.speed; }
      if (Math.sqrt((nearest.x-z.x)**2 + (nearest.y-z.y)**2) < z.size/2 + PLAYER_SIZE/2) {
        nearest.hp -= 0.5;
        if (nearest.hp <= 0 && nearest.alive) { nearest.alive = false; nearest.hp = 0; this.checkGameOver(); }
      }
    }

    for (let i = this.ammoPacks.length - 1; i >= 0; i--) {
      const a = this.ammoPacks[i];
      for (let p of this.players) {
        if (!p.alive) continue;
        if (Math.sqrt((p.x-a.x)**2 + (p.y-a.y)**2) < PLAYER_SIZE/2 + 10) {
          if (p.ammo !== Infinity) p.ammo += Math.floor(WEAPONS[p.currentWeapon].ammoCapacity * 0.5);
          this.ammoPacks.splice(i, 1); break;
        }
      }
    }

    for (let i = this.healthPacks.length - 1; i >= 0; i--) {
      const h = this.healthPacks[i];
      for (let p of this.players) {
        if (!p.alive) continue;
        if (Math.sqrt((p.x-h.x)**2 + (p.y-h.y)**2) < PLAYER_SIZE/2 + 10) {
          p.hp = Math.min(p.maxHp, p.hp + 30);
          this.healthPacks.splice(i, 1); break;
        }
      }
    }

    this.updateRevive();
    this.updateBoss();
    this.room.broadcastGameState(this);
  }

  getState() {
    return {
      players: this.players.map(p => ({
        slot: p.slot, x: p.x, y: p.y, angle: p.angle,
        color: p.color, hp: p.hp, maxHp: p.maxHp,
        ammo: p.ammo === Infinity ? -1 : p.ammo,
        points: p.points, weapon: p.currentWeapon,
        alive: p.alive, connected: p.connected,
        canUseMysteryBox: this.canUseMysteryBox(p)
      })),
      zombies: this.zombies.map(z => ({
        x: z.x, y: z.y, hp: z.hp, maxHp: z.maxHp,
        size: z.size, color: z.color, borderColor: z.borderColor
      })),
      // LAG FIX 2: Don't send bullets in state — they're too fast and small to need sync,
      // each client predicts them locally from explosion events
      ammoPacks:   this.ammoPacks.map(a => ({ x: a.x, y: a.y })),
      healthPacks: this.healthPacks.map(h => ({ x: h.x, y: h.y })),
      mysteryBox: this.mysteryBox ? { x: this.mysteryBox.x, y: this.mysteryBox.y } : null,
      boss: this.boss ? {
        x: this.boss.x, y: this.boss.y,
        rotation: this.boss.rotation, radius: this.boss.radius,
        color: this.boss.color, dropping: this.boss.dropping,
        tips: this.boss.tips, flashTimer: this.boss.flashTimer, dead: this.boss.dead
      } : null,
      wave: this.wave, gameOver: this.gameOver,
      isBossWave: this.isBossWave,
      explosions: this.explosions
    };
  }
}

// ================================================================
// GAME ROOM
// ================================================================
class GameRoom {
  constructor(roomCode, mode = 'local') {
    this.roomCode  = roomCode;
    this.mode      = mode;
    this.hostSocket = null;
    this.players   = new Map();
    this.disconnectedPlayers = new Map();
    this.restartVotes = new Set();
    this.readyPlayers = new Set();
    this.gameStarted  = false;
    this.serverGame   = null;
    console.log(`[ROOM ${roomCode}] Created (${mode} mode)`);
  }

  static generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code;
    do {
      const randomBytes = crypto.randomBytes(4);
      code = Array.from(randomBytes).map(b => chars[b % chars.length]).join('');
    } while (gameRooms.has(code));
    return code;
  }

  broadcast(event, data) {
    for (let [sid] of this.players) {
      const sock = io.sockets.sockets.get(sid);
      if (sock) sock.emit(event, data);
    }
    if (this.hostSocket) this.hostSocket.emit(event, data);
  }

  broadcastGameState(game) {
    const state = game.getState();
    if (this.mode === 'remote') {
      for (let [sid] of this.players) {
        const sock = io.sockets.sockets.get(sid);
        if (sock) sock.emit('remote-game-state', state);
      }
    } else {
      if (this.hostSocket) this.hostSocket.emit('remote-game-state', state);
      for (let [sid, player] of this.players) {
        const sock = io.sockets.sockets.get(sid);
        if (!sock) continue;
        const p = state.players[player.slotNumber - 1];
        if (p) sock.emit('game-state-update', {
          health: p.hp, ammo: p.ammo, points: p.points,
          weapon: p.weapon, isAlive: p.alive,
          canUseMysteryBox: p.canUseMysteryBox,
          wave: state.wave, gameOver: state.gameOver
        });
      }
    }
  }

  setHost(socket) {
    this.hostSocket = socket;
    socket.emit('room-created', { roomCode: this.roomCode, mode: this.mode });
    console.log(`[ROOM ${this.roomCode}] Host connected`);
  }

  findAvailableSlot() {
    for (let i = 1; i <= MAX_PLAYERS; i++) {
      if (!this.isSlotOccupied(i)) return i;
    }
    return null;
  }

  isSlotOccupied(slot) {
    for (let p of this.players.values()) if (p.slotNumber === slot && p.connected) return true;
    for (let p of this.disconnectedPlayers.values()) if (p.slotNumber === slot) return true;
    return false;
  }

  addPlayer(socket, deviceFingerprint = null) {
    if (deviceFingerprint && this.disconnectedPlayers.has(deviceFingerprint)) {
      return this.reconnectPlayer(socket, deviceFingerprint);
    }
    const slotNumber = this.findAvailableSlot();
    if (slotNumber === null) { socket.emit('join-failed', { reason: 'Room is full' }); return null; }
    const playerData = {
      socketId: socket.id, slotNumber,
      color: PLAYER_COLORS[slotNumber - 1],
      connected: true, lastPong: Date.now(),
      deviceFingerprint: deviceFingerprint || socket.id
    };
    this.players.set(socket.id, playerData);
    if (this.hostSocket) this.hostSocket.emit('player-joined', { slotNumber, color: playerData.color });
    this.broadcastLobbyState();
    if (this.serverGame) this.serverGame.players[slotNumber-1].connected = true;
    console.log(`[ROOM ${this.roomCode}] Player ${slotNumber} joined`);
    return playerData;
  }

  reconnectPlayer(socket, deviceFingerprint) {
    const dp = this.disconnectedPlayers.get(deviceFingerprint);
    if (!dp) return null;
    if (dp.gracePeriodTimeout) clearTimeout(dp.gracePeriodTimeout);
    const playerData = { ...dp, socketId: socket.id, connected: true, lastPong: Date.now() };
    this.players.set(socket.id, playerData);
    this.disconnectedPlayers.delete(deviceFingerprint);
    if (this.hostSocket) this.hostSocket.emit('player-reconnected', { slotNumber: playerData.slotNumber, color: playerData.color });
    if (this.serverGame) this.serverGame.players[playerData.slotNumber-1].connected = true;
    this.broadcastLobbyState();
    return playerData;
  }

  handleDisconnect(socketId) {
    const player = this.players.get(socketId);
    if (!player) return;
    this.disconnectedPlayers.set(player.deviceFingerprint, {
      ...player, connected: false,
      gracePeriodTimeout: setTimeout(() => {
        this.disconnectedPlayers.delete(player.deviceFingerprint);
        if (this.hostSocket) this.hostSocket.emit('player-removed', { slotNumber: player.slotNumber });
      }, GRACE_PERIOD_MS)
    });
    this.players.delete(socketId);
    this.restartVotes.delete(player.slotNumber);
    this.readyPlayers.delete(player.slotNumber);
    if (this.hostSocket) this.hostSocket.emit('player-disconnected', { slotNumber: player.slotNumber });
    if (this.serverGame) this.serverGame.players[player.slotNumber-1].connected = false;
    console.log(`[ROOM ${this.roomCode}] Player ${player.slotNumber} disconnected`);
  }

  relayPlayerInput(socketId, input) {
    const player = this.players.get(socketId);
    if (!player) return;
    if (this.serverGame) {
      this.serverGame.handleInput(player.slotNumber, input);
    } else if (this.hostSocket) {
      this.hostSocket.emit('player-input', { slotNumber: player.slotNumber, input });
    }
  }

  handleMysteryBox(socketId) {
    const player = this.players.get(socketId);
    if (!player) return;
    if (this.serverGame) {
      this.serverGame.handleMysteryBox(player.slotNumber);
    } else if (this.hostSocket) {
      this.hostSocket.emit('mystery-box-purchase', { slotNumber: player.slotNumber });
    }
  }

  handleReady(socketId) {
    const player = this.players.get(socketId);
    if (!player || this.gameStarted) return;
    this.readyPlayers.add(player.slotNumber);
    this.broadcastLobbyState();
    console.log(`[ROOM ${this.roomCode}] Player ${player.slotNumber} READY (${this.readyPlayers.size}/${this.players.size})`);
    if (this.readyPlayers.size >= this.players.size && this.players.size >= 1) {
      this.gameStarted = true;
      if (!this.serverGame) this.serverGame = new ServerGame(this);
      for (let [, p] of this.players) {
        this.serverGame.players[p.slotNumber - 1].connected = true;
      }
      this.serverGame.gameStarted = true;
      this.serverGame.start();
      if (this.mode === 'remote') {
        this.broadcast('game-starting-remote', { mode: 'remote' });
      } else {
        if (this.hostSocket) this.hostSocket.emit('all-ready');
        for (let [sid] of this.players) {
          const sock = io.sockets.sockets.get(sid);
          if (sock) sock.emit('game-starting');
        }
      }
    }
  }

  broadcastLobbyState() {
    const lobbyPlayers = [];
    for (let p of this.players.values()) {
      lobbyPlayers.push({ slotNumber: p.slotNumber, color: p.color, ready: this.readyPlayers.has(p.slotNumber) });
    }
    const data = { players: lobbyPlayers, mode: this.mode, roomCode: this.roomCode };
    if (this.hostSocket) this.hostSocket.emit('lobby-update', data);
    this.broadcast('lobby-update', data);
  }

  handleRestartVote(socketId) {
    const player = this.players.get(socketId);
    if (!player) return;
    this.restartVotes.add(player.slotNumber);
    this.broadcast('restart-vote-update', { votes: this.restartVotes.size, needed: this.players.size });
    if (this.restartVotes.size >= this.players.size) {
      this.restartVotes.clear(); this.readyPlayers.clear(); this.gameStarted = false;
      if (this.serverGame) {
        this.serverGame.restart();
        if (this.mode === 'remote') {
          this.broadcast('game-restarting-remote', {});
        } else {
          if (this.hostSocket) this.hostSocket.emit('restart-game');
          this.broadcast('game-restarting', {});
        }
      }
    }
  }

  broadcastLocalGameState(gameState) {
    for (let [socketId, player] of this.players) {
      const socket = io.sockets.sockets.get(socketId);
      if (socket && player.connected) {
        const ps = gameState.players ? gameState.players[player.slotNumber - 1] : null;
        if (ps) socket.emit('game-state-update', {
          health: ps.health, ammo: ps.ammo === Infinity ? -1 : ps.ammo,
          isAlive: ps.isAlive, points: ps.points, weapon: ps.weapon,
          canUseMysteryBox: ps.canUseMysteryBox,
          wave: gameState.wave || 1, gameOver: gameState.gameOver || false
        });
      }
    }
  }

  destroy() {
    if (this.serverGame) this.serverGame.stop();
    for (let p of this.disconnectedPlayers.values()) if (p.gracePeriodTimeout) clearTimeout(p.gracePeriodTimeout);
    this.players.clear(); this.disconnectedPlayers.clear();
    console.log(`[ROOM ${this.roomCode}] Destroyed`);
  }
}

// ================================================================
// SOCKET HANDLERS
// ================================================================
const gameRooms = new Map();

io.on('connection', (socket) => {
  console.log(`[SERVER] Connected: ${socket.id}`);

  socket.on('create-room', () => {
    const roomCode = GameRoom.generateRoomCode();
    const room = new GameRoom(roomCode, 'local');
    // LAG FIX 3: local mode now uses server-side game engine too
    room.serverGame = new ServerGame(room);
    gameRooms.set(roomCode, room);
    room.setHost(socket);
    socket.join(roomCode);
  });

  socket.on('create-remote-room', () => {
    const roomCode = GameRoom.generateRoomCode();
    const room = new GameRoom(roomCode, 'remote');
    room.serverGame = new ServerGame(room);
    gameRooms.set(roomCode, room);
    socket.join(roomCode);
    const playerData = room.addPlayer(socket, socket.id);
    if (!playerData) return;
    socket.emit('join-success', {
      slotNumber: playerData.slotNumber, color: playerData.color,
      deviceFingerprint: socket.id, roomCode, mode: 'remote'
    });
    console.log(`[ROOM ${roomCode}] Remote room created by Player 1`);
  });

  socket.on('join-room', (data) => {
    const { roomCode, deviceFingerprint } = data;
    const room = gameRooms.get(roomCode);
    if (!room) { socket.emit('join-failed', { reason: 'Room not found' }); return; }
    const playerData = room.addPlayer(socket, deviceFingerprint);
    if (!playerData) return;
    socket.join(roomCode);
    socket.emit('join-success', {
      slotNumber: playerData.slotNumber, color: playerData.color,
      deviceFingerprint: playerData.deviceFingerprint, roomCode, mode: room.mode
    });
  });

  socket.on('player-ready',         (data) => { const r = gameRooms.get(data.roomCode); if (r) r.handleReady(socket.id); });
  socket.on('player-input',         (data) => { const r = gameRooms.get(data.roomCode); if (r) r.relayPlayerInput(socket.id, data.input); });
  socket.on('mystery-box-purchase', (data) => { const r = gameRooms.get(data.roomCode); if (r) r.handleMysteryBox(socket.id); });
  socket.on('restart-vote',         (data) => { const r = gameRooms.get(data.roomCode); if (r) r.handleRestartVote(socket.id); });
  socket.on('restart-vote-remote',  (data) => { const r = gameRooms.get(data.roomCode); if (r) r.handleRestartVote(socket.id); });

  // LAG FIX 4: local mode still sends game-state-broadcast for controller HUD updates
  socket.on('game-state-broadcast', (data) => {
    const r = gameRooms.get(data.roomCode);
    if (r) r.broadcastLocalGameState(data.gameState);
  });

  socket.on('explosion', (data) => {
    const r = gameRooms.get(data.roomCode);
    if (r) r.broadcast('explosion', { x: data.x, y: data.y, color: data.color });
  });

  // LAG FIX 5: remove heartbeat polling — rely on socket.io's built-in ping/pong
  // instead of a custom heartbeat that adds overhead

  socket.on('disconnect', () => {
    console.log(`[SERVER] Disconnected: ${socket.id}`);
    for (let [roomCode, room] of gameRooms.entries()) {
      if (room.players.has(socket.id)) {
        room.handleDisconnect(socket.id);
        // Clean up empty rooms after grace period
        setTimeout(() => {
          if (room.players.size === 0 && !room.hostSocket) {
            room.destroy();
            gameRooms.delete(roomCode);
          }
        }, GRACE_PERIOD_MS + 1000);
        break;
      }
      if (room.hostSocket && room.hostSocket.id === socket.id) {
        room.destroy(); gameRooms.delete(roomCode); break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('============================================');
  console.log('  Z-TEAM Server — Phase 2a');
  console.log('============================================');
  console.log(`  Port      : ${PORT}`);
  console.log(`  Tick rate : ${TICK_RATE}Hz`);
  console.log(`  Modes     : local + remote`);
  console.log('============================================');
});
