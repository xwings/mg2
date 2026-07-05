import {W, H, DT, MCOLS, MROWS} from './constants.js';
import {isConsumable, recomputeStats} from './items.js';

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

export function createBattleSystem(state, areas, npcFrames, playerFrames, enemyFrames, enemyStats, encounterPool, atsMap, levelExpTable, itemTable, chrome = {}){
  // Authentic battle chrome (see ARCHITECTURE/battle.md): battleUI is a
  // VGA-palette UI toolkit, backdrop is the AM.TOS accessor, panel is
  // SSLLP01 (320×50 command panel), attp are the 4×18 hero pose frames.
  const bUI = chrome.ui;
  const backdropOf = chrome.backdrop;
  const panelImg = chrome.panel;
  const attp = chrome.attp;
  const itemTables = chrome.itemTables || {};
  // Effect of using a consumable in battle — real item-table fields:
  // stats[0] = HP restored, stats[1] = MP restored (disasm 0x534d).
  // Equipment and zero-effect quest items are unusable in combat.
  function itemEffect(item){
    if(!isConsumable(item.id)) return null;
    const rec = itemTable && itemTable[item.id];
    if(!rec) return null;
    if(rec.stats[0] > 0) return {kind: 'heal', power: rec.stats[0], target: 'self', label: 'HP'};
    if(rec.stats[1] > 0) return {kind: 'mp',   power: rec.stats[1], target: 'self', label: 'MP'};
    return null;
  }
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

  // Enemy formation anchors (ATT.LOD 0xb524 table): bottom-center
  // SCREEN offsets per party size, variant 0. Sprites grow up from the
  // anchor; the whole formation is left-shifted so its leftmost edge
  // sits at x=5.
  const FORMATION = {
    1: [[105,130]],
    2: [[150,110],[70,145]],
    3: [[170,85],[60,105],[125,145]],
    4: [[170,80],[70,90],[155,135],[55,148]],
    5: [[170,80],[65,90],[110,115],[160,140],[45,148]],
  };

  function startBattle(tier, pick){
    const baseEnemy = pick?.enemy ?? 1;
    // Enemy count cap grows with the lead sprite size (ATT.LOD 0xb524);
    // approximate with tier since we don't pre-measure here.
    const count = 1 + Math.floor(Math.random() * Math.min(4, tier + 1));
    const anchors = FORMATION[count] || FORMATION[5];
    const enemies = [];
    // Snapshot overworld position so endBattle can return to it. The
    // battle now draws on a dedicated screen (backdrop + panel), so the
    // player sprite is NOT teleported around the map anymore.
    const groundX = state.pX, groundY = state.pY, groundDir = state.pdir;
    // Backdrop id = the AREA_ENEMY `enemy` field / outdoor biome map
    // (cs:0xb1ed → AM.TOS record). Fall back to record 1.
    const areaDef = AREA_ENEMY[state.curArea];
    const backdropId = areaDef?.enemy ?? 1;
    for(let i = 0; i < count; i++){
      const id = baseEnemy;
      const p = profileFor(id, enemyStats);
      const hp = Math.max(1, p.hp);
      const spr = enemyFrames && enemyFrames[p.sprite];
      const w = spr?.w ?? 80, h = spr?.h ?? 70;
      const [ax, ay] = anchors[i];
      enemies.push({
        slot: i, enemy: id, sprite: p.sprite, name: p.name,
        // Screen top-left = anchor − h − w/2 (bottom-center anchor).
        sx: Math.round(ax - w / 2), sy: Math.round(ay - h),
        w, h,
        hp, maxHp: hp, atk: p.atk, def: p.def,
        expReward: p.exp, goldReward: p.gold,
        alive: true, flash: 0,
      });
    }
    // Left-shift the whole formation so nothing clips off the left edge.
    let minX = Math.min(...enemies.map(e => e.sx));
    if(minX < 5){ const d = 5 - minX; for(const e of enemies) e.sx += d; }
    battle = {
      tier,
      biomeX: pick?.biomeX ?? 0,
      backdropId,
      enemies,
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
    const hero = state.party[0];
    // Roll the threshold ONCE per level (ATT.LOD 0x1c32 reads the rolled
    // value it stored at +0x40) — calling expForLevel twice would compare
    // against one jitter roll and subtract a different one.
    let threshold = expForLevel(state.level);
    while(state.exp >= threshold){
      state.exp -= threshold;
      state.level++;
      threshold = expForLevel(state.level);
      // Authentic growth — see STAT_GROWTH comment above for the ATT.LOD
      // addresses this mirrors. Combat-stat gains land on the BASE stats
      // (member +0x20..+0x2A); effective stats are recomputed from base +
      // equipment afterwards, exactly like the original (0x6fbb).
      for(const [key, base, rngBound] of STAT_GROWTH){
        const gain = base + rnd(rngBound);
        if(key === 'maxHp' || key === 'maxMp') hero[key] += gain;
        else hero.base[key] += gain;
      }
      recomputeStats(hero, itemTable);
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

  // Teardown — the battle runs on its own screen (backdrop + panel) and
  // never moved the player, so there is nothing to restore.
  function endBattle(){
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

    // Grid navigation for the 2-column list window: ↑/↓ move rows (±2),
    // ←/→ toggle columns (±1), clamped to the list bounds.
    function gridNav(n){
      if(pressedKey === 'ArrowUp'   && battle.sub - 2 >= 0) battle.sub -= 2;
      if(pressedKey === 'ArrowDown' && battle.sub + 2 < n)  battle.sub += 2;
      if(pressedKey === 'ArrowLeft' && (battle.sub & 1))    battle.sub -= 1;
      if(pressedKey === 'ArrowRight' && !(battle.sub & 1) && battle.sub + 1 < n) battle.sub += 1;
    }

    if(battle.mode === 'magic'){
      const m = activeMember();
      gridNav(m.spells.length);
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
      gridNav(inv.length);
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

  // ── Dedicated battle screen (ATT.LOD composition) ──
  // Draw order (ATT.LOD 0x185e): AM.TOS backdrop rows 0-149 → enemies
  // (formation, bottom-center anchored) → SSLLP01 panel rows 150-199 →
  // hero pose (ATTP) → command labels (ATT.15 1-6) → party status →
  // target cursor → message. ATT.15 command labels: 物品/攻撃/魔法 (1-3)
  // on the top row, 防禦/自動/逃跑 (4-6) below, at the panel's baked
  // button positions (0x1867).
  const CMD_ENTRY = [1, 2, 3, 4, 5, 6];
  const CMD_POS = [[7,157],[48,157],[91,157],[7,180],[48,180],[91,180]];
  // Engine menu index → ATT.15 command slot (0物品 1攻撃 2魔法 3防禦 4自動 5逃跑).
  const MENU_TO_CMD = [0, 1, 2, 3, 4, 5];
  // Party screen positions (ATT.LOD tables cs:[0x12d..], by party size):
  // top-left of the 25×25 ATTP frame, right side of the screen.
  const PARTY_POS = {
    1: [[273,80]],
    2: [[270,55],[276,102]],
    3: [[270,50],[273,80],[276,110]],
    4: [[270,45],[272,70],[274,95],[276,120]],
  };

  // ATTP pose frame for a member: 0 idle, 2 fallen, 11 defend.
  function heroFrame(m){
    if(m.hp <= 0) return 2;
    if(m.defending > 0) return 11;
    return 0;
  }

  function drawScreen(ctx){
    if(!battle) return;
    ctx.imageSmoothingEnabled = false;

    // Backdrop (rows 0-149). Fall back to a flat fill if AM.TOS is
    // missing or the record is empty.
    const bg = backdropOf ? backdropOf(battle.backdropId) : null;
    if(bg) ctx.drawImage(bg, 0, 0);
    else { ctx.fillStyle = '#101828'; ctx.fillRect(0, 0, W, 150); }

    // Enemies at their fixed screen positions (bottom-center anchor
    // already baked into e.sx/e.sy at startBattle).
    for(let i = 0; i < battle.enemies.length; i++){
      const e = battle.enemies[i];
      if(!e.alive) continue;
      const spr = enemyFrames && enemyFrames[e.sprite];
      if(spr){
        ctx.drawImage(spr.canvas, e.sx, e.sy);
        if(e.flash > 0){
          ctx.fillStyle = `rgba(255,32,32,${Math.min(0.75, e.flash / 300)})`;
          ctx.fillRect(e.sx, e.sy, e.w, e.h);
        }
      } else {
        ctx.fillStyle = '#a00'; ctx.fillRect(e.sx, e.sy, e.w, e.h);
      }
      // Name + HP bar above the sprite.
      const barW = Math.min(e.w, 48), barX = e.sx + (e.w - barW) / 2;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(barX, e.sy - 5, barW, 3);
      ctx.fillStyle = bUI ? bUI.css(0xBE) : '#d00';
      ctx.fillRect(barX, e.sy - 5, barW * Math.max(0, e.hp) / e.maxHp, 3);
      // Target cursor when this enemy is the current target — the
      // LEFT-pointing hand (M_IP frame 1) at the enemy's right edge.
      if(battle.mode === 'target' && battle.target === i && bUI){
        bUI.drawHand(e.sx + e.w, e.sy + (e.h >> 1) - 8, 1);
      }
    }

    // Party battle sprites (ATTP poses) on the right of the screen.
    const positions = PARTY_POS[state.party.length] || PARTY_POS[4];
    for(let i = 0; i < state.party.length; i++){
      const m = state.party[i];
      const frames = attp && attp[m.sprite ?? i];
      const pos = positions[i] || positions[positions.length - 1];
      if(frames){
        const f = frames[heroFrame(m)] || frames[0];
        if(f) ctx.drawImage(f, pos[0], pos[1]);
      }
    }

    // Command panel (rows 150-199). SSLLP01 has the buttons baked in; if
    // absent, draw the authentic window frame instead.
    if(panelImg) ctx.drawImage(panelImg, 0, 150);
    else if(bUI) bUI.drawWindow(0, 150, W, 50);

    const active = activeMember();
    // The command labels always sit on the panel's baked buttons; the
    // magic/item submenus open a SEPARATE list window over the top of
    // the screen (ATT.LOD 0x51d5: (0,0) 306×150, 2 cols × 7 rows at
    // (30,8), stride 140/20, selection bar + hand) — they never draw
    // into the command panel.
    if(bUI){
      for(let i = 0; i < 6; i++){
        const [cx, cy] = CMD_POS[i];
        const sel = battle.mode === 'select' && MENU_TO_CMD[battle.menu] === i;
        bUI.drawString(CMD_ENTRY[i], cx, cy, sel ? 0xEF : 1);
      }
    }
    if(bUI && (battle.mode === 'magic' || battle.mode === 'item')){
      const magicMode = battle.mode === 'magic';
      const list = magicMode ? (active.spells || []) : (inventory || []);
      bUI.drawWindow(0, 0, 306, 150);
      const first = Math.max(0, Math.min(battle.sub - 12, list.length - 14));
      for(let k = 0; k < Math.min(14, list.length - first); k++){
        const i = first + k;
        const col = k % 2, row = (k / 2) | 0;
        const x = 30 + col * 140, y = 8 + row * 20;
        const sel = i === battle.sub;
        if(sel){
          bUI.drawSelBar(26 + col * 140, 5 + row * 20);
          bUI.drawHand(6 + col * 140, 10 + row * 20);
        }
        if(magicMode){
          const sp = list[i];
          const g = itemTables.magic && itemTables.magic[sp.id];
          const base = sel ? 0xEF : 0x71;
          if(g) bUI.drawGlyphs(g, x, y, base);
          bUI.drawNum(sp.mpCost, x + 56, y + 5, 1, {cells: 5});
        } else {
          const it = list[i];
          const g = itemTables.potion && itemTables.potion[it.id];
          const base = sel ? 0xEF : (itemEffect(it) ? 0x71 : 0x78);
          if(g) bUI.drawGlyphs(g, x, y, base);
          bUI.drawNum(it.count, x + 56, y + 5, 1, {cells: 5});
        }
      }
    }

    // Party status on the right of the panel (ATT.LOD 0x4e25): name,
    // HP/MP labels (ATT.15 10/11) + digits + bars.
    if(bUI){
      const px = 200, py = 156;
      bUI.drawString(0x14, px, py, 0xB9);                 // hero name
      bUI.drawString(0x0A, px, py + 12, 0x49);            // HP
      bUI.drawNum(active.hp, px + 20, py + 12, 1, {cells: 4});
      bUI.drawString(0x0B, px + 60, py + 12, 0xE3);       // MP
      bUI.drawNum(active.mp, px + 78, py + 12, 1, {cells: 3});
      // HP/MP bars.
      ctx.fillStyle = bUI.css(0x67); ctx.fillRect(px, py + 24, 100, 3);
      ctx.fillStyle = bUI.css(0xBE);
      ctx.fillRect(px, py + 24, 100 * Math.max(0, active.hp) / active.maxHp, 3);
      ctx.fillStyle = bUI.css(0x67); ctx.fillRect(px, py + 30, 100, 3);
      ctx.fillStyle = bUI.css(0xF6);
      ctx.fillRect(px, py + 30, 100 * Math.max(0, active.mp) / Math.max(1, active.maxMp), 3);
    }

    // Enemy names (glyph would need ATT.15; use small text above each).
    ctx.textAlign = 'center';
    ctx.font = '7px monospace';
    for(const e of battle.enemies){
      if(!e.alive) continue;
      ctx.fillStyle = '#fff';
      ctx.fillText(e.name, e.sx + e.w / 2, e.sy - 7);
    }
    ctx.textAlign = 'left';

    // Message banner in the panel.
    if(battle.msg && bUI){
      ctx.fillStyle = bUI.css(0xBA);
      ctx.font = 'bold 9px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(battle.msg, W / 2, 150 - 4);
      ctx.textAlign = 'left';
    }
  }

  return {
    tryEncounter, startBattle, battleTick,
    drawScreen, setInventory,
    getBattle: () => battle,
    reset: () => { encounterCounter = 30; battle = null; },
  };
}
