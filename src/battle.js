import {W, H, DT, MCOLS, MROWS} from './constants.js';

// Per-area encounter table (MG2.EXE disasm 0x1aa6-0x1e53).
//   biomeX = row index into encounterPool[1][biome] (group 1 = dungeons)
//   enemy  = the value MG2.EXE writes to cs:[0xb1ed]; never read by
//            ATT.LOD for random encounters (biome is what counts)
// Areas not in this table have NO random encounters. Areas 1-4 instead
// use the outdoor path: biome comes from SMAPNN.ATS at the player's
// tile and the pool row is from group 0 (weak outdoor pool).
const AREA_ENEMY = {
  0x0B: {enemy: 0x0C, biomeX: 5},
  0x1C: {enemy: 0x0A, biomeX: 23},
  0x32: {enemy: 0x02, biomeX: 0},
  0x3C: {enemy: 0x14, biomeX: 1},
  0x3E: {enemy: 0x02, biomeX: 2},
  0x3F: {enemy: 0x1C, biomeX: 12},
  0x40: {enemy: 0x15, biomeX: 4},
  0x41: {enemy: 0x02, biomeX: 6},
  // 0x42-0x45: single range check at disasm 0x1c3b (shared enemy id).
  0x42: {enemy: 0x0F, biomeX: 8}, 0x43: {enemy: 0x0F, biomeX: 8},
  0x44: {enemy: 0x0F, biomeX: 8}, 0x45: {enemy: 0x0F, biomeX: 8},
  0x47: {enemy: 0x08, biomeX: 14},
  0x48: {enemy: 0x14, biomeX: 13},
  0x4A: {enemy: 0x14, biomeX: 9},
  0x4B: {enemy: 0x19, biomeX: 20},
  0x4C: {enemy: 0x09, biomeX: 18},
  0x4D: {enemy: 0x1B, biomeX: 19},
  0x4E: {enemy: 0x16, biomeX: 7},
  0x4F: {enemy: 0x16, biomeX: 15},
  0x50: {enemy: 0x0F, biomeX: 17},
  0x51: {enemy: 0x1F, biomeX: 22},
  0x59: {enemy: 0x18, biomeX: 3},
  0x5F: {enemy: 0x20, biomeX: 11},
  0x78: {enemy: 0x11, biomeX: 21},
  0x80: {enemy: 0x12, biomeX: 24},
  0xAD: {enemy: 0x18, biomeX: 16},
  0xAE: {enemy: 0x14, biomeX: 10},
};

// Maximum encounter tier per area band. Caps the encounter-counter
// tier so a level-1 hero never gets a tier-4 monster in the starting
// wilderness no matter how long they wander.
function maxTierForArea(aid){
  if(aid <= 4)   return 1;
  if(aid <= 30)  return 2;
  if(aid <= 69)  return 3;
  return 4;
}

// Hand-labelled display names by ENEMY.TOS sprite index. Monsters not
// listed fall back to "怪 #N". Stats come from ENEMY.DAT at runtime.
const ENEMY_NAMES = {
  0: '小拳童', 1: '槍兵',   2: '蠍怪',   3: '蜘蛛',   4: '魔法師',
  5: '紅眼獸', 6: '蜥蜴怪', 7: '蜥蜴',   8: '蟲蛇',   9: '赤魔巨人',
  10:'蛆',     12:'甲蟲',   13:'海魔女', 14:'綠甲蟲', 15:'藍水怪',
  16:'紅蜥蜴', 17:'石龍蜥', 18:'烈焰',   19:'虎牙妖', 20:'食人花',
  27:'魔蛋',   29:'海妖',   37:'便便怪', 38:'石巨人', 50:'火龍',
  55:'金剛蟾', 57:'綠毛蟲', 63:'影忍',   79:'鯊魚',   80:'綠龍',
  81:'眼鏡蛇', 84:'幽靈姬', 86:'綠飛龍', 100:'豺狼',  102:'女幽靈',
  105:'鐵騎士',110:'毒蜂',  122:'金小童',165:'骷髏王',171:'便便團',
  195:'銀毛蟲',196:'紅毛蟲',218:'魔翼獸',219:'死神',  229:'妖魔',
  234:'獄使',  235:'豹',    279:'狂戰士',286:'大魔龍',
};

// Full monster profile: real ENEMY.DAT stats + labelled name (or
// "怪 #N" if unlabelled). `id` is the ENEMY.TOS sprite index — 1:1 with
// the ENEMY.DAT record index.
function profileFor(id, enemyStats){
  const stats = enemyStats && enemyStats[id];
  if(!stats){
    return {name: '怪 #' + id, hp: 12, atk: 5, def: 1, spd: 4,
            mgAtk: 0, mgDef: 0, exp: 8, gold: 5, sprite: id};
  }
  return {
    name:  ENEMY_NAMES[id] || ('怪 #' + id),
    hp:    stats.hp,      maxHp:  stats.maxHp,
    mp:    stats.mp,      maxMp:  stats.maxMp,
    atk:   stats.atk,     def:    stats.def,
    spd:   stats.spd,
    mgAtk: stats.mgAtk,   mgDef:  stats.mgDef,
    exp:   stats.exp,     gold:   stats.gold,
    element: stats.element,
    sprite: id,
  };
}

// Pick a monster for the current area (mirrors ATT.LOD CS:0xb471).
// Returns `{enemy, biomeX, group}` with `enemy` = ENEMY.DAT record id,
// or null when this area has no random encounters.
//
//   Outdoor (aid 1-4): group 0, biome = SMAP0N.ATS[pY*208+pX] (per-tile)
//   Dungeon (AREA_ENEMY[aid]): group 1, biome = AREA_ENEMY[aid].biomeX
//   Unmapped: null
//
// `encounterPool[group][biome][RNG(0..9)]` yields the enemy id.
function pickEnemy(state, pool, atsMap){
  const aid = state.curArea;
  let group, biome;
  if(aid >= 1 && aid <= 4){
    group = 0;
    const ats = atsMap && atsMap[aid];
    if(ats){
      const off = state.pY * MCOLS + state.pX;
      biome = (off < ats.length) ? ats[off] : 0;
    } else {
      biome = 0;   // area 4 lacks an ATS file on disk; default pool row
    }
  } else if(AREA_ENEMY[aid]){
    group = 1;
    biome = AREA_ENEMY[aid].biomeX;
  } else {
    return null;
  }
  if(!pool || !pool[group] || !pool[group][biome]) return null;
  const row = pool[group][biome];
  // Filter out zero entries — some biomes have fewer than 10 valid slots.
  const candidates = row.filter(x => x !== 0);
  if(candidates.length === 0) return null;
  const enemy = candidates[Math.floor(Math.random() * candidates.length)];
  return {enemy, biomeX: biome, group};
}

// Encounter counter — disasm 0x1893/0x1965/0x1ED3.
function postBattleReset(curArea){
  if(curArea <= 4) return 0x50;
  if(curArea === 0x4F) return 0xAA;
  if(curArea >= 0x42 && curArea <= 0x45) return 0x3E;
  return 0x82;
}

// Spell library (id → effect). Index also matches M.15's glyph entry
// for the spell name. Effects are engine-defined since MG2.EXE doesn't
// surface spell stats in a way we've decoded yet. Exported so save/load
// can re-hydrate `state.spells` from just a list of {id}.
export const SPELL_LIB = {
  0:  {id: 0,  name: '火',     mpCost: 3,  kind: 'damage', power: 8,  target: 'single'},
  1:  {id: 1,  name: '回復',   mpCost: 4,  kind: 'heal',   power: 20, target: 'self'},
  2:  {id: 2,  name: '冰',     mpCost: 5,  kind: 'damage', power: 12, target: 'single'},
  3:  {id: 3,  name: '雷',     mpCost: 8,  kind: 'damage', power: 18, target: 'all'},
  4:  {id: 4,  name: '大回復', mpCost: 10, kind: 'heal',   power: 60, target: 'self'},
  5:  {id: 5,  name: '聖光',   mpCost: 14, kind: 'damage', power: 28, target: 'all'},
};

// Spells granted at each level milestone (cumulative).
const LEVEL_UP_GRANTS = {
  3:  [{id: 2}],   // 冰 (ice)
  5:  [{id: 3}],   // 雷 (thunder)
  8:  [{id: 4}],   // 大回復 (major heal)
  12: [{id: 5}],   // 聖光 (holy)
};

// Authentic per-level-up stat growth extracted from ATT.LOD at 0x1d50-0x2091
// (hero = party member 0). Each stat has a fixed base + a capped random
// bonus:
//
//   maxHp  += 6 + RNG(0..3)   (then current HP snapped to new max)
//   maxMp  += 4 + RNG(0..2)   (current MP snapped to new max)
//   atk    += 2 + RNG(0..3)
//   def    += 2 + RNG(0..3)
//   spd    += 2 + RNG(0..2)
//   mgAtk  += 2 + RNG(0..2)
//   mgDef  += 2 + RNG(0..2)
//
// ATT.LOD uses RNG(0..N-1) via `mov bx, N; call 0x763`; we mirror that with
// `Math.floor(Math.random() * N)` → same uniform half-open range [0, N).
function rnd(n){ return Math.floor(Math.random() * n); }
const STAT_GROWTH = [
  ['maxHp', 6, 4],
  ['maxMp', 4, 3],
  ['atk',   2, 4],
  ['def',   2, 4],
  ['spd',   2, 3],
  ['mgAtk', 2, 3],
  ['mgDef', 2, 3],
];

// EXP threshold for advancing FROM `level` to `level+1`. Reads the table
// that ATT.LOD's level-up routine consults (disasm 0x1c69); when the table
// is absent (older saves) fall back to a simple linear curve so the engine
// still boots. See parsers.js `parseATTLevelTable` for the source data.
function makeExpForLevel(table){
  return function(level){
    if(!table) return level * 50;
    const v = level <= 0 ? table[0] : (level - 1 < table.length ? table[level - 1] : 0x84D0);
    return v + rnd((v >> 8) + 1);
  };
}

// Effect of using a consumable in battle. `source` comes from the .15
// table that named the item (P.15=potion → HP heal, M.15=magic → MP
// restore). Anything else (weapon / misc) is unusable in combat.
function itemEffect(item){
  if(item.source === 'potion') return {kind: 'heal', power: 25, target: 'self', label: 'HP'};
  if(item.source === 'magic')  return {kind: 'mp',   power: 10, target: 'self', label: 'MP'};
  return null;
}

export function createBattleSystem(state, areas, npcFrames, playerFrames, enemyFrames, enemyStats, encounterPool, atsMap, levelExpTable){
  const expForLevel = makeExpForLevel(levelExpTable);
  let encounterCounter = 30;
  let battle = null;
  let inventory = null;     // wired by setInventory at boot

  function setInventory(inv){ inventory = inv; }

  function battlesAllowed(){
    const a = areas[state.curArea];
    if(!a) return false;
    return a.flag !== 0;
  }

  function tryEncounter(){
    if(!battlesAllowed()) return false;
    encounterCounter = (encounterCounter - 1) & 0xFF;
    if(encounterCounter > 0x28) return false;
    const c = encounterCounter;
    let tier = c <= 1 ? 0 : c <= 10 ? 1 : c <= 20 ? 2 : c <= 30 ? 3 : 4;
    // Lock the tier to what this area can actually spawn — no tier-4
    // monsters in the starting wilderness.
    tier = Math.min(tier, maxTierForArea(state.curArea));
    const chance = 0.05 + tier * 0.05;
    if(Math.random() > chance) return false;
    const pick = pickEnemy(state, encounterPool, atsMap);
    // Strict area boundary — if this area has no monster table, abort.
    // Also reset the counter so we don't keep stepping the encounter
    // logic on every step in a battle-disabled area.
    if(!pick){
      encounterCounter = postBattleReset(state.curArea);
      return false;
    }
    startBattle(tier, pick);
    encounterCounter = postBattleReset(state.curArea);
    return true;
  }

  // Living members (hp > 0). Used for turn order, target lists, and the
  // "any hero still standing?" check.
  function aliveParty(){
    return (state.party || []).filter(m => m.hp > 0);
  }

  function startBattle(tier, pick){
    const baseEnemy = pick?.enemy ?? 1;
    const count = 1 + Math.floor(Math.random() * Math.min(3, tier + 1));
    const enemies = [];
    // "Battle in the air": snapshot the overworld position, then teleport
    // the hero to a FIXED battle stance — right of the viewport facing
    // LEFT — so enemies always appear on the LEFT facing RIGHT regardless
    // of where the encounter fired. `endBattle` restores the snapshot.
    const groundX = state.pX, groundY = state.pY, groundDir = state.pdir;
    const mapRightEdge = 207, mapLeftEdge = 1;
    const desiredPX = Math.min(mapRightEdge - 4, groundX + 3);
    const battlePY = Math.max(10, Math.min(MROWS - 11, groundY));
    state.pX = Math.max(mapLeftEdge + 12, desiredPX);
    state.pY = battlePY;
    state.pdir = 2;              // LEFT (0=UP 1=DOWN 2=LEFT 3=RIGHT)
    const dx = -1;
    const enemyFacing = 3;       // RIGHT (toward hero)
    const BASE_DIST = 8;         // clears even a 150 px boss sprite
    // Vertical formation offsets by group size (tiles from player row).
    // Biased upward since the HUD hides the bottom ~4 tiles.
    const V_OFFSETS = {
      1: [ 0 ],
      2: [ -3,  3 ],
      3: [ -5,  0,  4 ],
      4: [ -6, -2,  2,  5 ],
    };
    const vOff = V_OFFSETS[count] || V_OFFSETS[3];
    // Odd-indexed slots step back 2 tiles so the formation becomes a
    // shallow V instead of a column.
    const depthOff = i => (i % 2 === 1 ? 2 : 0);
    for(let i = 0; i < count; i++){
      // Every monster in the party is the area's fixed enemy. MG2.EXE
      // writes a single `cs:[0xb1ed]` value per encounter; ATT.LOD fills
      // its party table with that id repeated.
      const id = baseEnemy;
      const p = profileFor(id, enemyStats);
      const hp = Math.max(1, p.hp);
      const lead = BASE_DIST + depthOff(i);
      const vSpread = vOff[i] ?? 0;
      let ex = state.pX + dx * lead;
      let ey = state.pY + vSpread;
      // Clamp so we never push an enemy off-map or into the panel area.
      // The vertical clamp is tighter than the map edges: pY - 9 is the top
      // of the visible viewport, and pY + 4 is the last row above the HUD.
      if(ex < 1) ex = 1;
      if(ex >= 207) ex = 206;
      const minY = Math.max(1, state.pY - 9);
      const maxY = Math.min(153, state.pY + 4);
      if(ey < minY) ey = minY;
      if(ey > maxY) ey = maxY;
      enemies.push({
        slot: i,
        enemy: id,
        sprite: p.sprite,
        facing: enemyFacing,
        name: p.name,
        mapX: ex, mapY: ey,
        hp, maxHp: hp,
        atk: p.atk,
        def: p.def,
        expReward:  p.exp,
        goldReward: p.gold,
        alive: true,
        flash: 0,
      });
    }
    // De-overlap pass: ENEMY.TOS sprites vary 37×28 … 159×112 and can
    // still collide after vertical clamping, so nudge overlappers 2
    // tiles apart using their real bbox (fall back to 80×70 if a frame
    // is missing). Sprites are bottom-center-anchored.
    for(let i = 1; i < enemies.length; i++){
      const a = enemies[i];
      const aSpr = enemyFrames && enemyFrames[a.sprite];
      const aW = aSpr?.w ?? 80, aH = aSpr?.h ?? 70;
      for(let j = 0; j < i; j++){
        const b = enemies[j];
        const bSpr = enemyFrames && enemyFrames[b.sprite];
        const bW = bSpr?.w ?? 80, bH = bSpr?.h ?? 70;
        const ax = a.mapX * 12 + 6 - aW / 2, ay = a.mapY * 10 + 10 - aH;
        const bx = b.mapX * 12 + 6 - bW / 2, by = b.mapY * 10 + 10 - bH;
        const overlap = ax < bx + bW && ax + aW > bx && ay < by + bH && ay + aH > by;
        if(overlap){
          const maxY = Math.min(153, state.pY + 4);
          if(a.mapY < maxY) a.mapY += 2;
          else a.mapY = Math.max(1, a.mapY - 2);
          j = -1;
        }
      }
    }
    battle = {
      tier,
      biomeX: pick?.biomeX ?? 0,
      enemies,
      // Snapshot the overworld position + facing so endBattle can
      // "return to ground" after the airborne fight.
      ground: {x: groundX, y: groundY, dir: groundDir},
      // UI mode machine:
      //   'intro'   — "敵人出現！" banner
      //   'select'  — active party member is picking an action
      //   'target'  — picking target for Attack/single-target Magic
      //   'magic'   — spell submenu
      //   'item'    — inventory submenu
      //   'execute' — running queued actions one by one
      //   'anim'    — brief pause showing action result
      //   'done'    — battle finished
      mode: 'intro',
      menu: 0,              // index into 6-command grid (0..5)
      sub: 0,               // index within magic/item submenu
      activeIdx: 0,         // which party member is picking
      action: null,         // pending action being configured
      target: 0,
      queue: [],            // [{actor: {type:'party'|'enemy', ref}, action: {...}, spd}]
      queueIdx: 0,
      msg: '敵人出現！',
      msgTimer: 1100,
      pending: null,        // 'victory' | 'flee' | 'nextturn'
    };
    // Reset per-member battle state.
    for(const m of state.party) m.defending = 0;
    state.state = state.ST.BATTLE;
    // Camera snap — the player just teleported from the overworld
    // position to the battle stance, and the cam is driven by state.cX/cY
    // which were computed off the ground position. Recompute against the
    // new pX/pY so the battle renders at the right 2/3 of the viewport.
    if(state.updateCam) state.updateCam();
  }

  // Advance to the next selecting party member, OR enqueue enemy turns and
  // switch to execute mode when all party members chose.
  function advanceSelection(){
    const alive = aliveParty();
    let next = battle.activeIdx;
    do { next++; } while(next < state.party.length && state.party[next].hp <= 0);
    if(next < state.party.length){
      battle.activeIdx = next;
      battle.mode = 'select';
      battle.menu = 0;
      return;
    }
    // All alive heroes have chosen — queue enemy actions now.
    for(const e of battle.enemies){
      if(!e.alive) continue;
      // Pick a random alive party member as target.
      const alives = aliveParty();
      if(!alives.length) break;
      const target = alives[Math.floor(Math.random() * alives.length)];
      battle.queue.push({
        actor: {type: 'enemy', ref: e},
        action: {kind: 'enemyAttack', target},
        spd: 1 + Math.floor(battle.tier / 2),    // enemies roughly match tier
      });
    }
    // Sort queue by actor speed (higher goes first).
    battle.queue.sort((a, b) => b.spd - a.spd);
    battle.queueIdx = 0;
    battle.mode = 'execute';
    battle.msgTimer = 250;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Action helpers — each returns a short message for the log.
  // ──────────────────────────────────────────────────────────────────────

  function aliveEnemies(){
    return battle.enemies.filter(e => e.alive);
  }

  // MG2's physical-damage formula (disasm ATT.LOD CS:0x2782-0x27c4):
  //   if ATK > DEF:  damage = (ATK - DEF) + random(0..5)
  //   else:          damage = random(0..1)      ← effectively a miss
  //   if defender defending:  damage /= 2
  // No floor at 1 — MG2 really lets a hit do 0 damage when your weapon
  // can't bite. We mirror that, but clamp to 0 (not negative).
  function mg2Damage(atk, def, defending){
    let dmg;
    if(atk > def){
      dmg = (atk - def) + Math.floor(Math.random() * 6);
    } else {
      dmg = Math.floor(Math.random() * 2);
    }
    if(defending) dmg = Math.floor(dmg / 2);
    return Math.max(0, dmg);
  }

  function damageEnemy(e, raw){
    const dmg = mg2Damage(raw, e.def, false);
    e.hp -= dmg;
    e.flash = 350;
    if(e.hp <= 0){ e.hp = 0; e.alive = false; }
    return dmg;
  }

  function damagePlayer(raw){
    const dmg = mg2Damage(raw, state.def, false);
    state.hp -= dmg;
    if(state.hp < 0) state.hp = 0;
    return dmg;
  }

  function damageMember(m, raw){
    const dmg = mg2Damage(raw, m.def, m.defending > 0);
    m.hp -= dmg;
    if(m.hp < 0) m.hp = 0;
    return dmg;
  }

  // Resolve one queued action. Called per animation step from the execute
  // phase so the player sees each action play out.
  function runQueuedAction(entry){
    const {actor, action} = entry;
    if(actor.type === 'party'){
      const m = actor.ref;
      if(m.hp <= 0){ battle.msg = m.name + ' 倒下'; return; }
      if(action.kind === 'attack'){
        const e = action.target;
        if(!e || !e.alive){
          // Retarget to any alive enemy if the original fell this turn.
          const alt = aliveEnemies()[0];
          if(!alt){ battle.msg = '?'; return; }
          action.target = alt;
        }
        const raw = m.atk + Math.floor(Math.random() * 4);
        const dmg = damageEnemy(action.target, raw);
        battle.msg = m.name + ' → ' + action.target.name + ' -' + dmg;
      } else if(action.kind === 'magic'){
        const sp = action.spell;
        if(m.mp < sp.mpCost){ battle.msg = m.name + ' MP不足'; return; }
        m.mp -= sp.mpCost;
        if(sp.kind === 'damage'){
          if(sp.target === 'all'){
            let total = 0;
            for(const e of battle.enemies) if(e.alive){
              total += damageEnemy(e, sp.power + m.mgAtk + Math.floor(Math.random() * 4));
            }
            battle.msg = m.name + ' ' + sp.name + ' -' + total;
          } else {
            const e = action.target;
            if(!e || !e.alive){ battle.msg = '?'; return; }
            const dmg = damageEnemy(e, sp.power + m.mgAtk + Math.floor(Math.random() * 4));
            battle.msg = m.name + ' ' + sp.name + ' → ' + e.name + ' -' + dmg;
          }
        } else if(sp.kind === 'heal'){
          const tgt = action.healTarget || m;
          const heal = Math.min(tgt.maxHp - tgt.hp, sp.power + Math.floor(m.mgAtk / 2));
          tgt.hp += heal;
          battle.msg = m.name + ' ' + sp.name + ' → ' + tgt.name + ' +' + heal;
        }
      } else if(action.kind === 'item'){
        const it = action.item;
        const eff = itemEffect(it);
        if(!eff){ battle.msg = '?'; return; }
        const tgt = action.healTarget || m;
        if(eff.kind === 'heal'){
          const heal = Math.min(tgt.maxHp - tgt.hp, eff.power);
          tgt.hp += heal;
          battle.msg = m.name + ' 使用物品 +' + heal + ' HP';
        } else if(eff.kind === 'mp'){
          const r = Math.min(tgt.maxMp - tgt.mp, eff.power);
          tgt.mp += r;
          battle.msg = m.name + ' 使用魔水 +' + r + ' MP';
        }
        if(--it.count <= 0){
          const idx = inventory.indexOf(it);
          if(idx >= 0) inventory.splice(idx, 1);
        }
      } else if(action.kind === 'defend'){
        m.defending = 1;
        battle.msg = m.name + ' 防禦';
      } else if(action.kind === 'flee'){
        if(Math.random() < 0.7){
          battle.msg = '逃走成功';
          battle.pending = 'flee';
        } else {
          battle.msg = '逃不掉!';
        }
      }
    } else {
      // Enemy action — single-target attack on `action.target` (a party member).
      const e = actor.ref;
      if(!e.alive) return;
      // Reroute if original target fell.
      if(!action.target || action.target.hp <= 0){
        const alives = aliveParty();
        if(!alives.length) return;
        action.target = alives[Math.floor(Math.random() * alives.length)];
      }
      const raw = e.atk + Math.floor(Math.random() * 3);
      const dmg = damageMember(action.target, raw);
      battle.msg = e.name + ' → ' + action.target.name + ' -' + dmg;
    }
  }

  function checkVictory(){
    if(aliveEnemies().length > 0) return false;
    // Sum rewards across all defeated enemies — each carries its own
    // exp/gold from the ENEMY_PROFILE entry.
    let exp = 0, gold = 0;
    for(const e of battle.enemies){
      exp  += e.expReward  ?? (8 + e.maxHp);
      gold += e.goldReward ?? (5 + battle.tier * 8);
    }
    state.gold += gold;
    state.exp  += exp;
    let levelMsg = '';
    while(state.exp >= expForLevel(state.level)){
      state.exp -= expForLevel(state.level);
      state.level++;
      // Authentic growth — see STAT_GROWTH comment above for the ATT.LOD
      // addresses this mirrors.
      for(const [key, base, rngBound] of STAT_GROWTH){
        state[key] = (state[key] || 0) + base + rnd(rngBound);
      }
      // Level-up fully restores HP and MP (ATT.LOD doesn't snap current ←
      // max for atk/def/etc — only for HP and MP pairs at +0x00/+0x02 and
      // +0x04/+0x06).
      state.hp = state.maxHp;
      state.mp = state.maxMp;
      // Learn new spells at milestones.
      const grants = LEVEL_UP_GRANTS[state.level];
      if(grants){
        for(const g of grants){
          if(state.spells.find(s => s.id === g.id)) continue;
          const def = SPELL_LIB[g.id];
          if(def) state.spells.push({...def});
        }
      }
      levelMsg += ' Lv' + state.level + '!';
    }
    battle.msg = '勝利! +' + exp + 'EXP +' + gold + 'G' + levelMsg;
    battle.msgTimer = 2000 + (levelMsg ? 1200 : 0);
    battle.pending = 'victory';
    return true;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Tick — pumps the state machine on key press.
  // ──────────────────────────────────────────────────────────────────────

  // Active party member picking an action.
  function activeMember(){ return state.party[battle.activeIdx]; }

  // Called when the active member commits to an action. Pushes onto the
  // queue and advances to the next member's selection.
  function commitAction(action){
    const m = activeMember();
    battle.queue.push({
      actor: {type: 'party', ref: m},
      action,
      spd: m.spd + Math.floor(Math.random() * 3),
    });
    advanceSelection();
  }

  // Auto-action = attack first alive enemy. Used by the 自動 button for
  // quick grinding.
  function autoActionFor(){
    const tgt = aliveEnemies()[0];
    if(!tgt) return {kind: 'defend'};
    return {kind: 'attack', target: tgt};
  }

  // Teardown — restore the player to their pre-battle overworld position
  // ("return to the ground") and clear the battle object. Called from
  // every battle-exit path: victory, flee, defeat.
  function endBattle(){
    if(battle?.ground){
      state.pX = battle.ground.x;
      state.pY = battle.ground.y;
      state.pdir = battle.ground.dir;
      if(state.updateCam) state.updateCam();
    }
    battle = null;
    state.state = state.ST.PLAY;
  }

  function battleTick(pressedKey){
    if(!battle){ state.state = state.ST.PLAY; return; }
    for(const e of battle.enemies) if(e.flash > 0) e.flash -= DT;

    if(battle.msgTimer > 0){
      battle.msgTimer -= DT;
      if(battle.msgTimer > 0) return;
      // Message / animation interval elapsed — advance state machine.
      if(battle.pending === 'victory'){ endBattle(); return; }
      if(battle.pending === 'flee'){    endBattle(); return; }
      if(battle.mode === 'intro'){
        // Open selection on the first alive party member.
        battle.activeIdx = state.party.findIndex(m => m.hp > 0);
        battle.mode = 'select';
        battle.menu = 0;
        return;
      }
      if(battle.mode === 'execute'){
        // Play next queued action, if any.
        if(battle.queueIdx >= battle.queue.length){
          // Round over — reset defense flags, check win/lose, loop.
          for(const m of state.party) m.defending = 0;
          if(aliveParty().length === 0){
            battle.msg = '全滅…';
            battle.msgTimer = 1500;
            battle.pending = 'defeat';
            // Defeat doesn't "return to ground" — the game-over screen
            // takes over. Just tear down the battle object.
            battle = null;
            state.state = state.ST.OVER;
            return;
          }
          if(checkVictory()) return;
          battle.queue = [];
          battle.queueIdx = 0;
          battle.activeIdx = state.party.findIndex(m => m.hp > 0);
          battle.mode = 'select';
          battle.menu = 0;
          return;
        }
        const entry = battle.queue[battle.queueIdx++];
        runQueuedAction(entry);
        battle.msgTimer = 700;
        return;
      }
    }

    if(!pressedKey) return;
    const inv = inventory;

    if(battle.mode === 'select'){
      // 6-command grid in 3 cols × 2 rows:
      //   0=物品 1=攻擊 2=魔法
      //   3=防禦 4=自動 5=逃跑
      if(pressedKey === 'ArrowLeft')  battle.menu = (battle.menu + 5) % 6;
      if(pressedKey === 'ArrowRight') battle.menu = (battle.menu + 1) % 6;
      if(pressedKey === 'ArrowUp')    battle.menu = (battle.menu + 3) % 6;
      if(pressedKey === 'ArrowDown')  battle.menu = (battle.menu + 3) % 6;
      if(pressedKey === 'Space' || pressedKey === 'Enter'){
        const m = activeMember();
        if(battle.menu === 1){          // Attack
          battle.action = {kind: 'attack'};
          battle.target = battle.enemies.findIndex(e => e.alive);
          battle.mode = 'target';
        } else if(battle.menu === 2){   // Magic
          if(!m.spells || m.spells.length === 0){
            battle.msg = '魔法無'; battle.msgTimer = 600;
          } else {
            battle.sub = 0;
            battle.mode = 'magic';
          }
        } else if(battle.menu === 0){   // Items
          if(!inv || inv.length === 0){
            battle.msg = '物品無'; battle.msgTimer = 600;
          } else {
            battle.sub = 0;
            battle.mode = 'item';
          }
        } else if(battle.menu === 3){   // Defend
          commitAction({kind: 'defend'});
        } else if(battle.menu === 4){   // Auto
          commitAction(autoActionFor());
        } else if(battle.menu === 5){   // Flee
          commitAction({kind: 'flee'});
        }
      }
      return;
    }

    if(battle.mode === 'target'){
      const live = battle.enemies.map((e, i) => e.alive ? i : -1).filter(i => i >= 0);
      const cur = live.indexOf(battle.target);
      if(pressedKey === 'ArrowLeft' || pressedKey === 'ArrowUp'){
        battle.target = live[(cur + live.length - 1) % live.length];
      } else if(pressedKey === 'ArrowRight' || pressedKey === 'ArrowDown'){
        battle.target = live[(cur + 1) % live.length];
      } else if(pressedKey === 'Escape'){
        battle.mode = 'select'; return;
      } else if(pressedKey === 'Space' || pressedKey === 'Enter'){
        const tgt = battle.enemies[battle.target];
        const a = {...battle.action, target: tgt};
        commitAction(a);
      }
      return;
    }

    if(battle.mode === 'magic'){
      const m = activeMember();
      if(pressedKey === 'ArrowUp')   battle.sub = (battle.sub + m.spells.length - 1) % m.spells.length;
      if(pressedKey === 'ArrowDown') battle.sub = (battle.sub + 1) % m.spells.length;
      if(pressedKey === 'Escape'){ battle.mode = 'select'; return; }
      if(pressedKey === 'Space' || pressedKey === 'Enter'){
        const sp = m.spells[battle.sub];
        if(m.mp < sp.mpCost){ battle.msg = 'MP不足'; battle.msgTimer = 600; return; }
        if(sp.target === 'self'){
          commitAction({kind: 'magic', spell: sp, healTarget: m});
        } else if(sp.target === 'all'){
          commitAction({kind: 'magic', spell: sp});
        } else {
          battle.action = {kind: 'magic', spell: sp};
          battle.target = battle.enemies.findIndex(e => e.alive);
          battle.mode = 'target';
        }
      }
      return;
    }

    if(battle.mode === 'item'){
      if(pressedKey === 'ArrowUp')   battle.sub = (battle.sub + inv.length - 1) % inv.length;
      if(pressedKey === 'ArrowDown') battle.sub = (battle.sub + 1) % inv.length;
      if(pressedKey === 'Escape'){ battle.mode = 'select'; return; }
      if(pressedKey === 'Space' || pressedKey === 'Enter'){
        const it = inv[battle.sub];
        if(!itemEffect(it)){ battle.msg = '使用不能'; battle.msgTimer = 600; return; }
        const m = activeMember();
        commitAction({kind: 'item', item: it, healTarget: m});
      }
      return;
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Render
  // ──────────────────────────────────────────────────────────────────────

  // Resolve the canvas for one enemy. Prefer ENEMY.TOS (variable-size monster
  // sprites loaded by ATT.LOD CS:0xbc2a); fall back to POL001.TOS if a slot
  // is missing or ENEMY.TOS didn't load.
  function enemySpriteFor(e){
    const idx = e.sprite ?? 0;
    if(enemyFrames && enemyFrames[idx]) return enemyFrames[idx];
    // POL001 fallback: wrap as {w, h, canvas} so callers use one interface.
    if(npcFrames && npcFrames.length){
      const FALLBACK_DIR = [0, 2, 4, 6];
      const f = npcFrames[(idx * 8 + FALLBACK_DIR[e.facing ?? 1]) % npcFrames.length];
      return f ? {w: 24, h: 24, canvas: f} : null;
    }
    return null;
  }

  // Draw enemies on the area map at their world coords. Caller invokes this
  // BETWEEN drawNPCs and drawPlayer so player+foreground still layer over.
  // ENEMY.TOS sprites can be up to ~150×110 — bottom-center-anchor them so
  // the monster stands on its map tile instead of floating above.
  function drawBattleEnemies(ctx){
    if(!battle) return;
    ctx.imageSmoothingEnabled = false;
    for(let i = 0; i < battle.enemies.length; i++){
      const e = battle.enemies[i];
      if(!e.alive) continue;
      const cx = (e.mapX - state.cX) * 12;
      const cy = (e.mapY - state.cY) * 10;
      const spr = enemySpriteFor(e);
      if(!spr){ ctx.fillStyle = '#a00'; ctx.fillRect(cx-6, cy-14, 24, 24); continue; }
      // Anchor at bottom-center of the tile so tall monsters grow upward.
      const dx = Math.round(cx + 6 - spr.w / 2);
      const dy = Math.round(cy + 10 - spr.h);
      if(dx < -spr.w || dx > W || dy < -spr.h || dy > H) continue;
      ctx.drawImage(spr.canvas, dx, dy);
      if(e.flash > 0){
        ctx.fillStyle = `rgba(255,80,80,${Math.min(0.7, e.flash / 300)})`;
        ctx.fillRect(dx, dy, spr.w, spr.h);
      }
      // Stash the bounding box so HP bars / cursor render above the head.
      e._screenX = dx; e._screenY = dy; e._screenW = spr.w; e._screenH = spr.h;
    }
  }

  // HUD overlay — enemy HP bars + 6-command panel + party portrait/gauges.
  // Called AFTER renderForeground so it sits on top.
  function drawBattle(ctx){
    if(!battle) return;

    // Floating HP bar + target cursor above each living enemy, anchored to
    // the actual drawn sprite (ENEMY.TOS frames vary 37×28 … 150×110).
    ctx.textAlign = 'center';
    for(let i = 0; i < battle.enemies.length; i++){
      const e = battle.enemies[i];
      if(!e.alive) continue;
      const bx = e._screenX, by = e._screenY, bw = e._screenW;
      if(bx == null || bx < -bw || bx > W) continue;
      const barW = Math.min(bw, 48);
      const barX = bx + (bw - barW) / 2;
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(barX, by - 6, barW, 3);
      ctx.fillStyle = '#f44';
      ctx.fillRect(barX, by - 6, barW * Math.max(0, e.hp) / e.maxHp, 3);
      ctx.fillStyle = '#fff';
      ctx.font = '7px monospace';
      ctx.fillText(e.name, bx + bw / 2, by - 8);
      if(battle.mode === 'target' && battle.target === i){
        ctx.fillStyle = '#ff0';
        ctx.font = 'bold 10px monospace';
        ctx.fillText('▼', bx + bw / 2, by - 14);
      }
    }
    ctx.textAlign = 'left';

    // ── Bottom 44-px wood-grain command panel (fight1.png reference) ──
    const boxY = H - 44, boxH = 44;
    ctx.fillStyle = '#2a1810';
    ctx.fillRect(0, boxY, W, boxH);
    ctx.fillStyle = '#5a3520';
    ctx.fillRect(2, boxY + 2, W - 4, boxH - 4);
    ctx.strokeStyle = '#1a0a05';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, boxY + 0.5, W - 1, boxH - 1);

    // Left: 6-command grid (3 cols × 2 rows). Only shown during selection
    // modes — submenu states replace the grid with a list.
    const gridX = 6, gridY = boxY + 6;
    const cellW = 48, cellH = 16;
    const LABELS = ['物品', '攻擊', '魔法', '防禦', '自動', '逃跑'];
    if(battle.mode === 'select' || battle.mode === 'target' ||
       battle.mode === 'execute' || battle.mode === 'intro'){
      for(let i = 0; i < 6; i++){
        const col = i % 3, row = Math.floor(i / 3);
        const cx = gridX + col * cellW, cy = gridY + row * cellH;
        const sel = (battle.mode === 'select' && i === battle.menu);
        ctx.fillStyle = sel ? '#664020' : '#3a2010';
        ctx.fillRect(cx, cy, cellW - 2, cellH - 2);
        ctx.strokeStyle = sel ? '#ffc040' : '#1a0a05';
        ctx.strokeRect(cx + 0.5, cy + 0.5, cellW - 3, cellH - 3);
        ctx.fillStyle = sel ? '#ff8' : '#ddc';
        ctx.font = '9px monospace';
        ctx.fillText(LABELS[i], cx + 6, cy + 11);
      }
    } else if(battle.mode === 'magic'){
      const m = activeMember();
      ctx.fillStyle = '#ff8';
      ctx.font = '8px monospace';
      ctx.fillText('魔法', 6, boxY + 12);
      const visible = m.spells.slice(0, 4);
      for(let i = 0; i < visible.length; i++){
        const sp = visible[i];
        const col = i % 2, row = Math.floor(i / 2);
        const cx = 8 + col * 80, cy = boxY + 22 + row * 10;
        ctx.fillStyle = i === battle.sub ? '#ff0' : '#ddc';
        ctx.fillText((i === battle.sub ? '▶ ' : '  ') + sp.name + ' M' + sp.mpCost, cx, cy);
      }
    } else if(battle.mode === 'item'){
      ctx.fillStyle = '#ff8';
      ctx.font = '8px monospace';
      ctx.fillText('物品', 6, boxY + 12);
      const visible = inventory ? inventory.slice(0, 4) : [];
      for(let i = 0; i < visible.length; i++){
        const it = visible[i];
        const eff = itemEffect(it);
        const col = i % 2, row = Math.floor(i / 2);
        const cx = 8 + col * 80, cy = boxY + 22 + row * 10;
        ctx.fillStyle = i === battle.sub ? (eff ? '#ff0' : '#a55') : (eff ? '#ddc' : '#888');
        const name = it.shopName || (it.source || '?').substr(0,3);
        ctx.fillText((i === battle.sub ? '▶ ' : '  ') + name + ' x' + it.count, cx, cy);
      }
    }

    // Right: party portrait + HP / MP gauge for the ACTIVE member.
    const portraitX = W - 112;
    const active = activeMember();
    // Portrait box.
    ctx.fillStyle = '#000';
    ctx.fillRect(portraitX, boxY + 4, 28, 32);
    if(playerFrames && playerFrames.length){
      const pf = playerFrames[(active.sprite || 0) * 8 + 2];  // DOWN idle
      if(pf){ ctx.imageSmoothingEnabled = false; ctx.drawImage(pf, portraitX + 2, boxY + 4); }
    }
    // HP / MP gauges.
    const gx = portraitX + 34, gw = 72;
    ctx.fillStyle = '#fff';
    ctx.font = '8px monospace';
    ctx.fillText(active.name, gx, boxY + 10);
    // HP
    ctx.fillStyle = '#400';
    ctx.fillRect(gx, boxY + 13, gw, 5);
    ctx.fillStyle = '#f44';
    ctx.fillRect(gx, boxY + 13, gw * Math.max(0, active.hp) / active.maxHp, 5);
    ctx.fillStyle = '#fff';
    ctx.font = '7px monospace';
    ctx.fillText('HP ' + active.hp, gx + gw + 2, boxY + 18);
    // MP
    ctx.fillStyle = '#004';
    ctx.fillRect(gx, boxY + 21, gw, 5);
    ctx.fillStyle = '#48f';
    ctx.fillRect(gx, boxY + 21, gw * Math.max(0, active.mp) / Math.max(1, active.maxMp), 5);
    ctx.fillText('MP ' + active.mp, gx + gw + 2, boxY + 26);
    ctx.fillStyle = '#fc8';
    ctx.fillText('$ ' + state.gold, gx, boxY + 34);
    ctx.fillStyle = '#aaa';
    ctx.fillText('Lv' + active.level + ' EXP ' + active.exp, gx + 34, boxY + 34);

    // Status banner above the panel.
    if(battle.msg){
      ctx.font = 'bold 9px sans-serif';
      ctx.textAlign = 'center';
      const w = ctx.measureText(battle.msg).width + 20;
      ctx.fillStyle = 'rgba(0,0,0,0.85)';
      ctx.fillRect(W/2 - w/2, boxY - 14, w, 12);
      ctx.fillStyle = '#ff0';
      ctx.fillText(battle.msg, W/2, boxY - 5);
      ctx.textAlign = 'left';
    }
  }


  return {
    tryEncounter, startBattle, battleTick,
    drawBattle, drawBattleEnemies, setInventory,
    getBattle: () => battle,
    reset: () => { encounterCounter = 30; battle = null; },
  };
}
