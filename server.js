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

app.get('/', (req, res) => res.sendFile(path.resolve(__dirname, 'landing.html')));
app.get('/ping', (req, res) => res.json({ status: 'ok', uptime: process.uptime(), ts: Date.now() }));
app.use(express.static(path.join(__dirname)));
app.get('/join/:roomCode', (req, res) => res.redirect(`/remote.html?room=${req.params.roomCode.toUpperCase()}`));

// ================================================================
// SHARED GAME CONSTANTS
// ================================================================
const C = require('./shared/game-constants');
const {
  CANVAS_W, CANVAS_H, WALL,
  PLAYER_SIZE, PLAYER_COLORS, MAX_PLAYERS, PLAYER_SPAWNS,
  BULLET_SIZE,
  AMMO_DROP_CHANCE, HEALTH_DROP_CHANCE,
  MYSTERY_BOX_COST, BOX_USE_RANGE,
  VENDING_BASE_COST, VENDING_COST_STEP, VENDING_HEAL_AMOUNT, VENDING_USE_RANGE,
  MELEE_DAMAGE, MELEE_RANGE, MELEE_ARC,
  REVIVE_RADIUS, REVIVE_TIME,
  BOSS_TYPES, BOSS_CONFIGS,
  GRACE_PERIOD_MS, HEARTBEAT_MS,
  WEAPONS, ZOMBIE_TYPES,
  BOMBER_BLAST_RADIUS, BOMBER_PLAYER_DAMAGE, BOMBER_CHAIN_DEPTH
} = C;

// Server-only: halved speeds because server runs at 60Hz tick (not 60fps rAF)
const TICK_RATE      = 60;
const TICK_MS        = 1000 / TICK_RATE;
const BROADCAST_RATE = 20;  // FIX LAG: broadcast state at 20Hz, logic at 60Hz
const BROADCAST_EVERY = TICK_RATE / BROADCAST_RATE; // = 3 ticks
const PLAYER_SPEED   = 1.25;
const BULLET_SPEED   = 4;
const SERVER_ZOMBIE_SPEED = {
  regular: ZOMBIE_TYPES.regular.speed / 2,
  runner:  ZOMBIE_TYPES.runner.speed  / 2,
  tank:    ZOMBIE_TYPES.tank.speed    / 2,
  bomber:  ZOMBIE_TYPES.bomber.speed  / 2,
};

// ================================================================
// SERVER GAME ENGINE
// ================================================================
class ServerGame {
  constructor(room) {
    this.room = room;
    this.players = []; this.zombies = []; this.bullets = [];
    this.ammoPacks = []; this.healthPacks = [];
    this.wave = 1; this.waveTotal = 0; this.waveKilled = 0;
    this.gameOver = false; this.gameStarted = false;
    this.isBossWave = false; this.boss = null; this.mysteryBox = null;
    this.vendingMachine = null; this.vendingCost = VENDING_BASE_COST;
    this.reviveMap = new Map();
    this.tickInterval = null;
    this.explosions = [];
    this._waveTimers = [];
    this._waveAdvancing = false;  // FIX BOSS SKIP: guard against double wave advance
    this._broadcastTick = 0;      // FIX LAG: broadcast counter

    for (let i = 0; i < MAX_PLAYERS; i++) {
      this.players[i] = {
        slot: i+1, x: PLAYER_SPAWNS[i].x, y: PLAYER_SPAWNS[i].y,
        vx: 0, vy: 0, angle: 0, color: PLAYER_COLORS[i],
        hp: 100, maxHp: 100, ammo: 30, points: 0,
        currentWeapon: 'pistol', alive: true, connected: false,
        firing: false, fireCooldown: 0, meleeing: false, meleeCooldown: 0, savedAmmo: undefined
      };
    }
  }

  start() { this.spawnMysteryBox(); this.spawnVendingMachine(); this.startWave(); this.tickInterval = setInterval(() => this.tick(), TICK_MS); }
  stop()  { if (this.tickInterval) { clearInterval(this.tickInterval); this.tickInterval = null; } }

  restart() {
    this.stop();
    this._waveTimers.forEach(t => clearTimeout(t)); this._waveTimers = [];
    this.zombies=[]; this.bullets=[]; this.ammoPacks=[]; this.healthPacks=[];
    this.wave=1; this.waveTotal=0; this.waveKilled=0;
    this.gameOver=false; this.isBossWave=false; this.boss=null;
    this.vendingMachine=null; this.vendingCost=VENDING_BASE_COST;
    this.reviveMap.clear(); this.explosions=[];
    this._waveAdvancing=false; this._broadcastTick=0;
    for (let p of this.players) {
      p.x=PLAYER_SPAWNS[p.slot-1].x; p.y=PLAYER_SPAWNS[p.slot-1].y;
      p.vx=0; p.vy=0; p.angle=0; p.hp=100; p.ammo=30; p.points=0;
      p.currentWeapon='pistol'; p.alive=true;
      p.firing=false; p.fireCooldown=0; p.meleeing=false; p.meleeCooldown=0; p.savedAmmo=undefined;
    }
    this.spawnMysteryBox(); this.start();
  }

  _scheduleWave(fn, delay) { const t=setTimeout(fn,delay); this._waveTimers.push(t); return t; }

  // FIX BOSS SKIP: single wave-advance function — only one call can succeed
  _advanceWave() {
    if (this._waveAdvancing) return; // already advancing, ignore duplicate calls
    this._waveAdvancing = true;
    this.wave++;
    this._scheduleWave(() => this.startWave(), 3000);
  }

  handleInput(slot, input) {
    const p = this.players[slot-1];
    if (!p||!p.alive) return;
    if (input.angle!=null) { p.vx=Math.cos(input.angle)*PLAYER_SPEED; p.vy=Math.sin(input.angle)*PLAYER_SPEED; p.angle=input.angle; }
    else { p.vx=0; p.vy=0; }
    p.firing=!!input.fire; p.meleeing=!!input.melee;
  }

  handleMysteryBox(slot) {
    const p = this.players[slot-1];
    if (!p||!p.alive||!this.mysteryBox) return;
    const dx=p.x-this.mysteryBox.x, dy=p.y-this.mysteryBox.y;
    if (Math.sqrt(dx*dx+dy*dy)>BOX_USE_RANGE||p.points<MYSTERY_BOX_COST) return;
    p.points-=MYSTERY_BOX_COST;
    const weapon=this.rollRandomWeapon();
    p.currentWeapon=weapon; p.ammo=WEAPONS[weapon].ammoCapacity;
    setTimeout(()=>this.spawnMysteryBox(),1000);
  }

  rollRandomWeapon() {
    const roll=Math.random()*100;
    if (roll<10)  { const l=Object.keys(WEAPONS).filter(k=>WEAPONS[k].rarity==='legendary'); return l[Math.floor(Math.random()*l.length)]; }
    if (roll<40)  { const r=Object.keys(WEAPONS).filter(k=>WEAPONS[k].rarity==='rare');      return r[Math.floor(Math.random()*r.length)]; }
    const c=Object.keys(WEAPONS).filter(k=>WEAPONS[k].rarity==='common'); return c[Math.floor(Math.random()*c.length)];
  }

  spawnMysteryBox() {
    const m=100;
    this.mysteryBox = { x: m+Math.random()*(CANVAS_W-m*2), y: m+Math.random()*(CANVAS_H-m*2) };
  }

  spawnVendingMachine() {
    if (this.isBossWave) { this.vendingMachine = null; return; }
    const margin = 160;
    let x, y, attempts = 0;
    do {
      x = margin + Math.random() * (CANVAS_W - margin * 2);
      y = margin + Math.random() * (CANVAS_H - margin * 2);
      attempts++;
      if (this.mysteryBox) {
        const dx = x - this.mysteryBox.x, dy = y - this.mysteryBox.y;
        if (Math.sqrt(dx*dx+dy*dy) < 200 && attempts < 20) continue;
      }
      break;
    } while (true);
    this.vendingMachine = { x, y };
  }

  handleVendingMachine(slot) {
    const p = this.players[slot-1];
    if (!p||!p.alive||!this.vendingMachine) return;
    const dx=p.x-this.vendingMachine.x, dy=p.y-this.vendingMachine.y;
    if (Math.sqrt(dx*dx+dy*dy)>VENDING_USE_RANGE) return;
    if (p.points<this.vendingCost) return;
    if (p.hp>=p.maxHp) return;
    p.points       -= this.vendingCost;
    p.hp            = Math.min(p.maxHp, p.hp + VENDING_HEAL_AMOUNT);
    this.vendingCost += VENDING_COST_STEP;
  }

  canUseVending(p) {
    if (!this.vendingMachine||!p.alive) return false;
    const dx=p.x-this.vendingMachine.x, dy=p.y-this.vendingMachine.y;
    return Math.sqrt(dx*dx+dy*dy)<=VENDING_USE_RANGE;
  }

  startWave() {
    // FIX BOSS SKIP: reset guard at the start of every new wave
    this._waveAdvancing = false;

    const pc = Math.max(1, this.players.filter(p=>p.connected).length);
    this.waveKilled = 0;
    if (this.wave%5===0) {
      this.isBossWave=true; this.waveTotal=1;
      for (let p of this.players) { if (!p.connected) continue; p.savedAmmo=p.ammo; p.ammo=Infinity; }
      this.vendingMachine = null; // no vending during boss fight
      this.room.broadcast('wave-event',{type:'boss',wave:this.wave});
      this._scheduleWave(()=>this.spawnBoss(),2000);
    } else {
      this.isBossWave=false;
      for (let p of this.players) {
        if (!p.connected) continue;
        if (p.savedAmmo!==undefined) { p.ammo=Math.max(p.savedAmmo,Math.floor(WEAPONS[p.currentWeapon].ammoCapacity*0.5)); p.savedAmmo=undefined; }
      }
      this.spawnVendingMachine(); // new random location each wave
      const baseCount=3+(this.wave-1)*2;
      this.waveTotal=Math.ceil(baseCount*(pc/2));
      this.room.broadcast('wave-event',{type:'normal',wave:this.wave});
      for (let i=0;i<this.waveTotal;i++) this._scheduleWave(()=>this.spawnZombie(),i*500);
    }
  }

  getBossType() { return BOSS_TYPES[Math.floor((this.wave/5-1))%BOSS_TYPES.length]; }

  spawnBoss() {
    const type=this.getBossType(), cfg=BOSS_CONFIGS[type];
    const base = { type, x:CANVAS_W/2, y:-120, dropping:true, dropTarget:CANVAS_H/2,
      vx:3.5, vy:2.5, rotation:0, spinSpeed:0.03, flashTimer:0, dead:false,
      bossBullets:[], shootTimer:0, radius:cfg.radius, color:cfg.color, pad:cfg.pad };
    if (type==='triangle') this.boss={...base, tips:Array.from({length:cfg.tips.count},()=>({hp:cfg.tips.hp,maxHp:cfg.tips.hp}))};
    else if (type==='octagon') this.boss={...base, corners:Array.from({length:cfg.corners.count},()=>({hp:cfg.corners.hp,maxHp:cfg.corners.hp})),shootInterval:cfg.shootInterval};
    else if (type==='pentagon') this.boss={...base, panels:Array.from({length:cfg.panels.count},()=>({hp:cfg.panels.hp,maxHp:cfg.panels.hp}))};
    else if (type==='diamond') this.boss={...base, coreHp:cfg.coreHp,coreMaxHp:cfg.coreHp,split:false,shards:[]};
    else if (type==='spiral') this.boss={...base, arms:Array.from({length:cfg.arms.count},()=>({hp:cfg.arms.hp,maxHp:cfg.arms.hp})),breathe:0};
    else this.boss={...base, pieces:[{x:CANVAS_W/2,y:-120,rotation:0,vx:3.5,vy:2.5,hp:cfg.pieceHp,maxHp:cfg.pieceHp,radius:cfg.radius,alive:true}]};
  }

  getBossHitPoints() {
    if (!this.boss) return [];
    const b=this.boss;
    if (b.type==='triangle')  return [0,1,2].map(i=>{const a=b.rotation-Math.PI/2+i*(2*Math.PI/3);return{x:b.x+Math.cos(a)*b.radius,y:b.y+Math.sin(a)*b.radius,idx:i};});
    if (b.type==='octagon')   return b.corners.map((c,i)=>{const a=b.rotation+(i/8)*Math.PI*2;return{x:b.x+Math.cos(a)*b.radius,y:b.y+Math.sin(a)*b.radius,idx:i};});
    if (b.type==='pentagon')  return b.panels.map((p,i)=>{const a=b.rotation+(i/5)*Math.PI*2+Math.PI/5;return{x:b.x+Math.cos(a)*b.radius*0.6,y:b.y+Math.sin(a)*b.radius*0.6,idx:i};});
    if (b.type==='diamond') {
      if (!b.split) return [{x:b.x,y:b.y,idx:0,core:true}];
      // FIX INVINCIBLE SHARD: use real array index (realIdx), not filtered index
      return b.shards.reduce((acc,s,realIdx) => {
        if (s.alive) acc.push({x:s.x,y:s.y,idx:realIdx,shard:true});
        return acc;
      }, []);
    }
    if (b.type==='spiral')    return b.arms.map((arm,i)=>{const ext=b.radius+60+Math.sin(b.breathe+i)*30,a=b.rotation+(i/5)*Math.PI*2;return{x:b.x+Math.cos(a)*ext,y:b.y+Math.sin(a)*ext,idx:i};});
    if (b.type==='fractal')   {
      // FIX: also use real array index for fractal pieces
      return b.pieces.reduce((acc,p,realIdx) => {
        if (p.alive) acc.push({x:p.x,y:p.y,idx:realIdx,piece:true,radius:p.radius});
        return acc;
      }, []);
    }
    return [];
  }
  getBossTipPositions() { return this.getBossHitPoints(); }

  _bounceBox(b) {
    const p=b.pad; b.x+=b.vx; b.y+=b.vy;
    if (b.x-p<WALL){b.x=WALL+p;b.vx=Math.abs(b.vx);} if (b.x+p>CANVAS_W-WALL){b.x=CANVAS_W-WALL-p;b.vx=-Math.abs(b.vx);}
    if (b.y-p<WALL){b.y=WALL+p;b.vy=Math.abs(b.vy);} if (b.y+p>CANVAS_H-WALL){b.y=CANVAS_H-WALL-p;b.vy=-Math.abs(b.vy);}
  }

  _bossKill(b) {
    b.dead=true;
    for (let p of this.players) if (p.alive&&p.connected){p.points+=1000;p.hp=p.maxHp;}
    const dc=4+Math.floor(Math.random()*4);
    for (let i=0;i<dc;i++){const a=Math.random()*Math.PI*2,d=30+Math.random()*80;this.ammoPacks.push({x:b.x+Math.cos(a)*d,y:b.y+Math.sin(a)*d});}
    this.explosions.push({x:b.x,y:b.y,color:b.color,big:true});
    // FIX BOSS SKIP: use _advanceWave() instead of inline wave++
    this._scheduleWave(()=>{this.boss=null;this._advanceWave();},800);
  }

  _bossTouchDamage(b,extra=0) {
    for (let p of this.players) {
      if (!p.alive||!p.connected) continue;
      const dx=p.x-b.x,dy=p.y-b.y;
      if (Math.sqrt(dx*dx+dy*dy)<b.radius+extra+PLAYER_SIZE/2){p.hp-=1;if(p.hp<=0&&p.alive){p.alive=false;p.hp=0;this.checkGameOver();}}
    }
  }

  _damageBossHitPoint(pt, amount) {
    const b=this.boss; if (!b) return; b.flashTimer=6;
    if      (b.type==='triangle')  b.tips[pt.idx].hp=Math.max(0,b.tips[pt.idx].hp-amount);
    else if (b.type==='octagon')   b.corners[pt.idx].hp=Math.max(0,b.corners[pt.idx].hp-amount);
    else if (b.type==='pentagon')  b.panels[pt.idx].hp=Math.max(0,b.panels[pt.idx].hp-amount);
    else if (b.type==='diamond')   {
      if (!b.split) { b.coreHp=Math.max(0,b.coreHp-amount); }
      else {
        // pt.idx is now always the real array index — no drift
        const s=b.shards[pt.idx];
        if (s) { s.hp=Math.max(0,s.hp-amount); if(s.hp<=0)s.alive=false; }
      }
    }
    else if (b.type==='spiral')    b.arms[pt.idx].hp=Math.max(0,b.arms[pt.idx].hp-amount);
    else if (b.type==='fractal')   {
      // pt.idx is now always the real array index — no drift
      const piece=b.pieces[pt.idx];
      if (piece) piece.hp=Math.max(0,piece.hp-amount);
    }
  }

  updateBoss() {
    if (!this.boss) return;
    const b=this.boss;
    if (b.dropping){b.y+=6;b.rotation+=b.spinSpeed;if(b.y>=b.dropTarget){b.y=b.dropTarget;b.dropping=false;}return;}
    if (b.flashTimer>0) b.flashTimer--;

    for (let i=b.bossBullets.length-1;i>=0;i--) {
      const bb=b.bossBullets[i]; bb.x+=bb.vx; bb.y+=bb.vy; bb.life--;
      if (bb.life<=0||bb.x<0||bb.x>CANVAS_W||bb.y<0||bb.y>CANVAS_H){b.bossBullets.splice(i,1);continue;}
      for (let p of this.players) {
        if (!p.alive||!p.connected) continue;
        const dx=p.x-bb.x,dy=p.y-bb.y;
        if (Math.sqrt(dx*dx+dy*dy)<PLAYER_SIZE/2+5){p.hp-=bb.damage;b.bossBullets.splice(i,1);if(p.hp<=0&&p.alive){p.alive=false;p.hp=0;this.checkGameOver();}break;}
      }
    }

    if (b.type==='triangle') {
      const ta=b.tips.filter(t=>t.hp>0).length; b.spinSpeed=0.03+(3-ta)*0.025; b.rotation+=b.spinSpeed;
      this._bounceBox(b); this._bossTouchDamage(b); if(b.tips.every(t=>t.hp<=0)&&!b.dead)this._bossKill(b);
    } else if (b.type==='octagon') {
      const al=b.corners.filter(c=>c.hp>0).length; b.spinSpeed=0.02+(8-al)*0.008; b.rotation+=b.spinSpeed;
      this._bounceBox(b); this._bossTouchDamage(b);
      if(++b.shootTimer>=b.shootInterval){b.shootTimer=0;b.corners.forEach((c,i)=>{if(c.hp<=0)return;const a=b.rotation+(i/8)*Math.PI*2,cx=b.x+Math.cos(a)*b.radius,cy=b.y+Math.sin(a)*b.radius;b.bossBullets.push({x:cx,y:cy,vx:Math.cos(a)*3,vy:Math.sin(a)*3,damage:8,life:120,color:'#ff6600'});});}
      if(b.corners.every(c=>c.hp<=0)&&!b.dead)this._bossKill(b);
    } else if (b.type==='pentagon') {
      const al=b.panels.filter(p=>p.hp>0).length; b.spinSpeed=0.04+(5-al)*0.022; b.rotation+=b.spinSpeed;
      this._bounceBox(b); this._bossTouchDamage(b); if(b.panels.every(p=>p.hp<=0)&&!b.dead)this._bossKill(b);
    } else if (b.type==='diamond') {
      b.rotation+=0.025;
      if (!b.split) {
        this._bounceBox(b); this._bossTouchDamage(b);
        if (b.coreHp<=0&&!b.dead) {
          b.split=true; const cfg=BOSS_CONFIGS.diamond;
          b.shards=[0,Math.PI/2,Math.PI,Math.PI*1.5].map(a=>({x:b.x+Math.cos(a)*40,y:b.y+Math.sin(a)*40,vx:Math.cos(a)*2.5,vy:Math.sin(a)*2.5,rotation:0,hp:cfg.shardHp,maxHp:cfg.shardHp,alive:true,radius:cfg.shardRadius,pad:cfg.shardPad}));
        }
      } else {
        for (let s of b.shards) {
          if (!s.alive) continue; s.rotation+=0.04; s.x+=s.vx; s.y+=s.vy;
          if(s.x-s.pad<WALL){s.x=WALL+s.pad;s.vx=Math.abs(s.vx);}if(s.x+s.pad>CANVAS_W-WALL){s.x=CANVAS_W-WALL-s.pad;s.vx=-Math.abs(s.vx);}
          if(s.y-s.pad<WALL){s.y=WALL+s.pad;s.vy=Math.abs(s.vy);}if(s.y+s.pad>CANVAS_H-WALL){s.y=CANVAS_H-WALL-s.pad;s.vy=-Math.abs(s.vy);}
          for (let p of this.players){if(!p.alive||!p.connected)continue;const dx=p.x-s.x,dy=p.y-s.y;if(Math.sqrt(dx*dx+dy*dy)<s.radius+PLAYER_SIZE/2){p.hp-=0.8;if(p.hp<=0&&p.alive){p.alive=false;p.hp=0;this.checkGameOver();}}}
        }
        b.x=b.shards.reduce((s,sh)=>s+sh.x,0)/4; b.y=b.shards.reduce((s,sh)=>s+sh.y,0)/4;
        if(b.shards.every(s=>!s.alive)&&!b.dead)this._bossKill(b);
      }
    } else if (b.type==='spiral') {
      b.breathe+=0.05; b.rotation+=0.02; this._bounceBox(b); this._bossTouchDamage(b,10);
      if(++b.shootTimer>=40){b.shootTimer=0;for(let i=0;i<5;i++){const a=b.rotation+(i/5)*Math.PI*2;b.bossBullets.push({x:b.x,y:b.y,vx:Math.cos(a)*3.5,vy:Math.sin(a)*3.5,damage:10,life:100,color:'#44ffaa'});}}
      if(b.arms.every(a=>a.hp<=0)&&!b.dead)this._bossKill(b);
    } else if (b.type==='fractal') {
      const cfg=BOSS_CONFIGS.fractal;
      for (let piece of b.pieces) {
        if (!piece.alive) continue;
        piece.rotation+=0.03; piece.x+=piece.vx; piece.y+=piece.vy; const pad=piece.radius+10;
        if(piece.x-pad<WALL){piece.x=WALL+pad;piece.vx=Math.abs(piece.vx);}if(piece.x+pad>CANVAS_W-WALL){piece.x=CANVAS_W-WALL-pad;piece.vx=-Math.abs(piece.vx);}
        if(piece.y-pad<WALL){piece.y=WALL+pad;piece.vy=Math.abs(piece.vy);}if(piece.y+pad>CANVAS_H-WALL){piece.y=CANVAS_H-WALL-pad;piece.vy=-Math.abs(piece.vy);}
        for(let p of this.players){if(!p.alive||!p.connected)continue;const dx=p.x-piece.x,dy=p.y-piece.y;if(Math.sqrt(dx*dx+dy*dy)<piece.radius+PLAYER_SIZE/2){p.hp-=0.8;if(p.hp<=0&&p.alive){p.alive=false;p.hp=0;this.checkGameOver();}}}
        if(piece.hp<=0&&piece.alive){piece.alive=false;this.explosions.push({x:piece.x,y:piece.y,color:'#ffdd00'});
          if(piece.radius>cfg.splitThreshold){for(let i=0;i<cfg.splitCount;i++){const a=(i/cfg.splitCount)*Math.PI*2+Math.random()*0.5,nr=Math.round(piece.radius*cfg.splitScale),nh=Math.ceil(piece.maxHp*0.6);b.pieces.push({x:piece.x+Math.cos(a)*nr,y:piece.y+Math.sin(a)*nr,vx:Math.cos(a)*2+Math.random()-0.5,vy:Math.sin(a)*2+Math.random()-0.5,rotation:0,hp:nh,maxHp:nh,radius:nr,alive:true});}}}
      }
      const alive=b.pieces.filter(p=>p.alive);
      if(alive.length>0){b.x=alive.reduce((s,p)=>s+p.x,0)/alive.length;b.y=alive.reduce((s,p)=>s+p.y,0)/alive.length;}
      if(b.pieces.every(p=>!p.alive)&&!b.dead)this._bossKill(b);
    }
  }

  spawnZombie() {
    const side=Math.floor(Math.random()*4);
    let x,y;
    if(side===0){x=Math.random()*CANVAS_W;y=-50;}
    else if(side===1){x=CANVAS_W+50;y=Math.random()*CANVAS_H;}
    else if(side===2){x=Math.random()*CANVAS_W;y=CANVAS_H+50;}
    else{x=-50;y=Math.random()*CANVAS_H;}
    const type=this.rollZombieType(), td=ZOMBIE_TYPES[type];
    this.zombies.push({x,y,type,hp:td.hp,maxHp:td.hp,speed:SERVER_ZOMBIE_SPEED[type],size:td.size,color:td.color,borderColor:td.borderColor,points:td.points});
  }

  rollZombieType() {
    const weights={regular:ZOMBIE_TYPES.regular.weight,runner:ZOMBIE_TYPES.runner.weight,tank:ZOMBIE_TYPES.tank.weight,bomber:this.wave>5?15:0};
    const total=Object.values(weights).reduce((s,w)=>s+w,0); let roll=Math.random()*total;
    for (let t in weights){roll-=weights[t];if(roll<=0)return t;} return 'regular';
  }

  fireBullet(p) {
    const weapon=WEAPONS[p.currentWeapon];
    this.bullets.push({x:p.x+Math.cos(p.angle)*PLAYER_SIZE,y:p.y+Math.sin(p.angle)*PLAYER_SIZE,vx:Math.cos(p.angle)*BULLET_SPEED,vy:Math.sin(p.angle)*BULLET_SPEED,damage:weapon.damage,color:p.color});
    if(p.ammo!==Infinity)p.ammo--;
  }

  performMelee(p) {
    this.explosions.push({x:p.x+Math.cos(p.angle)*MELEE_RANGE*0.5,y:p.y+Math.sin(p.angle)*MELEE_RANGE*0.5,color:p.color,melee:true,angle:p.angle});
    for (let j=this.zombies.length-1;j>=0;j--) {
      const z=this.zombies[j],dx=z.x-p.x,dy=z.y-p.y;
      if(Math.sqrt(dx*dx+dy*dy)>MELEE_RANGE+z.size/2)continue;
      let ad=Math.atan2(dy,dx)-p.angle; while(ad>Math.PI)ad-=Math.PI*2; while(ad<-Math.PI)ad+=Math.PI*2;
      if(Math.abs(ad)>MELEE_ARC/2)continue;
      z.hp-=MELEE_DAMAGE;
      if(z.hp<=0){
        p.points+=z.points;this.ammoPacks.push({x:z.x,y:z.y});
        if(Math.random()<HEALTH_DROP_CHANCE)this.healthPacks.push({x:z.x,y:z.y});
        this.explosions.push({x:z.x,y:z.y,color:z.borderColor});
        if(z.type==='bomber')this.triggerBomberExplosion(z.x,z.y);
        this.zombies.splice(j,1); this.waveKilled++;
        // FIX BOSS SKIP: use _advanceWave()
        if(this.waveKilled>=this.waveTotal&&this.zombies.length===0&&!this.boss) this._advanceWave();
      }
    }
    if (this.boss&&!this.boss.dead&&!this.boss.dropping) {
      for (const pt of this.getBossHitPoints()) {
        const dx=pt.x-p.x,dy=pt.y-p.y; if(Math.sqrt(dx*dx+dy*dy)>MELEE_RANGE+20)continue;
        let ad=Math.atan2(dy,dx)-p.angle; while(ad>Math.PI)ad-=Math.PI*2; while(ad<-Math.PI)ad+=Math.PI*2;
        if(Math.abs(ad)>MELEE_ARC/2)continue; this._damageBossHitPoint(pt,MELEE_DAMAGE);
      }
    }
  }

  triggerBomberExplosion(bx,by,depth=0) {
    if(depth>BOMBER_CHAIN_DEPTH)return;
    this.explosions.push({x:bx,y:by,color:'#4499ff',bomber:true});
    for(let p of this.players){if(!p.alive||!p.connected)continue;const dx=p.x-bx,dy=p.y-by;if(Math.sqrt(dx*dx+dy*dy)<BOMBER_BLAST_RADIUS+PLAYER_SIZE/2){p.hp-=BOMBER_PLAYER_DAMAGE;if(p.hp<=0&&p.alive){p.alive=false;p.hp=0;this.checkGameOver();}}}
    const toKill=[];
    for(let i=this.zombies.length-1;i>=0;i--){const z=this.zombies[i],dx=z.x-bx,dy=z.y-by;if(Math.sqrt(dx*dx+dy*dy)<BOMBER_BLAST_RADIUS+z.size/2)toKill.push({idx:i,z});}
    const chains=toKill.filter(({z})=>z.type==='bomber').map(({z})=>({x:z.x,y:z.y}));
    for(const{idx,z}of toKill){this.explosions.push({x:z.x,y:z.y,color:z.borderColor});this.zombies.splice(idx,1);this.waveKilled++;
      // FIX BOSS SKIP: use _advanceWave()
      if(this.waveKilled>=this.waveTotal&&this.zombies.length===0&&!this.boss) this._advanceWave();
    }
    for(const pos of chains)this.triggerBomberExplosion(pos.x,pos.y,depth+1);
  }

  updateRevive() {
    const now=Date.now();
    for(let reviver of this.players){
      if(!reviver.alive||!reviver.connected){this.reviveMap.delete(reviver.slot);continue;}
      let found=false;
      for(let target of this.players){
        if(target.alive||!target.connected||target===reviver)continue;
        const dx=target.x-reviver.x,dy=target.y-reviver.y;
        if(Math.sqrt(dx*dx+dy*dy)<=REVIVE_RADIUS){found=true;const att=this.reviveMap.get(reviver.slot);if(!att||att.targetSlot!==target.slot)this.reviveMap.set(reviver.slot,{targetSlot:target.slot,startTime:now});else if(now-att.startTime>=REVIVE_TIME){target.alive=true;target.hp=50;this.reviveMap.delete(reviver.slot);}break;}
      }
      if(!found)this.reviveMap.delete(reviver.slot);
    }
  }

  checkGameOver() {
    if(!this.players.some(p=>p.alive&&p.connected)){this.gameOver=true;this.room.broadcast('game-over',{});}
  }

  canUseMysteryBox(p) {
    if(!this.mysteryBox||!p.alive)return false;
    const dx=p.x-this.mysteryBox.x,dy=p.y-this.mysteryBox.y;
    return Math.sqrt(dx*dx+dy*dy)<=BOX_USE_RANGE;
  }

  tick() {
    if(this.gameOver||!this.gameStarted)return;
    this.explosions=[];
    const hs=PLAYER_SIZE/2;

    for(let p of this.players){
      if(!p.connected||!p.alive)continue;
      const clamp=hs+WALL;
      p.x=Math.max(clamp,Math.min(CANVAS_W-clamp,p.x+p.vx)); p.y=Math.max(clamp,Math.min(CANVAS_H-clamp,p.y+p.vy));
      const weapon=WEAPONS[p.currentWeapon]; p.fireCooldown--; p.meleeCooldown--;
      if(p.firing&&(p.ammo>0||p.ammo===Infinity)&&p.fireCooldown<=0){this.fireBullet(p);p.fireCooldown=weapon.fireRate;}
      if(p.meleeing&&p.ammo===0&&p.ammo!==Infinity&&p.meleeCooldown<=0){this.performMelee(p);p.meleeCooldown=1;}
    }

    for(let i=this.bullets.length-1;i>=0;i--){
      const b=this.bullets[i]; b.x+=b.vx; b.y+=b.vy;
      if(b.x<0||b.x>CANVAS_W||b.y<0||b.y>CANVAS_H){this.bullets.splice(i,1);continue;}
      let hit=false;
      for(let j=this.zombies.length-1;j>=0;j--){
        const z=this.zombies[j],dx=b.x-z.x,dy=b.y-z.y;
        if(Math.sqrt(dx*dx+dy*dy)<z.size/2+BULLET_SIZE/2){
          z.hp-=b.damage;hit=true;
          if(z.hp<=0){let near=null,nd=Infinity;for(let p of this.players){if(!p.alive||!p.connected)continue;const d=Math.sqrt((p.x-z.x)**2+(p.y-z.y)**2);if(d<nd){nd=d;near=p;}}if(near)near.points+=z.points;if(Math.random()<AMMO_DROP_CHANCE)this.ammoPacks.push({x:z.x,y:z.y});if(Math.random()<HEALTH_DROP_CHANCE)this.healthPacks.push({x:z.x,y:z.y});this.explosions.push({x:z.x,y:z.y,color:z.borderColor});if(z.type==='bomber')this.triggerBomberExplosion(z.x,z.y);this.zombies.splice(j,1);this.waveKilled++;
            // FIX BOSS SKIP: use _advanceWave()
            if(this.waveKilled>=this.waveTotal&&this.zombies.length===0&&!this.boss) this._advanceWave();
          }
          break;
        }
      }
      if(hit){this.bullets.splice(i,1);continue;}
      if(this.boss&&!this.boss.dead&&!this.boss.dropping){
        for(const pt of this.getBossHitPoints()){
          const dx=b.x-pt.x,dy=b.y-pt.y,hitR=pt.piece?Math.min(pt.radius*0.6,30):22;
          if(Math.sqrt(dx*dx+dy*dy)<hitR){hit=true;this._damageBossHitPoint(pt,b.damage);this.bullets.splice(i,1);break;}
        }
      }
      if(hit)this.bullets.splice(i,1);
    }

    for(let z of this.zombies){
      let near=null,nd=Infinity;
      for(let p of this.players){if(!p.alive||!p.connected)continue;const d=Math.sqrt((p.x-z.x)**2+(p.y-z.y)**2);if(d<nd){nd=d;near=p;}}
      if(!near)continue;
      const dx=near.x-z.x,dy=near.y-z.y,dist=Math.sqrt(dx*dx+dy*dy);
      if(dist>0){z.x+=(dx/dist)*z.speed;z.y+=(dy/dist)*z.speed;}
      if(Math.sqrt((near.x-z.x)**2+(near.y-z.y)**2)<z.size/2+PLAYER_SIZE/2){near.hp-=0.5;if(near.hp<=0&&near.alive){near.alive=false;near.hp=0;this.checkGameOver();}}
    }

    for(let i=this.ammoPacks.length-1;i>=0;i--){const a=this.ammoPacks[i];for(let p of this.players){if(!p.alive)continue;if(Math.sqrt((p.x-a.x)**2+(p.y-a.y)**2)<PLAYER_SIZE/2+10){if(p.ammo!==Infinity)p.ammo+=Math.floor(WEAPONS[p.currentWeapon].ammoCapacity*0.5);this.ammoPacks.splice(i,1);break;}}}
    for(let i=this.healthPacks.length-1;i>=0;i--){const h=this.healthPacks[i];for(let p of this.players){if(!p.alive)continue;if(Math.sqrt((p.x-h.x)**2+(p.y-h.y)**2)<PLAYER_SIZE/2+10){p.hp=Math.min(p.maxHp,p.hp+30);this.healthPacks.splice(i,1);break;}}}

    this.updateRevive();
    this.updateBoss();

    // FIX LAG: only broadcast every 3 ticks (20Hz) instead of every tick (60Hz)
    // Game logic still runs at full 60Hz — players won't notice the difference
    this._broadcastTick++;
    if (this._broadcastTick >= BROADCAST_EVERY) {
      this._broadcastTick = 0;
      this.room.broadcastGameState(this);
    }
  }

  getState() {
    return {
      players: this.players.map(p=>({slot:p.slot,x:p.x,y:p.y,angle:p.angle,color:p.color,hp:p.hp,maxHp:p.maxHp,ammo:p.ammo===Infinity?-1:p.ammo,points:p.points,weapon:p.currentWeapon,alive:p.alive,connected:p.connected,canUseMysteryBox:this.canUseMysteryBox(p),canUseVending:this.canUseVending(p),vendingCost:this.vendingCost})),
      zombies: this.zombies.map(z=>({x:z.x,y:z.y,type:z.type,hp:z.hp,maxHp:z.maxHp,size:z.size,color:z.color,borderColor:z.borderColor})),
      bullets: this.bullets.map(b=>({x:b.x,y:b.y,color:b.color})),
      ammoPacks: this.ammoPacks.map(a=>({x:a.x,y:a.y})),
      healthPacks: this.healthPacks.map(h=>({x:h.x,y:h.y})),
      mysteryBox: this.mysteryBox?{x:this.mysteryBox.x,y:this.mysteryBox.y}:null,
      vendingMachine: this.vendingMachine?{x:this.vendingMachine.x,y:this.vendingMachine.y}:null,
      vendingCost: this.vendingCost,
      boss: this.boss?{type:this.boss.type,x:this.boss.x,y:this.boss.y,rotation:this.boss.rotation,radius:this.boss.radius,color:this.boss.color,dropping:this.boss.dropping,flashTimer:this.boss.flashTimer,dead:this.boss.dead,pad:this.boss.pad,tips:this.boss.tips,corners:this.boss.corners,panels:this.boss.panels,coreHp:this.boss.coreHp,coreMaxHp:this.boss.coreMaxHp,split:this.boss.split,shards:this.boss.shards,arms:this.boss.arms,breathe:this.boss.breathe,pieces:this.boss.pieces,bossBullets:this.boss.bossBullets}:null,
      reviveMap: Array.from(this.reviveMap.entries()),
      wave:this.wave, gameOver:this.gameOver, isBossWave:this.isBossWave, explosions:this.explosions
    };
  }
}

// ================================================================
// GAME ROOM
// ================================================================
class GameRoom {
  constructor(roomCode,mode='local') {
    this.roomCode=roomCode; this.mode=mode; this.hostSocket=null;
    this.players=new Map(); this.disconnectedPlayers=new Map();
    this.restartVotes=new Set(); this.readyPlayers=new Set();
    this.gameStarted=false; this.serverGame=null;
    console.log(`[ROOM ${roomCode}] Created (${mode} mode)`);
  }

  static generateRoomCode() {
    const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; let code;
    do{const rb=crypto.randomBytes(4);code=Array.from(rb).map(b=>chars[b%chars.length]).join('');}while(gameRooms.has(code));
    return code;
  }

  broadcast(event,data) {
    for(let[sid]of this.players){const s=io.sockets.sockets.get(sid);if(s)s.emit(event,data);}
    if(this.hostSocket)this.hostSocket.emit(event,data);
  }

  broadcastGameState(game) {
    const state=game.getState();
    if(this.mode==='remote'){for(let[sid]of this.players){const s=io.sockets.sockets.get(sid);if(s)s.emit('remote-game-state',state);}}
    else{
      if(this.hostSocket)this.hostSocket.emit('remote-game-state',state);
      for(let[sid,player]of this.players){const s=io.sockets.sockets.get(sid);if(!s)continue;const p=state.players[player.slotNumber-1];if(p)s.emit('game-state-update',{health:p.hp,ammo:p.ammo,points:p.points,weapon:p.weapon,isAlive:p.alive,canUseMysteryBox:p.canUseMysteryBox,canUseVending:p.canUseVending,vendingCost:p.vendingCost,wave:state.wave,gameOver:state.gameOver});}
    }
  }

  setHost(socket){this.hostSocket=socket;socket.emit('room-created',{roomCode:this.roomCode,mode:this.mode});console.log(`[ROOM ${this.roomCode}] Host connected`);}
  findAvailableSlot(){for(let i=1;i<=MAX_PLAYERS;i++){if(!this.isSlotOccupied(i))return i;}return null;}
  isSlotOccupied(slot){for(let p of this.players.values())if(p.slotNumber===slot&&p.connected)return true;for(let p of this.disconnectedPlayers.values())if(p.slotNumber===slot)return true;return false;}

  addPlayer(socket,deviceFingerprint=null){
    if(deviceFingerprint&&this.disconnectedPlayers.has(deviceFingerprint))return this.reconnectPlayer(socket,deviceFingerprint);
    if(deviceFingerprint&&this.gameStarted){for(let[sid,p]of this.players){if(p.deviceFingerprint===deviceFingerprint){this.players.delete(sid);const u={...p,socketId:socket.id,connected:true,lastPong:Date.now()};this.players.set(socket.id,u);if(this.serverGame)this.serverGame.players[p.slotNumber-1].connected=true;return u;}}}
    const slot=this.findAvailableSlot();
    if(slot===null){socket.emit('join-failed',{reason:'Room is full'});return null;}
    const pd={socketId:socket.id,slotNumber:slot,color:PLAYER_COLORS[slot-1],connected:true,lastPong:Date.now(),deviceFingerprint:deviceFingerprint||socket.id};
    this.players.set(socket.id,pd);
    if(this.hostSocket)this.hostSocket.emit('player-joined',{slotNumber:slot,color:pd.color});
    this.broadcastLobbyState();
    if(this.serverGame)this.serverGame.players[slot-1].connected=true;
    console.log(`[ROOM ${this.roomCode}] Player ${slot} joined`); return pd;
  }

  reconnectPlayer(socket,deviceFingerprint){
    const dp=this.disconnectedPlayers.get(deviceFingerprint); if(!dp)return null;
    if(dp.gracePeriodTimeout)clearTimeout(dp.gracePeriodTimeout);
    const pd={...dp,socketId:socket.id,connected:true,lastPong:Date.now()};
    this.players.set(socket.id,pd); this.disconnectedPlayers.delete(deviceFingerprint);
    if(this.hostSocket)this.hostSocket.emit('player-reconnected',{slotNumber:pd.slotNumber,color:pd.color});
    if(this.serverGame)this.serverGame.players[pd.slotNumber-1].connected=true;
    this.broadcastLobbyState(); return pd;
  }

  handleDisconnect(socketId){
    const player=this.players.get(socketId); if(!player)return;
    this.disconnectedPlayers.set(player.deviceFingerprint,{...player,connected:false});
    this.players.delete(socketId); this.restartVotes.delete(player.slotNumber); this.readyPlayers.delete(player.slotNumber);
    if(!this.gameStarted&&this._readyCountdownInterval){clearInterval(this._readyCountdownInterval);this._readyCountdownInterval=null;this.broadcast('ready-countdown-cancelled');if(this.hostSocket)this.hostSocket.emit('ready-countdown-cancelled');}
    if(this.hostSocket)this.hostSocket.emit('player-disconnected',{slotNumber:player.slotNumber});
    if(this.serverGame)this.serverGame.players[player.slotNumber-1].connected=false;
    player.gracePeriodTimeout=setTimeout(()=>{this.disconnectedPlayers.delete(player.deviceFingerprint);if(this.hostSocket)this.hostSocket.emit('player-removed',{slotNumber:player.slotNumber});},GRACE_PERIOD_MS);
    console.log(`[ROOM ${this.roomCode}] Player ${player.slotNumber} disconnected`);
  }

  startHeartbeat(socket){
    const interval=setInterval(()=>{const player=this.players.get(socket.id);if(!player){clearInterval(interval);return;}socket.emit('ping');if(Date.now()-player.lastPong>HEARTBEAT_MS*2){clearInterval(interval);this.handleDisconnect(socket.id);}},HEARTBEAT_MS);
    const player=this.players.get(socket.id);if(player)player.heartbeatInterval=interval;
  }

  updateLastPong(socketId){const p=this.players.get(socketId);if(p)p.lastPong=Date.now();}

  relayPlayerInput(socketId,input){const player=this.players.get(socketId);if(!player)return;if(this.mode==='remote'&&this.serverGame)this.serverGame.handleInput(player.slotNumber,input);else if(this.hostSocket)this.hostSocket.emit('player-input',{slotNumber:player.slotNumber,input});}
  handleMysteryBox(socketId){const player=this.players.get(socketId);if(!player)return;if(this.mode==='remote'&&this.serverGame)this.serverGame.handleMysteryBox(player.slotNumber);else if(this.hostSocket)this.hostSocket.emit('mystery-box-purchase',{slotNumber:player.slotNumber});}
  handleVending(socketId){const player=this.players.get(socketId);if(!player)return;if(this.mode==='remote'&&this.serverGame)this.serverGame.handleVendingMachine(player.slotNumber);else if(this.hostSocket)this.hostSocket.emit('vending-purchase',{slotNumber:player.slotNumber});}

  handleReady(socketId){
    const player=this.players.get(socketId);if(!player||this.gameStarted)return;
    this.readyPlayers.add(player.slotNumber);this.broadcastLobbyState();
    console.log(`[ROOM ${this.roomCode}] Player ${player.slotNumber} READY (${this.readyPlayers.size}/${this.players.size})`);
    if(this.readyPlayers.size>=this.players.size&&this.players.size>=1)this._startReadyCountdown();
  }

  _startReadyCountdown(){
    if(this._readyCountdownInterval){clearInterval(this._readyCountdownInterval);this._readyCountdownInterval=null;}
    let timeLeft=5;
    this.broadcast('ready-countdown',{seconds:timeLeft});if(this.hostSocket)this.hostSocket.emit('ready-countdown',{seconds:timeLeft});
    this._readyCountdownInterval=setInterval(()=>{
      if(this.readyPlayers.size<this.players.size){clearInterval(this._readyCountdownInterval);this._readyCountdownInterval=null;this.broadcast('ready-countdown-cancelled');if(this.hostSocket)this.hostSocket.emit('ready-countdown-cancelled');return;}
      timeLeft--;this.broadcast('ready-countdown',{seconds:timeLeft});if(this.hostSocket)this.hostSocket.emit('ready-countdown',{seconds:timeLeft});
      if(timeLeft<=0){clearInterval(this._readyCountdownInterval);this._readyCountdownInterval=null;this.gameStarted=true;
        if(this.mode==='remote'){if(!this.serverGame)this.serverGame=new ServerGame(this);for(let[,p]of this.players)this.serverGame.players[p.slotNumber-1].connected=true;this.serverGame.gameStarted=true;this.serverGame.start();this.broadcast('game-starting-remote',{mode:'remote'});}
        else{if(this.hostSocket)this.hostSocket.emit('all-ready');for(let[sid]of this.players){const s=io.sockets.sockets.get(sid);if(s)s.emit('game-starting');}}
      }
    },1000);
  }

  broadcastLobbyState(){
    const lp=[];for(let p of this.players.values())lp.push({slotNumber:p.slotNumber,color:p.color,ready:this.readyPlayers.has(p.slotNumber)});
    const data={players:lp,mode:this.mode,roomCode:this.roomCode};
    if(this.hostSocket)this.hostSocket.emit('lobby-update',data);this.broadcast('lobby-update',data);
  }

  handleRestartVote(socketId){
    const player=this.players.get(socketId);if(!player)return;
    this.restartVotes.add(player.slotNumber);this.broadcast('restart-vote-update',{votes:this.restartVotes.size,needed:this.players.size});
    if(this.restartVotes.size>=this.players.size){this.restartVotes.clear();this.readyPlayers.clear();this.gameStarted=false;
      if(this.mode==='remote'&&this.serverGame){this.serverGame.restart();this.broadcast('game-restarting-remote',{});}
      else{if(this.hostSocket)this.hostSocket.emit('restart-game');this.broadcast('game-restarting',{});}
    }
  }

  broadcastExplosion(data){this.broadcast('explosion',data);if(this.hostSocket)this.hostSocket.emit('explosion',data);}

  broadcastLocalGameState(gameState){
    for(let[socketId,player]of this.players){const socket=io.sockets.sockets.get(socketId);if(socket&&player.connected){const ps=gameState.players?gameState.players[player.slotNumber-1]:null;if(ps)socket.emit('game-state-update',{health:ps.health,ammo:ps.ammo===Infinity?-1:ps.ammo,isAlive:ps.isAlive,points:ps.points,weapon:ps.weapon,canUseMysteryBox:ps.canUseMysteryBox,canUseVending:ps.canUseVending,vendingCost:ps.vendingCost,killCount:ps.killCount||0,tierIndex:ps.tierIndex||0,wave:gameState.wave||1,zombiesRemaining:gameState.zombiesRemaining||0,gameOver:gameState.gameOver||false});}}
  }

  destroy(){if(this.serverGame)this.serverGame.stop();for(let p of this.disconnectedPlayers.values())if(p.gracePeriodTimeout)clearTimeout(p.gracePeriodTimeout);for(let p of this.players.values())if(p.heartbeatInterval)clearInterval(p.heartbeatInterval);this.players.clear();this.disconnectedPlayers.clear();console.log(`[ROOM ${this.roomCode}] Destroyed`);}
}

// ================================================================
// SOCKET HANDLERS
// ================================================================
const gameRooms=new Map();

io.on('connection',(socket)=>{
  console.log(`[SERVER] Connected: ${socket.id}`);

  socket.on('create-room',()=>{const c=GameRoom.generateRoomCode();const r=new GameRoom(c,'local');gameRooms.set(c,r);r.setHost(socket);socket.join(c);});

  socket.on('create-remote-room',()=>{
    const c=GameRoom.generateRoomCode();const r=new GameRoom(c,'remote');gameRooms.set(c,r);r.serverGame=new ServerGame(r);socket.join(c);
    const pd=r.addPlayer(socket,socket.id);if(!pd)return;
    socket.emit('join-success',{slotNumber:pd.slotNumber,color:pd.color,deviceFingerprint:socket.id,roomCode:c,mode:'remote'});
    console.log(`[ROOM ${c}] Remote room created by Player 1`);
  });

  socket.on('join-room',(data)=>{
    const r=gameRooms.get(data.roomCode);if(!r){socket.emit('join-failed',{reason:'Room not found'});return;}
    const pd=r.addPlayer(socket,data.deviceFingerprint);if(!pd)return;
    socket.join(data.roomCode);socket.emit('join-success',{slotNumber:pd.slotNumber,color:pd.color,deviceFingerprint:pd.deviceFingerprint,roomCode:data.roomCode,mode:r.mode});
  });

  socket.on('player-ready',        (d)=>{const r=gameRooms.get(d.roomCode);if(r)r.handleReady(socket.id);});
  socket.on('player-input',        (d)=>{const r=gameRooms.get(d.roomCode);if(r)r.relayPlayerInput(socket.id,d.input);});
  socket.on('mystery-box-purchase',(d)=>{const r=gameRooms.get(d.roomCode);if(r)r.handleMysteryBox(socket.id);});
  socket.on('vending-purchase',    (d)=>{const r=gameRooms.get(d.roomCode);if(r)r.handleVending(socket.id);});
  socket.on('restart-vote',        (d)=>{const r=gameRooms.get(d.roomCode);if(r)r.handleRestartVote(socket.id);});
  socket.on('restart-vote-remote', (d)=>{const r=gameRooms.get(d.roomCode);if(r)r.handleRestartVote(socket.id);});
  socket.on('game-state-broadcast',(d)=>{const r=gameRooms.get(d.roomCode);if(r)r.broadcastLocalGameState(d.gameState);});
  socket.on('explosion',           (d)=>{const r=gameRooms.get(d.roomCode);if(r)r.broadcastExplosion({x:d.x,y:d.y,color:d.color});});
  socket.on('ping-measure',()=>socket.emit('pong-ack'));

  socket.on('disconnect',()=>{
    console.log(`[SERVER] Disconnected: ${socket.id}`);
    for(let[code,room]of gameRooms.entries()){
      if(room.players.has(socket.id)){room.handleDisconnect(socket.id);break;}
      if(room.hostSocket&&room.hostSocket.id===socket.id){room.destroy();gameRooms.delete(code);break;}
    }
  });
});

const PORT=process.env.PORT||3000;
server.listen(PORT,'0.0.0.0',()=>{
  console.log('============================================');
  console.log('  Z-TEAM Server — v2.2 (bug fixes)');
  console.log('============================================');
  console.log(`  Port        : ${PORT}`);
  console.log(`  Logic rate  : ${TICK_RATE}Hz`);
  console.log(`  Broadcast   : ${BROADCAST_RATE}Hz  (lag fix)`);
  console.log(`  Boss skip   : fixed (_advanceWave guard)`);
  console.log(`  Last shard  : fixed (real array index)`);
  console.log('============================================');
});
