import {loadBin, MCOLS, MROWS, LAYER2_OFF, SMP_T, DOOR_T, DOOR_B, VOID} from './constants.js';
import {buildAtlas} from './parsers.js';
import {parseScript15T, parseCutscene15T} from './script.js';

// Cache tilesets + scripts so we only fetch+parse each file once per session.
export function createCaches(pal){
  const tilesetCache = {};
  const scriptCache = {};

  async function getTileset(ts){
    const key = String(ts).padStart(2, '0');
    if(tilesetCache[key]) return tilesetCache[key];
    const atlas = buildAtlas(await loadBin('D/SMAP' + key + '.SMP'), pal, SMP_T);
    const col = new Uint8Array(await loadBin('D/SMAP' + key + '.BIT'));
    // .HEI is the per-tile HEIGHT / foreground attr table (1500 bytes).
    // Disasm 0x356E reads attr from cs:[0x6a] (loaded from .HEI), NOT from
    // the SMP file's trailing bytes which are some other field. Values
    // 1/2/3 mark foreground tiles whose top extends 0/1/2 rows above the
    // map cell; value 4 is a separate background-overlay path.
    let hei = null;
    try { hei = new Uint8Array(await loadBin('D/SMAP' + key + '.HEI')); }
    catch { hei = new Uint8Array(SMP_T); }
    // Replace the atlas's incorrect SMP-trailing attrs with HEI.
    atlas.attrs = hei;
    return tilesetCache[key] = {atlas, col};
  }

  async function getScript(name){
    if(!name) return null;
    if(scriptCache[name] !== undefined) return scriptCache[name];
    try {
      const buf = await loadBin('S/' + name + '.15T');
      // Standard format first; fall back to cutscene-format (raw opcode
      // stream, no 384-byte header) for TS001 and friends.
      scriptCache[name] = parseScript15T(buf) || parseCutscene15T(buf);
    } catch {
      scriptCache[name] = null;
    }
    return scriptCache[name];
  }

  return {getTileset, getScript};
}

export async function loadArea(areaId, state, areas, getTileset){
  const a = areas[areaId];
  if(!a) return false;
  try {
    const ts = await getTileset(a.tileset);
    state.curAtlas = ts.atlas;
    state.curCol = ts.col;
    const mapBuf = await loadBin('M/' + a.map + '.MAP');
    state.mapL1 = new Uint16Array(mapBuf, 0, MCOLS * MROWS);
    state.mapL2 = new Uint16Array(mapBuf, LAYER2_OFF, MCOLS * MROWS);
    state.curArea = areaId;
    state.visitedAreas.add(areaId);
    return true;
  } catch(e){
    console.error('loadArea', areaId, e);
    return false;
  }
}

// Player is 2 tiles wide (`pX` and `pX+1`). Both map layers + NPCs block.
// `npcPos(n)` returns the NPC's effective position (may differ from n.x/y
// when a flag-based MOVE_WHEN_FLAG override is active). When omitted we
// fall back to the raw n.x / n.y for callers that don't care about
// move-aside semantics yet.
export function blocked(c, r, state, npcData, doorCol, isNpcHidden, npcPos){
  if(c < 0 || c >= MCOLS-1 || r < 0 || r >= MROWS) return true;
  if(!state.curCol || !state.mapL1) return true;
  const {mapL1, mapL2, curCol} = state;
  for(let dx = 0; dx < 2; dx++){
    const cc = c + dx;
    const ti1 = mapL1[r * MCOLS + cc];
    if(ti1 === VOID) return true;
    if(ti1 < SMP_T && curCol[ti1] === 1) return true;
    if(ti1 >= DOOR_B && ti1 < DOOR_B+DOOR_T && doorCol && doorCol[ti1-DOOR_B] === 1) return true;
    const ti2 = mapL2[r * MCOLS + cc];
    if(ti2 !== VOID && ti2 < SMP_T && curCol[ti2] === 1) return true;
    if(ti2 !== VOID && ti2 >= DOOR_B && ti2 < DOOR_B+DOOR_T && doorCol && doorCol[ti2-DOOR_B] === 1) return true;
  }
  const aData = npcData[state.curArea];
  if(aData){
    for(const n of aData.npcs){
      if(isNpcHidden(n)) continue;
      const p = npcPos ? npcPos(n) : {x: n.x, y: n.y};
      for(let dx = 0; dx < 2; dx++){
        const cc = c + dx;
        if((p.x === cc || p.x+1 === cc) && p.y === r) return true;
      }
    }
  }
  return false;
}

// Trigger-match (disasm 0x2055): X match on either of player's 2 columns.
// sx/sy == 0 is a wildcard.
//
// All triggers auto-fire on walk — matching the original. Doors are
// effectively SPACE-only because their trigger tiles are SOLID (the door
// graphic itself), so the player can never step onto them; SPACE+facing
// reaches them via `getFacingTrigger`. Walkable triggers (edge wraps,
// teleport pads, exit thresholds) still fire on step.
export function checkTrigger(state, areas){
  const a = areas[state.curArea];
  if(!a) return null;
  for(const t of a.triggers){
    const xMatch = (t.sx === 0) || (t.sx === state.pX) || (t.sx === state.pX+1);
    const yMatch = (t.sy === 0) || (t.sy === state.pY);
    if(xMatch && yMatch) return t;
  }
  return null;
}

// Closest non-wildcard trigger within 3 tiles — for SPACE-to-enter on doors
// whose trigger tile is solid (player can't step on it to auto-fire).
export function findNearbyTrigger(state, areas){
  const a = areas[state.curArea];
  if(!a) return null;
  let best = null, bestD = 4;
  for(const t of a.triggers){
    if(t.sx === 0 || t.sy === 0) continue;
    const d = Math.abs(t.sx - state.pX) + Math.abs(t.sy - state.pY);
    if(d < bestD){ best = t; bestD = d; }
  }
  return best;
}

export function checkScriptTrigger(state, areas, firedScripts){
  const a = areas[state.curArea];
  if(!a) return null;
  for(const s of (a.scripts || [])){
    const xMatch = (s.sx === 0) || (s.sx === state.pX) || (s.sx === state.pX+1);
    const yMatch = (s.sy === 0) || (s.sy === state.pY);
    if(xMatch && yMatch){
      const key = state.curArea + ':' + s.scriptId;
      if(firedScripts.has(key)) continue;
      return s;
    }
  }
  return null;
}
