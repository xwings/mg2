// SJN.DAT-driven quest-blocker engine — replica of MG2's FF80
// conditional dispatcher (disasm 0x9101 → 0x9699 → 0x97DE).
//
// Each SJN condition is "if flag[N] op V then write NPC[P]'s field F to
// value X". `applySJN` walks the table for an area and performs the
// writes. We re-run it whenever a flag changes (FF20 / FF10 in a dialog)
// so the blocker NPC steps aside or vanishes before the dialog closes.
//
// The mutations write straight through to `n.x / n.y / n.sprite / n.flag`
// so save/load captures them via the regular NPC delta snapshot.

// Field map for the 20-byte POL.DAT NPC record.
const NPC_FIELD = {0: 'y', 2: 'x', 4: 'y2', 6: 'x2', 8: 'sprite', 0x0A: 'flag'};

function compareOp(op, a, b){
  switch(op){
    case 0: return a === b;
    case 1: return a !== b;
    case 2: return a >= b;
    case 3: return a <= b;
    case 4: return a > b;
    case 5: return a < b;
  }
  return false;
}

// Build the per-area state helpers. `deps`:
//   state, areas, npcData, flags, sjnTable, MCOLS, MROWS
export function createNpcState({state, areas, npcData, flags, sjnTable, MCOLS, MROWS}){
  function applySJN(aid){
    const conds = sjnTable[aid];
    if(!conds) return;
    const list = npcData[aid]?.npcs;
    if(!list) return;
    for(const c of conds){
      const cur = flags[c.flag] ?? 0;
      if(!compareOp(c.op, cur, c.value)) continue;
      for(const w of c.npcWrites){
        const n = list.find(x => x.rawIdx === w.npc);
        if(!n) continue;
        const field = NPC_FIELD[w.field];
        if(field) n[field] = w.value;
      }
      // c.rawTiles (rare) are map-tile rewrites for "mysterious force"
      // barriers — left for future implementation.
    }
  }

  const reapplySJN = () => applySJN(state.curArea);

  // Effective NPC render position. Right now equals raw n.x/n.y because
  // SJN writes through to the NPC record. Kept as a function so future
  // transient overrides have a single chokepoint.
  const npcPos = (n) => ({x: n.x, y: n.y});

  // Is an NPC currently invisible? Three reasons:
  //   1. Explicit `hidden` flag set by a script
  //   2. Script-bound NPC whose `(x, y)` matches a 0xF000 trigger and
  //      hasn't been `spawned` yet (FF60 materialises them)
  //   3. Off-map sentinel (SJN Y=160 or FF65 Y-above-map)
  const npcHidden = (n) => {
    if(n.hidden) return true;
    const a = areas[state.curArea];
    if(!n.spawned && a && a.scripts){
      for(const s of a.scripts){
        if(s.sx === n.x && s.sy === n.y) return true;
      }
    }
    if(n.y >= MROWS || n.x >= MCOLS) return true;
    return false;
  };

  return {applySJN, reapplySJN, npcPos, npcHidden};
}
