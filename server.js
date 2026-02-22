const express  = require('express');
const http     = require('http');
const socketIo = require('socket.io');
const crypto   = require('crypto');
const path     = require('path');

const app    = express();
const server = http.createServer(app);

const io = socketIo(server, {
  transports: ['websocket'],
  cors: { origin: '*' }
});

// ── Landing page as root — MUST be before express.static ─────────────────
app.get('/', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'landing.html'));
});

// ── Health check endpoint — used by keep-alive pinger ────────────────────
app.get('/ping', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), ts: Date.now() });
});

app.use(express.static(path.join(__dirname)));

// ── Deep link: /join/:roomCode ────────────────────────────────────────────
app.get('/join/:roomCode', (req, res) => {
  const code = req.params.roomCode.toUpperCase();
  res.redirect(`/remote.html?room=${code}`);
});

// ================================================================
// SHARED GAME CONSTANTS (mirrored in client renderers)
// ================================================================
const TICK_RATE    = 60; // Hz — 60Hz for smooth interpolation on clients
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
  regular: { size: 28, color: '#00cc00', borderColor: '#00ff00', speed: 0.45, hp: 2,  points: 60,  weight: 70 },
  runner:  { size: 20, color: '#cccc00', borderColor: '#ffff00', speed: 0.9,  hp: 1,  points: 80,  weight: 20 },
  tank:    { size: 40, color: '#cc0000', borderColor: '#ff0000', speed: 0.25, hp: 8,  points: 150, weight: 10 }
};

const CANVAS_W         = 1334;
const CANVAS_H         = 750;
const PLAYER_SIZE      = 28;
const BULLET_SIZE      = 6;
const BULLET_SPEED     = 4;    // halved — tick rate doubled to 60Hz
const PLAYER_SPEED     = 1.25; // halved — tick rate doubled to 60Hz
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
const GRACE_PERIOD_MS  = 30000;
const HEARTBEAT_MS     = 2000;
const BOSS_RADIUS      = 90;
const BOSS_PAD         = BOSS_RADIUS + 35;
const REVIVE_RADIUS    = 40;
const REVIVE_TIME      = 3000;

// ================================================================
// SERVER-SIDE GAME ENGINE (Phase 2a)
// ================================================================
class ServerGame {
  constructor(room) {
    this.room       = room;
    this.players    = [];
    this.zombies    = [];
    this.bullets    = [];
    this.ammoPacks  = [];
    this.healthPacks = [];
    this.wave       = 1;
    this.waveTotal  = 0;
    this.waveKilled = 0;
    this.gameOver   = false;
    this.gameStarted = false;
    this.isBossWave = false;
    this.boss       = null;
    this.mysteryBox = null;
    this.reviveMap  = new Map();
    this.tickInterval = null;
    this.explosions = []; // queued this tick, sent then cleared

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
    // Clear any pending wave spawn timers to prevent stacking
    if (this._waveTimers) { this._waveTimers.forEach(t => clearTimeout(t)); }
    this._waveTimers = [];
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
    this.start();
  }

  _scheduleWave(fn, delay) {
    if (!this._waveTimers) this._waveTimers = [];
    const t = setTimeout(fn, delay);
    this._waveTimers.push(t);
    return t;
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
      this._scheduleWave(() => this.spawnBoss(), 2000);
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
        this._scheduleWave(() => this.spawnZombie(), i * 500);
      }
    }
  }

  getBossType() {
    const types = ['triangle','octagon','pentagon','diamond','spiral','fractal'];
    return types[Math.floor((this.wave / 5 - 1)) % types.length];
  }

  spawnBoss() {
    const type = this.getBossType();
    const base = {
      type, x: CANVAS_W/2, y: -120,
      dropping: true, dropTarget: CANVAS_H/2,
      vx: 3.5, vy: 2.5, rotation: 0, spinSpeed: 0.03,
      flashTimer: 0, dead: false, bossBullets: [], shootTimer: 0
    };
    if (type === 'triangle') {
      this.boss = { ...base, radius: 90, color: '#8844cc', pad: 125,
        tips: [{hp:5,maxHp:5},{hp:5,maxHp:5},{hp:5,maxHp:5}] };
    } else if (type === 'octagon') {
      this.boss = { ...base, radius: 80, color: '#ff6600', pad: 90,
        corners: Array.from({length:8}, () => ({hp:3,maxHp:3})), shootInterval: 60 };
    } else if (type === 'pentagon') {
      this.boss = { ...base, radius: 85, color: '#00aaff', pad: 110,
        panels: Array.from({length:5}, () => ({hp:4,maxHp:4})) };
    } else if (type === 'diamond') {
      this.boss = { ...base, radius: 75, color: '#ff44aa', pad: 85,
        coreHp: 20, coreMaxHp: 20, split: false, shards: [] };
    } else if (type === 'spiral') {
      this.boss = { ...base, radius: 70, color: '#44ffaa', pad: 140,
        arms: Array.from({length:5}, () => ({hp:4,maxHp:4})), breathe: 0 };
    } else {
      this.boss = { ...base, radius: 95, color: '#ffdd00', pad: 130,
        pieces: [{x:CANVAS_W/2,y:-120,rotation:0,vx:3.5,vy:2.5,hp:8,maxHp:8,radius:95,alive:true}] };
    }
  }

  getBossHitPoints() {
    if (!this.boss) return [];
    const b = this.boss;
    if (b.type === 'triangle') {
      return [0,1,2].map(i => {
        const a = b.rotation - Math.PI/2 + i*(2*Math.PI/3);
        return { x: b.x+Math.cos(a)*b.radius, y: b.y+Math.sin(a)*b.radius, idx: i };
      });
    }
    if (b.type === 'octagon') {
      return b.corners.map((c,i) => {
        const a = b.rotation+(i/8)*Math.PI*2;
        return { x: b.x+Math.cos(a)*b.radius, y: b.y+Math.sin(a)*b.radius, idx: i };
      });
    }
    if (b.type === 'pentagon') {
      return b.panels.map((p,i) => {
        const a = b.rotation+(i/5)*Math.PI*2+Math.PI/5;
        return { x: b.x+Math.cos(a)*b.radius*0.6, y: b.y+Math.sin(a)*b.radius*0.6, idx: i };
      });
    }
    if (b.type === 'diamond') {
      if (!b.split) return [{ x: b.x, y: b.y, idx: 0, core: true }];
      return b.shards.filter(s=>s.alive).map((s,i) => ({x:s.x,y:s.y,idx:i,shard:true}));
    }
    if (b.type === 'spiral') {
      return b.arms.map((arm,i) => {
        const ext = b.radius+60+Math.sin(b.breathe+i)*30;
        const a   = b.rotation+(i/5)*Math.PI*2;
        return { x: b.x+Math.cos(a)*ext, y: b.y+Math.sin(a)*ext, idx: i };
      });
    }
    if (b.type === 'fractal') {
      return b.pieces.filter(p=>p.alive).map((p,i) => ({x:p.x,y:p.y,idx:i,piece:true,radius:p.radius}));
    }
    return [];
  }

  // Legacy alias
  getBossTipPositions() { return this.getBossHitPoints(); }

  _bounceBox(b) {
    const pad = b.pad;
    b.x += b.vx; b.y += b.vy;
    if (b.x-pad<WALL)         { b.x=WALL+pad;         b.vx= Math.abs(b.vx); }
    if (b.x+pad>CANVAS_W-WALL){ b.x=CANVAS_W-WALL-pad; b.vx=-Math.abs(b.vx); }
    if (b.y-pad<WALL)         { b.y=WALL+pad;         b.vy= Math.abs(b.vy); }
    if (b.y+pad>CANVAS_H-WALL){ b.y=CANVAS_H-WALL-pad; b.vy=-Math.abs(b.vy); }
  }

  _bossKill(b) {
    b.dead = true;
    for (let p of this.players) {
      if (p.alive&&p.connected) { p.points+=1000; p.hp=p.maxHp; }
    }
    const dropCount = 4+Math.floor(Math.random()*4);
    for (let i=0;i<dropCount;i++) {
      const a=Math.random()*Math.PI*2, d=30+Math.random()*80;
      this.ammoPacks.push({x:b.x+Math.cos(a)*d, y:b.y+Math.sin(a)*d});
    }
    this.explosions.push({ x:b.x, y:b.y, color:b.color, big:true });
    this._scheduleWave(() => {
      this.boss=null; this.waveKilled=this.waveTotal; this.wave++;
      this._scheduleWave(() => this.startWave(), 3000);
    }, 800);
  }

  _bossTouchDamage(b, extraRadius=0) {
    const hs = PLAYER_SIZE/2;
    for (let p of this.players) {
      if (!p.alive||!p.connected) continue;
      const dx=p.x-b.x, dy=p.y-b.y;
      if (Math.sqrt(dx*dx+dy*dy)<b.radius+extraRadius+hs) {
        p.hp-=1;
        if (p.hp<=0&&p.alive){p.alive=false;p.hp=0;this.checkGameOver();}
      }
    }
  }

  updateBoss() {
    if (!this.boss) return;
    const b = this.boss;

    if (b.dropping) {
      b.y += 6; b.rotation += b.spinSpeed;
      if (b.y >= b.dropTarget) { b.y = b.dropTarget; b.dropping = false; }
      return;
    }

    if (b.flashTimer > 0) b.flashTimer--;

    // Boss bullets hit players
    for (let i = b.bossBullets.length-1; i >= 0; i--) {
      const bb = b.bossBullets[i];
      bb.x += bb.vx; bb.y += bb.vy; bb.life--;
      if (bb.life<=0||bb.x<0||bb.x>CANVAS_W||bb.y<0||bb.y>CANVAS_H) { b.bossBullets.splice(i,1); continue; }
      for (let p of this.players) {
        if (!p.alive||!p.connected) continue;
        const dx=p.x-bb.x,dy=p.y-bb.y;
        if (Math.sqrt(dx*dx+dy*dy)<PLAYER_SIZE/2+5) {
          p.hp-=bb.damage; b.bossBullets.splice(i,1);
          if (p.hp<=0&&p.alive){p.alive=false;p.hp=0;this.checkGameOver();}
          break;
        }
      }
    }

    if (b.type === 'triangle') {
      const tipsAlive = b.tips.filter(t=>t.hp>0).length;
      b.spinSpeed = 0.03+(3-tipsAlive)*0.025; b.rotation+=b.spinSpeed;
      this._bounceBox(b); this._bossTouchDamage(b);
      if (b.tips.every(t=>t.hp<=0)&&!b.dead) this._bossKill(b);

    } else if (b.type === 'octagon') {
      const alive = b.corners.filter(c=>c.hp>0).length;
      b.spinSpeed=0.02+(8-alive)*0.008; b.rotation+=b.spinSpeed;
      this._bounceBox(b); this._bossTouchDamage(b);
      b.shootTimer++;
      if (b.shootTimer>=b.shootInterval) {
        b.shootTimer=0;
        b.corners.forEach((c,i) => {
          if (c.hp<=0) return;
          const a=b.rotation+(i/8)*Math.PI*2;
          const cx=b.x+Math.cos(a)*b.radius, cy=b.y+Math.sin(a)*b.radius;
          b.bossBullets.push({x:cx,y:cy,vx:Math.cos(a)*3,vy:Math.sin(a)*3,damage:8,life:120,color:'#ff6600'});
        });
      }
      if (b.corners.every(c=>c.hp<=0)&&!b.dead) this._bossKill(b);

    } else if (b.type === 'pentagon') {
      const alive = b.panels.filter(p=>p.hp>0).length;
      b.spinSpeed=0.04+(5-alive)*0.022; b.rotation+=b.spinSpeed;
      this._bounceBox(b); this._bossTouchDamage(b);
      if (b.panels.every(p=>p.hp<=0)&&!b.dead) this._bossKill(b);

    } else if (b.type === 'diamond') {
      b.rotation+=0.025;
      if (!b.split) {
        this._bounceBox(b); this._bossTouchDamage(b);
        if (b.coreHp<=0&&!b.dead) {
          b.split=true;
          const dirs=[0,Math.PI/2,Math.PI,Math.PI*1.5];
          b.shards=dirs.map(a=>({
            x:b.x+Math.cos(a)*40, y:b.y+Math.sin(a)*40,
            vx:Math.cos(a)*2.5, vy:Math.sin(a)*2.5,
            rotation:0, hp:6, maxHp:6, alive:true, radius:38, pad:48
          }));
        }
      } else {
        for (let s of b.shards) {
          if (!s.alive) continue;
          s.rotation+=0.04; s.x+=s.vx; s.y+=s.vy;
          if (s.x-s.pad<WALL)         {s.x=WALL+s.pad;         s.vx= Math.abs(s.vx);}
          if (s.x+s.pad>CANVAS_W-WALL){s.x=CANVAS_W-WALL-s.pad; s.vx=-Math.abs(s.vx);}
          if (s.y-s.pad<WALL)         {s.y=WALL+s.pad;         s.vy= Math.abs(s.vy);}
          if (s.y+s.pad>CANVAS_H-WALL){s.y=CANVAS_H-WALL-s.pad; s.vy=-Math.abs(s.vy);}
          for (let p of this.players) {
            if (!p.alive||!p.connected) continue;
            const dx=p.x-s.x,dy=p.y-s.y;
            if (Math.sqrt(dx*dx+dy*dy)<s.radius+PLAYER_SIZE/2){
              p.hp-=0.8; if (p.hp<=0&&p.alive){p.alive=false;p.hp=0;this.checkGameOver();}
            }
          }
        }
        b.x=b.shards.reduce((s,sh)=>s+sh.x,0)/4;
        b.y=b.shards.reduce((s,sh)=>s+sh.y,0)/4;
        if (b.shards.every(s=>!s.alive)&&!b.dead) this._bossKill(b);
      }

    } else if (b.type === 'spiral') {
      b.breathe+=0.05; b.rotation+=0.02;
      this._bounceBox(b); this._bossTouchDamage(b,10);
      b.shootTimer++;
      if (b.shootTimer>=40) {
        b.shootTimer=0;
        for (let i=0;i<5;i++) {
          const a=b.rotation+(i/5)*Math.PI*2;
          b.bossBullets.push({x:b.x,y:b.y,vx:Math.cos(a)*3.5,vy:Math.sin(a)*3.5,damage:10,life:100,color:'#44ffaa'});
        }
      }
      if (b.arms.every(a=>a.hp<=0)&&!b.dead) this._bossKill(b);

    } else if (b.type === 'fractal') {
      for (let piece of b.pieces) {
        if (!piece.alive) continue;
        piece.rotation+=0.03; piece.x+=piece.vx; piece.y+=piece.vy;
        const pad=piece.radius+10;
        if (piece.x-pad<WALL)         {piece.x=WALL+pad;         piece.vx= Math.abs(piece.vx);}
        if (piece.x+pad>CANVAS_W-WALL){piece.x=CANVAS_W-WALL-pad; piece.vx=-Math.abs(piece.vx);}
        if (piece.y-pad<WALL)         {piece.y=WALL+pad;         piece.vy= Math.abs(piece.vy);}
        if (piece.y+pad>CANVAS_H-WALL){piece.y=CANVAS_H-WALL-pad; piece.vy=-Math.abs(piece.vy);}
        for (let p of this.players) {
          if (!p.alive||!p.connected) continue;
          const dx=p.x-piece.x,dy=p.y-piece.y;
          if (Math.sqrt(dx*dx+dy*dy)<piece.radius+PLAYER_SIZE/2){
            p.hp-=0.8; if (p.hp<=0&&p.alive){p.alive=false;p.hp=0;this.checkGameOver();}
          }
        }
        if (piece.hp<=0&&piece.alive) {
          piece.alive=false;
          this.explosions.push({x:piece.x,y:piece.y,color:'#ffdd00'});
          if (piece.radius>30) {
            for (let i=0;i<3;i++) {
              const a=(i/3)*Math.PI*2+Math.random()*0.5;
              const nr=Math.round(piece.radius*0.55);
              b.pieces.push({
                x:piece.x+Math.cos(a)*nr, y:piece.y+Math.sin(a)*nr,
                vx:Math.cos(a)*2+Math.random()-0.5, vy:Math.sin(a)*2+Math.random()-0.5,
                rotation:0, hp:Math.ceil(piece.maxHp*0.6), maxHp:Math.ceil(piece.maxHp*0.6),
                radius:nr, alive:true
              });
            }
          }
        }
      }
      const alive=b.pieces.filter(p=>p.alive);
      if (alive.length>0){ b.x=alive.reduce((s,p)=>s+p.x,0)/alive.length; b.y=alive.reduce((s,p)=>s+p.y,0)/alive.length; }
      if (b.pieces.every(p=>!p.alive)&&!b.dead) this._bossKill(b);
    }
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
          this.wave++; this._scheduleWave(() => this.startWave(), 3000);
        }
      }
    }

    if (this.boss && !this.boss.dead && !this.boss.dropping) {
      const pts = this.getBossHitPoints();
      for (let t = 0; t < pts.length; t++) {
        const pt = pts[t];
        const dx = pt.x - p.x, dy = pt.y - p.y;
        if (Math.sqrt(dx*dx+dy*dy) > MELEE_RANGE + 20) continue;
        let ad = Math.atan2(dy, dx) - p.angle;
        while (ad >  Math.PI) ad -= Math.PI*2;
        while (ad < -Math.PI) ad += Math.PI*2;
        if (Math.abs(ad) > MELEE_ARC/2) continue;
        this.boss.flashTimer = 6;
        if (this.boss.type==='triangle')      { this.boss.tips[pt.idx].hp=Math.max(0,this.boss.tips[pt.idx].hp-MELEE_DAMAGE); }
        else if (this.boss.type==='octagon')  { this.boss.corners[pt.idx].hp=Math.max(0,this.boss.corners[pt.idx].hp-MELEE_DAMAGE); }
        else if (this.boss.type==='pentagon') { this.boss.panels[pt.idx].hp=Math.max(0,this.boss.panels[pt.idx].hp-MELEE_DAMAGE); }
        else if (this.boss.type==='diamond')  {
          if (!this.boss.split) { this.boss.coreHp=Math.max(0,this.boss.coreHp-MELEE_DAMAGE); }
          else { const s=this.boss.shards[pt.idx]; if(s){s.hp=Math.max(0,s.hp-MELEE_DAMAGE);if(s.hp<=0)s.alive=false;} }
        }
        else if (this.boss.type==='spiral')   { this.boss.arms[pt.idx].hp=Math.max(0,this.boss.arms[pt.idx].hp-MELEE_DAMAGE); }
        else if (this.boss.type==='fractal')  { const alive=this.boss.pieces.filter(p=>p.alive); if(alive[pt.idx])alive[pt.idx].hp=Math.max(0,alive[pt.idx].hp-MELEE_DAMAGE); }
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
    this.explosions = []; // clear per-tick explosion queue

    const hs = PLAYER_SIZE / 2;

    // Players
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

    // Bullets
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
              this.wave++; this._scheduleWave(() => this.startWave(), 3000);
            }
          }
          break;
        }
      }
      if (hit) { this.bullets.splice(i, 1); continue; }

      if (this.boss && !this.boss.dead && !this.boss.dropping) {
        const pts = this.getBossHitPoints();
        for (let t = 0; t < pts.length; t++) {
          const pt = pts[t];
          const dx = b.x - pt.x, dy = b.y - pt.y;
          const hitR = pt.piece ? Math.min(pt.radius*0.6, 30) : 22;
          if (Math.sqrt(dx*dx+dy*dy) < hitR) {
            this.boss.flashTimer = 6; hit = true;
            if (this.boss.type==='triangle')      { this.boss.tips[pt.idx].hp=Math.max(0,this.boss.tips[pt.idx].hp-b.damage); }
            else if (this.boss.type==='octagon')  { this.boss.corners[pt.idx].hp=Math.max(0,this.boss.corners[pt.idx].hp-b.damage); }
            else if (this.boss.type==='pentagon') { this.boss.panels[pt.idx].hp=Math.max(0,this.boss.panels[pt.idx].hp-b.damage); }
            else if (this.boss.type==='diamond')  {
              if (!this.boss.split) { this.boss.coreHp=Math.max(0,this.boss.coreHp-b.damage); }
              else { const s=this.boss.shards[pt.idx]; if(s){s.hp=Math.max(0,s.hp-b.damage);if(s.hp<=0)s.alive=false;} }
            }
            else if (this.boss.type==='spiral')   { this.boss.arms[pt.idx].hp=Math.max(0,this.boss.arms[pt.idx].hp-b.damage); }
            else if (this.boss.type==='fractal')  { const alive=this.boss.pieces.filter(p=>p.alive); if(alive[pt.idx])alive[pt.idx].hp=Math.max(0,alive[pt.idx].hp-b.damage); }
            this.bullets.splice(i, 1); break;
          }
        }
      }
      if (hit) this.bullets.splice(i, 1);
    }

    // Zombies move + attack
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

    // Ammo pickups
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

    // Health pickups
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

    // Broadcast state to all clients in room
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
      bullets: this.bullets.map(b => ({ x: b.x, y: b.y, color: b.color })),
      ammoPacks:   this.ammoPacks.map(a => ({ x: a.x, y: a.y })),
      healthPacks: this.healthPacks.map(h => ({ x: h.x, y: h.y })),
      mysteryBox: this.mysteryBox ? { x: this.mysteryBox.x, y: this.mysteryBox.y } : null,
      boss: this.boss ? {
        type: this.boss.type,
        x: this.boss.x, y: this.boss.y,
        rotation: this.boss.rotation, radius: this.boss.radius,
        color: this.boss.color, dropping: this.boss.dropping,
        flashTimer: this.boss.flashTimer, dead: this.boss.dead,
        pad: this.boss.pad,
        // triangle
        tips: this.boss.tips,
        // octagon
        corners: this.boss.corners,
        // pentagon
        panels: this.boss.panels,
        // diamond
        coreHp: this.boss.coreHp, coreMaxHp: this.boss.coreMaxHp,
        split: this.boss.split, shards: this.boss.shards,
        // spiral
        arms: this.boss.arms, breathe: this.boss.breathe,
        // fractal
        pieces: this.boss.pieces,
        // boss bullets
        bossBullets: this.boss.bossBullets,
      } : null,
      reviveMap: Array.from(this.reviveMap.entries()),
      wave: this.wave, gameOver: this.gameOver,
      isBossWave: this.isBossWave,
      explosions: this.explosions
    };
  }
}

// ================================================================
// GAME ROOM — handles both Local and Remote modes
// ================================================================
class GameRoom {
  constructor(roomCode, mode = 'local') {
    this.roomCode  = roomCode;
    this.mode      = mode; // 'local' or 'remote'
    this.hostSocket = null;
    this.players   = new Map();
    this.disconnectedPlayers = new Map();
    this.restartVotes = new Set();
    this.readyPlayers = new Set();
    this.gameStarted  = false;
    this.serverGame   = null; // only used in remote mode
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

  // Broadcast to all connected players
  broadcast(event, data) {
    for (let [sid] of this.players) {
      const sock = io.sockets.sockets.get(sid);
      if (sock) sock.emit(event, data);
    }
    if (this.hostSocket) this.hostSocket.emit(event, data);
  }

  // Broadcast game state — remote sends to all players, local sends to host
  broadcastGameState(game) {
    const state = game.getState();
    if (this.mode === 'remote') {
      for (let [sid, player] of this.players) {
        const sock = io.sockets.sockets.get(sid);
        if (sock) sock.emit('remote-game-state', state);
      }
    } else {
      // Local mode: send full state to host for rendering
      if (this.hostSocket) this.hostSocket.emit('remote-game-state', state);
      // Send per-player HUD state to each controller
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
    // Also check if fingerprint matches a currently connected player (tab refresh mid-game)
    if (deviceFingerprint && this.gameStarted) {
      for (let [sid, p] of this.players) {
        if (p.deviceFingerprint === deviceFingerprint) {
          // Same person, new socket — update their socket
          this.players.delete(sid);
          const updated = { ...p, socketId: socket.id, connected: true, lastPong: Date.now() };
          this.players.set(socket.id, updated);
          if (this.serverGame) this.serverGame.players[p.slotNumber-1].connected = true;
          return updated;
        }
      }
    }
    const slotNumber = this.findAvailableSlot();
    if (slotNumber === null) { socket.emit('join-failed', { reason: 'Room is full' }); return null; }
    const playerData = {
      socketId: socket.id, slotNumber,
      color: PLAYER_COLORS[slotNumber - 1],
      connected: true, lastPong: Date.now(),
      deviceFingerprint: deviceFingerprint || socket.id  // use provided fp, fall back to socket.id
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
    this.disconnectedPlayers.set(player.deviceFingerprint, { ...player, connected: false });
    this.players.delete(socketId);
    this.restartVotes.delete(player.slotNumber);
    this.readyPlayers.delete(player.slotNumber);
    // Cancel ready countdown if a player drops out before game starts
    if (!this.gameStarted && this._readyCountdownInterval) {
      clearInterval(this._readyCountdownInterval);
      this._readyCountdownInterval = null;
      this.broadcast('ready-countdown-cancelled');
      if (this.hostSocket) this.hostSocket.emit('ready-countdown-cancelled');
    }
    if (this.hostSocket) this.hostSocket.emit('player-disconnected', { slotNumber: player.slotNumber });
    if (this.serverGame) this.serverGame.players[player.slotNumber-1].connected = false;
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
      if (Date.now() - player.lastPong > HEARTBEAT_MS * 2) {
        clearInterval(interval); this.handleDisconnect(socket.id);
      }
    }, HEARTBEAT_MS);
    const player = this.players.get(socket.id);
    if (player) player.heartbeatInterval = interval;
  }

  updateLastPong(socketId) {
    const p = this.players.get(socketId);
    if (p) p.lastPong = Date.now();
  }

  relayPlayerInput(socketId, input) {
    const player = this.players.get(socketId);
    if (!player) return;
    if (this.mode === 'remote' && this.serverGame) {
      this.serverGame.handleInput(player.slotNumber, input);
    } else if (this.hostSocket) {
      this.hostSocket.emit('player-input', { slotNumber: player.slotNumber, input });
    }
  }

  handleMysteryBox(socketId) {
    const player = this.players.get(socketId);
    if (!player) return;
    if (this.mode === 'remote' && this.serverGame) {
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
      // Start a 5s countdown — latecomers can still join and reset it
      this._startReadyCountdown();
    }
  }

  _startReadyCountdown() {
    // Cancel any existing countdown
    if (this._readyCountdownInterval) {
      clearInterval(this._readyCountdownInterval);
      this._readyCountdownInterval = null;
    }
    let timeLeft = 5;
    this.broadcast('ready-countdown', { seconds: timeLeft });
    if (this.hostSocket) this.hostSocket.emit('ready-countdown', { seconds: timeLeft });

    this._readyCountdownInterval = setInterval(() => {
      // If someone new joined and not everyone is ready, cancel
      if (this.readyPlayers.size < this.players.size) {
        clearInterval(this._readyCountdownInterval);
        this._readyCountdownInterval = null;
        this.broadcast('ready-countdown-cancelled');
        if (this.hostSocket) this.hostSocket.emit('ready-countdown-cancelled');
        return;
      }
      timeLeft--;
      this.broadcast('ready-countdown', { seconds: timeLeft });
      if (this.hostSocket) this.hostSocket.emit('ready-countdown', { seconds: timeLeft });

      if (timeLeft <= 0) {
        clearInterval(this._readyCountdownInterval);
        this._readyCountdownInterval = null;
        this.gameStarted = true;
        if (this.mode === 'remote') {
          if (!this.serverGame) this.serverGame = new ServerGame(this);
          for (let [, p] of this.players) {
            this.serverGame.players[p.slotNumber - 1].connected = true;
          }
          this.serverGame.gameStarted = true;
          this.serverGame.start();
          this.broadcast('game-starting-remote', { mode: 'remote' });
        } else {
          if (this.hostSocket) this.hostSocket.emit('all-ready');
          for (let [sid] of this.players) {
            const sock = io.sockets.sockets.get(sid);
            if (sock) sock.emit('game-starting');
          }
        }
      }
    }, 1000);
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
      if (this.mode === 'remote' && this.serverGame) {
        this.serverGame.restart();
        this.broadcast('game-restarting-remote', {});
      } else {
        if (this.hostSocket) this.hostSocket.emit('restart-game');
        this.broadcast('game-restarting', {});
      }
    }
  }

  broadcastExplosion(data) {
    this.broadcast('explosion', data);
    if (this.hostSocket) this.hostSocket.emit('explosion', data);
  }

  // Legacy local mode game state broadcast
  broadcastLocalGameState(gameState) {
    for (let [socketId, player] of this.players) {
      const socket = io.sockets.sockets.get(socketId);
      if (socket && player.connected) {
        const ps = gameState.players ? gameState.players[player.slotNumber - 1] : null;
        if (ps) socket.emit('game-state-update', {
          health: ps.health, ammo: ps.ammo === Infinity ? -1 : ps.ammo,
          isAlive: ps.isAlive, points: ps.points, weapon: ps.weapon,
          canUseMysteryBox: ps.canUseMysteryBox,
          wave: gameState.wave || 1, zombiesRemaining: gameState.zombiesRemaining || 0,
          gameOver: gameState.gameOver || false
        });
      }
    }
  }

  destroy() {
    if (this.serverGame) this.serverGame.stop();
    for (let p of this.disconnectedPlayers.values()) if (p.gracePeriodTimeout) clearTimeout(p.gracePeriodTimeout);
    for (let p of this.players.values()) if (p.heartbeatInterval) clearInterval(p.heartbeatInterval);
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

  // Local mode: host creates room
  socket.on('create-room', () => {
    const roomCode = GameRoom.generateRoomCode();
    const room = new GameRoom(roomCode, 'local');
    gameRooms.set(roomCode, room);
    room.setHost(socket);
    socket.join(roomCode);
  });

  // Remote mode: first player creates room, becomes player 1
  socket.on('create-remote-room', () => {
    const roomCode = GameRoom.generateRoomCode();
    const room = new GameRoom(roomCode, 'remote');
    gameRooms.set(roomCode, room);
    room.serverGame = new ServerGame(room);
    socket.join(roomCode);
    const playerData = room.addPlayer(socket, socket.id);
    if (!playerData) return;
    socket.emit('join-success', {
      slotNumber: playerData.slotNumber, color: playerData.color,
      deviceFingerprint: socket.id, roomCode, mode: 'remote'
    });
    // socket.io built-in ping handles connection monitoring
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
    // socket.io built-in ping handles connection monitoring
  });

  socket.on('player-ready',         (data) => { const r = gameRooms.get(data.roomCode); if (r) r.handleReady(socket.id); });
  socket.on('player-input',         (data) => { const r = gameRooms.get(data.roomCode); if (r) r.relayPlayerInput(socket.id, data.input); });
  socket.on('mystery-box-purchase', (data) => { const r = gameRooms.get(data.roomCode); if (r) r.handleMysteryBox(socket.id); });
  socket.on('restart-vote',         (data) => { const r = gameRooms.get(data.roomCode); if (r) r.handleRestartVote(socket.id); });
  socket.on('restart-vote-remote',  (data) => { const r = gameRooms.get(data.roomCode); if (r) r.handleRestartVote(socket.id); });

  // Local mode: host broadcasts game state to players
  socket.on('game-state-broadcast', (data) => {
    const r = gameRooms.get(data.roomCode);
    if (r) r.broadcastLocalGameState(data.gameState);
  });

  socket.on('explosion', (data) => {
    const r = gameRooms.get(data.roomCode);
    if (r) r.broadcastExplosion({ x: data.x, y: data.y, color: data.color });
  });

  // Latency measurement ping — client shows live ms display
  socket.on('ping-measure', () => socket.emit('pong-ack'));

  socket.on('disconnect', () => {
    console.log(`[SERVER] Disconnected: ${socket.id}`);
    for (let [roomCode, room] of gameRooms.entries()) {
      if (room.players.has(socket.id)) { room.handleDisconnect(socket.id); break; }
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
