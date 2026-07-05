// SJN.DAT-driven quest-blocker engine — replica of MG2's FF80
// conditional dispatcher (disasm 0x9101 → 0x9699 → 0x97DE) — plus the
// NPC wander AI (disasm 0x376C).
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
//   state, areas, npcData, flags, sjnTable, MCOLS, MROWS, stampTiles
export function createNpcState({state, areas, npcData, flags, sjnTable, MCOLS, MROWS, stampTiles}){
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
      // F1 records are map-tile rewrites ("mysterious force" barriers,
      // door reveals): tag + (mapY, mapX, tileRow, tileCol, w, h), fed to
      // the same stamp routine as opcode FF80 (disasm 0x9726 → 0x97DE).
      // Only stamp the area whose map is actually loaded.
      if(stampTiles && aid === state.curArea){
        for(const t of c.rawTiles){
          if(t[0] === 0xF1 && t.length >= 7){
            stampTiles({mapY: t[1], mapX: t[2], tileRow: t[3], tileCol: t[4],
                        w: t[5], h: t[6]});
          }
        }
      }
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

  // ── NPC wander AI (disasm 0x376C, tick gate cs:[0xb24d] ≥ 30) ──
  // Every AI tick (~0.42 s), each NPC with mobility flag 1 has a 50%
  // chance to act; a coin picks the vertical or horizontal axis. The
  // NPC wanders around its (x2, y2) anchor within rangeY/rangeX tiles:
  // at the limit the step is forced back toward the anchor, otherwise
  // it's a 50/50 step either way. Blocked by map collision (both
  // layers, both NPC columns), other NPCs, and the player — and the
  // NPC turns to face the attempted direction EVEN when blocked
  // (0x3945 sets the facing unconditionally).
  const VOID = 0x07FF, SMP_T = 1500;

  function stepBlocked(list, self, nx, ny){
    if(nx < 0 || nx >= MCOLS - 1 || ny < 0 || ny >= MROWS) return true;
    const {mapL1, mapL2, curCol} = state;
    if(!mapL1 || !curCol) return true;
    for(let dx = 0; dx < 2; dx++){
      const ti1 = mapL1[ny * MCOLS + nx + dx];
      if(ti1 === VOID) return true;
      if(ti1 < SMP_T && curCol[ti1] === 1) return true;
      const ti2 = mapL2[ny * MCOLS + nx + dx];
      if(ti2 !== VOID && ti2 < SMP_T && curCol[ti2] === 1) return true;
    }
    // Player + NPC bodies are 2 tiles wide: overlap when |Δx| ≤ 1.
    if(ny === state.pY && Math.abs(nx - state.pX) <= 1) return true;
    for(const o of list){
      if(o === self || npcHidden(o)) continue;
      if(o.y === ny && Math.abs(o.x - nx) <= 1) return true;
    }
    return false;
  }

  function wanderTick(){
    const list = npcData[state.curArea]?.npcs;
    if(!list) return;
    for(const n of list){
      if(n.mobility !== 1) continue;
      if(npcHidden(n)) continue;
      if(n.y >= 160) continue;                      // off-map sentinel (0x378a)
      if(Math.random() < 0.5) continue;             // 50% act chance (0x379f)
      let dir;
      if(Math.random() < 0.5){
        // Vertical: bounce off the rangeY limit around the y2 anchor.
        if(n.y >= n.y2){
          dir = (n.y - n.y2 >= (n.rangeY || 0)) ? 0 : (Math.random() < 0.5 ? 0 : 1);
        } else {
          dir = (n.y2 - n.y >= (n.rangeY || 0)) ? 1 : (Math.random() < 0.5 ? 0 : 1);
        }
      } else {
        if(n.x >= n.x2){
          dir = (n.x - n.x2 >= (n.rangeX || 0)) ? 2 : (Math.random() < 0.5 ? 2 : 3);
        } else {
          dir = (n.x2 - n.x >= (n.rangeX || 0)) ? 3 : (Math.random() < 0.5 ? 2 : 3);
        }
      }
      const nx = n.x + (dir === 2 ? -1 : dir === 3 ? 1 : 0);
      const ny = n.y + (dir === 0 ? -1 : dir === 1 ? 1 : 0);
      n.flag = (n.flag & ~3) | dir;                 // face the attempt
      if(!stepBlocked(list, n, nx, ny)){ n.x = nx; n.y = ny; }
    }
  }

  return {applySJN, reapplySJN, npcPos, npcHidden, wanderTick};
}
