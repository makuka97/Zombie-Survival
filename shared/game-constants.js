// ================================================================
// SHARED GAME CONSTANTS — Z-TEAM
// Single source of truth for both server.js and index.html
// ================================================================
// Usage:
//   Node/server:  const C = require('./shared/game-constants');
//   Browser:      <script src="/shared/game-constants.js"></script>
//                 then access window.GAME_CONSTANTS or destructure via
//                 const { WEAPONS, ZOMBIE_TYPES, ... } = GAME_CONSTANTS;
// ================================================================

const GAME_CONSTANTS = (() => {

  // ── Canvas / Arena ───────────────────────────────────────────
  const CANVAS_W = 1334;
  const CANVAS_H = 750;
  const WALL     = 6;   // border inset — inner edge at 6px

  // ── Player ───────────────────────────────────────────────────
  const PLAYER_SIZE   = 28;
  const PLAYER_COLORS = ['#00ffff', '#ff44ff', '#4488ff', '#ffff00'];
  const MAX_PLAYERS   = 4;

  // ── Bullet ───────────────────────────────────────────────────
  const BULLET_SIZE = 6;

  // NOTE: PLAYER_SPEED and BULLET_SPEED differ between server and client
  // because the server runs at 60Hz tick rate (half of 120fps rAF equivalent)
  // while the client runs at 60fps rAF.
  //   server  → PLAYER_SPEED: 1.25,  BULLET_SPEED: 4
  //   client  → PLAYER_SPEED: 2.5,   BULLET_SPEED: 8
  // These are intentionally kept local to each file.

  // ── Drops ────────────────────────────────────────────────────
  const AMMO_DROP_CHANCE   = 0.3;
  const HEALTH_DROP_CHANCE = 0.08;

  // ── Mystery Box ──────────────────────────────────────────────
  const MYSTERY_BOX_COST = 1500;
  const BOX_USE_RANGE    = 120;

  // ── Health Vending Machine ────────────────────────────────────
  const VENDING_BASE_COST   = 500;
  const VENDING_COST_STEP   = 50;
  const VENDING_HEAL_AMOUNT = 25;
  const VENDING_USE_RANGE   = 120;

  // ── Melee (knife) ────────────────────────────────────────────
  // Knife: 15 damage per swing. Regular (25 HP) = 2 swings, Runner (15 HP) = 1 swing, Tank (150 HP) = 10 swings.
  const MELEE_DAMAGE = 15;
  const MELEE_RANGE  = 55;
  const MELEE_ARC    = Math.PI * 0.6;

  // ── Revive ───────────────────────────────────────────────────
  const REVIVE_RADIUS = 40;
  const REVIVE_TIME   = 3000; // ms

  // ── Boss ─────────────────────────────────────────────────────
  const BOSS_RADIUS = 90;
  const BOSS_PAD    = BOSS_RADIUS + 35;

  // ── Networking ───────────────────────────────────────────────
  const GRACE_PERIOD_MS = 30000; // ms before disconnected slot is freed
  const HEARTBEAT_MS    = 2000;

  // ── Spawn positions ──────────────────────────────────────────
  const PLAYER_SPAWNS = [
    { x: 80,   y: 80  },
    { x: 1254, y: 80  },
    { x: 80,   y: 670 },
    { x: 1254, y: 670 }
  ];

  // ── Weapons ──────────────────────────────────────────────────
  // name: display label (client uses this for HUD)
  // damage, fireRate, ammoCapacity: used by both server and client
  // rarity: used by mystery box roll
  const WEAPONS = {
    pistol:     { name: 'Pistol',        damage: 8,  fireRate: 10, ammoCapacity: 30                      },
    smg:        { name: 'SMG',           damage: 6,  fireRate: 5,  ammoCapacity: 60,  rarity: 'common'   },
    shotgun:    { name: 'Shotgun',       damage: 12, fireRate: 20, ammoCapacity: 24,  rarity: 'common'   },
    ar:         { name: 'Assault Rifle', damage: 10, fireRate: 7,  ammoCapacity: 45,  rarity: 'rare'     },
    lmg:        { name: 'LMG',           damage: 9,  fireRate: 8,  ammoCapacity: 100, rarity: 'rare'     },
    raygun:     { name: 'Ray Gun',       damage: 30, fireRate: 12, ammoCapacity: 20,  rarity: 'legendary'},
    thundergun: { name: 'Thundergun',    damage: 60, fireRate: 30, ammoCapacity: 8,   rarity: 'legendary'},
    minigun:    { name: 'Minigun',       damage: 6,  fireRate: 2,  ammoCapacity: 200, rarity: 'rare'     },
    plasma:     { name: 'Plasma Beam',   damage: 45, fireRate: 18, ammoCapacity: 15,  rarity: 'legendary'},
    chainsaw:   { name: 'Chainsaw',      damage: 15, fireRate: 4,  ammoCapacity: Infinity, rarity: 'rare', melee: true },
  };

  // ── Kill Tiers (weapon upgrade progression) ───────────────────
  // Each tier unlocks at a kill threshold and applies a flat damage
  // multiplier and ammo bonus on top of the base weapon stats.
  // Stacks with mystery box — box rolls the weapon, tier modifies it.
  // NOTE: speed values are CLIENT speeds (full 60fps).
  // Server divides by 2 automatically in spawnZombie() — see server.js comment.
  //
  // bomber.weight = 0 here because it's controlled dynamically:
  //   rollZombieType() sets it to 15 after wave 5.
  // ── Zombie base stats ─────────────────────────────────────────
  // HP and speed here are BASE values for wave 1.
  // Server scales them per wave: hp *= 1 + (wave-1)*0.2, speed *= 1 + (wave-1)*0.05
  // Wave 1: easy. Wave 5: ~1.8x HP. Wave 10: ~2.8x HP — gradual CoD-like curve.
  const ZOMBIE_TYPES = {
    regular: { size: 28, color: '#00cc00', borderColor: '#00ff00', speed: 0.85,  hp: 25,  points: 60,  weight: 70 },
    runner:  { size: 20, color: '#cccc00', borderColor: '#ffff00', speed: 1.7,  hp: 15,  points: 80,  weight: 20 },
    tank:    { size: 40, color: '#cc0000', borderColor: '#ff0000', speed: 0.5, hp: 120, points: 150, weight: 10 },
    bomber:  { size: 26, color: '#0055ff', borderColor: '#4499ff', speed: 1.1,  hp: 22,  points: 100, weight: 0  }
  };

  // ── Bomber explosion ─────────────────────────────────────────
  const BOMBER_BLAST_RADIUS  = 80;
  const BOMBER_PLAYER_DAMAGE = 20;
  const BOMBER_CHAIN_DEPTH   = 3;   // max recursion depth for chain explosions

  // ── Boss cycle ───────────────────────────────────────────────
  // Cycles every 5 waves: wave 5→triangle, 10→octagon, 15→pentagon,
  //                        20→diamond, 25→spiral, 30+→fractal (repeats)
  const BOSS_TYPES = ['triangle', 'octagon', 'pentagon', 'diamond', 'spiral', 'fractal', 'octopus', 'snake'];

  // ── Boss configs ─────────────────────────────────────────────
  // Static data only — dynamic state (x, y, rotation, etc.) is created at spawn time.
  const BOSS_CONFIGS = {
    triangle: {
      radius: 90, color: '#8844cc', pad: 125, label: 'TRIANGLE BOSS',
      tips: { count: 3, hp: 120 }
    },
    octagon: {
      radius: 80, color: '#ff6600', pad: 90,  label: 'OCTAGON',
      corners: { count: 8, hp: 60 },
      shootInterval: 45   // faster than before (was 60)
    },
    pentagon: {
      radius: 85, color: '#00aaff', pad: 110, label: 'PENTAGON',
      panels: { count: 5, hp: 200 },
      gapAngle: Math.PI * 0.18
    },
    diamond: {
      radius: 75, color: '#ff44aa', pad: 85,  label: 'DIAMOND',
      coreHp: 400,
      shardHp: 120, shardRadius: 38, shardPad: 48
    },
    spiral: {
      radius: 70, color: '#44ffaa', pad: 140, label: 'SPIRAL',
      arms: { count: 5, hp: 100 }
    },
    fractal: {
      radius: 95, color: '#ffdd00', pad: 130, label: 'FRACTAL',
      pieceHp: 180, splitThreshold: 30, splitScale: 0.55, splitCount: 3
    },
    octopus: {
      radius: 55, color: '#cc44ff', pad: 80, label: 'THE OCTOPUS',
      tentacleCount: 8, tentacleHp: 80,
      tentacleLength: 220,
      grabDamage: 8,
      throwDamage: 35,
    },
    snake: {
      radius: 22,          // head/segment radius
      color: '#00cc44',    // body color
      headColor: '#ff4400',// head color
      pad: 30, label: 'THE SERPENT',
      segmentCount: 8,     // body segments behind head
      segmentSpacing: 38,  // px between segment centers
      headHp: 300,         // only head takes damage
      bodyDamage: 8,       // damage per frame touching body
      headDamage: 25,      // damage on head contact
      moveSpeed: 4.2,      // base movement speed
      gooCount: 3,         // goo projectiles per burst
      gooDamage: 12,       // damage per goo hit
      gooSpeed: 3.5,
      gooInterval: 90,     // frames between goo bursts
      dirChangeInterval: 120, // frames between direction changes

    }
  };

  // ── Public export ─────────────────────────────────────────────
  return {
    // Arena
    CANVAS_W, CANVAS_H, WALL,
    // Player
    PLAYER_SIZE, PLAYER_COLORS, MAX_PLAYERS, PLAYER_SPAWNS,
    // Bullet
    BULLET_SIZE,
    // Drops
    AMMO_DROP_CHANCE, HEALTH_DROP_CHANCE,
    // Mystery box
    MYSTERY_BOX_COST, BOX_USE_RANGE,
    // Vending machine
    VENDING_BASE_COST, VENDING_COST_STEP, VENDING_HEAL_AMOUNT, VENDING_USE_RANGE,
    // Melee
    MELEE_DAMAGE, MELEE_RANGE, MELEE_ARC,
    // Revive
    REVIVE_RADIUS, REVIVE_TIME,
    // Boss
    BOSS_RADIUS, BOSS_PAD, BOSS_TYPES, BOSS_CONFIGS,
    // Network
    GRACE_PERIOD_MS, HEARTBEAT_MS,
    // Game data
    WEAPONS, ZOMBIE_TYPES,
    // Bomber
    BOMBER_BLAST_RADIUS, BOMBER_PLAYER_DAMAGE, BOMBER_CHAIN_DEPTH
  };
})();

// ── Node.js export (server.js uses require()) ─────────────────
if (typeof module !== 'undefined' && module.exports) {
  module.exports = GAME_CONSTANTS;
}
