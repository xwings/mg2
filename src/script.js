// .15T script interpreter (disasm 0x8840 dispatcher).
// Header: 64 × 6 bytes = (u16 pad, u16 offset, u16 size).
// Body words: w >= 0xFF00 opcode, w == 0xC000/0xC001 space, else 30-byte glyph.

// Strides verified against disasm 0x89B0 dispatcher + each handler's `add si, N`.
// Terminator opcodes (handler ends with `ret`) have no real stride; the value
// shown is the size of the param block they read so we stay aligned if we ever
// keep parsing past one.  FF04 is intentionally absent — the dispatcher has no
// case for it, so a 0xFF04 word would fall into the default glyph path.
export const OP_STRIDES = {
  // continuing
  0xFF08: 2,
  0xFF20: 6,  0xFF30: 6,
  0xFF50: 0x20, 0xFF55: 6,
  0xFF60: 0x20, 0xFF65: 0x0A, 0xFF70: 8,
  0xFF80: 0x0A,
  0xFF90: 0x20, 0xFF91: 0x20,
  0xFFA0: 0x20, 0xFFA2: 0x20,
  0xFFB0: 0x0A,
  0xFFC0: 6, 0xFFD0: 6, 0xFFE0: 6, 0xFFF0: 6,
  // terminators (`ret`)
  0xFF01: 4, 0xFF02: 4, 0xFF03: 4,  // [si+2] = next-page chain id (handled externally)
  0xFF09: 4,                         // jump to entry [si+2]
  0xFF10: 0x14,                      // 9 u16 params; reads up to [si+0x12]
  0xFFFF: 2,                         // chains to finalization at 0x92F7
};

// Set of opcodes whose handler ends with `ret` — these end the entry.
const TERMINATORS = new Set([0xFF01, 0xFF02, 0xFF03, 0xFF09, 0xFF10, 0xFFFF]);

// Real .15T files have entries up to ~200, not just 64. The header zone
// extends to wherever the first entry's content starts (typically 6000+
// bytes for cutscene scripts). We scan stride-6 entries until the table
// runs into payload data or hits 200 (the empirical max from a survey
// across all files in mg2/S/).
const MAX_ENTRIES = 200;

export function parseScript15T(buf){
  const dv = new DataView(buf);
  const bufLen = buf.byteLength;
  const entries = [];
  let validEntries = 0;
  // Find the lowest valid content offset — the header table cannot extend
  // into actual entry payload. Bound `i` by `lowestOff/6` once we know it.
  let lowestOff = bufLen;
  for(let i = 0; i < MAX_ENTRIES; i++){
    if(i*6 + 6 > lowestOff) break;
    const off = dv.getUint16(i*6+2, true);
    const size = dv.getUint16(i*6+4, true);
    if(off >= 384 && size > 0 && off + size <= bufLen){
      entries.push({off, size});
      validEntries++;
      if(off < lowestOff) lowestOff = off;
    } else {
      entries.push({off: 0, size: 0});
    }
  }
  if(validEntries === 0) return null;
  return {buf: new Uint8Array(buf), entries};
}

// Pull u16 params out of an opcode payload so callers can act on them.
function u16(body, off){ return body[off] | (body[off+1] << 8); }

// Stride-60 dispatch — mirrors MG2.EXE's 0x8840 entrypoint (`dx *= 0x3c`).
// Each outer id maps to 10 × 6-byte sub-entries `(pad u16, off u16, size u16)`.
//
// Sub-entry 0 is special: when its size > 0, its BODY is a flag-check
// table of 8-byte records, NOT script content. Each record:
//   [0..1] 0xFF00 marker  [2..3] flag index  [4..5] expected value
//   [6..7] sub-entry to use (0 = skip entirely — the "block cleared" case).
// Disasm 0x88D2 loops records comparing flags[si] to the expected value;
// first match wins. If no record matches, the default is sub 1.
//
// When `flags` is omitted (callers that don't care about conditional
// dispatch, e.g. raw notice-board scripts), we fall back to "first non-zero
// sub", preserving old behaviour.
export function lookupStride60(script, id, flags){
  const buf = script.buf;
  const base = id * 60;
  if(base + 6 > buf.length) return null;
  const subHeader = (sub) => {
    const o = base + sub * 6;
    if(o + 6 > buf.length) return null;
    const off = buf[o+2] | (buf[o+3] << 8);
    const sz  = buf[o+4] | (buf[o+5] << 8);
    return {off, sz};
  };
  const bodyOf = (sub) => {
    const h = subHeader(sub);
    if(!h || h.sz === 0 || h.off < 384 || h.off + h.sz > buf.length) return null;
    return {off: h.off, size: h.sz};
  };
  const sub0 = subHeader(0);
  if(flags && sub0 && sub0.sz >= 8 && sub0.off + sub0.sz <= buf.length){
    let chosen = 1;
    for(let r = 0; r + 8 <= sub0.sz; r += 8){
      const p = sub0.off + r;
      const flagIdx = buf[p+2] | (buf[p+3] << 8);
      const expect  = buf[p+4] | (buf[p+5] << 8);
      const target  = buf[p+6] | (buf[p+7] << 8);
      if((flags[flagIdx] ?? 0) === (expect & 0xFF)){
        chosen = target;
        break;
      }
    }
    if(chosen === 0) return null;
    return bodyOf(chosen);
  }
  for(let sub = 0; sub < 10; sub++){
    const body = bodyOf(sub);
    if(body) return body;
  }
  return null;
}

// Run a script body at an arbitrary (off, size) — used by stride-60 dispatch
// since those sub-entries point to content the stride-6 entry table doesn't
// reference. Same return shape as `runScript15T`.
export function runScript15Tat(script, off, size){
  const fakeScript = {buf: script.buf, entries: [{off, size}]};
  return runScript15T(fakeScript, 0);
}

export function runScript15T(script, idx){
  const e = script.entries[idx];
  if(!e || e.size === 0 || e.off === 0) return {pages: [], effects: [], ops: []};
  const body = script.buf.subarray(e.off, e.off + e.size);
  const pages = [], effects = [], ops = [];
  let line = [], page = [];
  const flushLine = () => { if(line.length){ page.push(line); line = []; } };
  const flushPage = () => { flushLine(); if(page.length){ pages.push(page); page = []; } };
  let i = 0, guard = 0;
  while(i + 1 < body.length && guard++ < 20000){
    const w = u16(body, i);
    if(w >= 0xFF00){
      const stride = OP_STRIDES[w] || 2;
      if(w === 0xFF01 || w === 0xFF02 || w === 0xFF03){
        // wait-for-input + chain (disasm 0x8B82/0x8BAC/0x8BD6 → call 0x985b/0x9b36/0x9d47 → ret).
        // Each variant uses a different fade effect; param at [si+2] is the next entry id.
        ops.push({op: w, pageIdx: pages.length, nextEntry: u16(body, i+2)});
        flushPage();
        break;
      }
      if(w === 0xFF08){ flushLine(); if(page.length >= 4) flushPage(); }
      else if(w === 0xFF09){
        // jump to entry [si+2] (disasm 0x8B64 → 0x88FE re-entry).
        ops.push({op: 0xFF09, pageIdx: pages.length, nextEntry: u16(body, i+2)});
        flushPage();
        break;
      }
      else if(w === 0xFF10){
        // FF10 (disasm 0x8C00): conditional event trigger. 8 u16 params.
        //   p[0] → cs:0xb240  (context/scene)
        //   p[1] → cs:0xb1ed  ENEMY ID for a scripted battle
        //   p[2..5] → cs:0xb1db/dd/df/e1  auxiliary combat/actor state
        //   p[6] → cs:0xb1e3  CONDITION — compared with cs:0xb1d9 (party/state byte)
        //   p[7] → cs:0xb1e5  flag INDEX to set if condition matches
        //   p[8] → cs:0xb1e7  flag VALUE (low byte)
        // If p[6] == 1 → "quick" path (return immediately).
        // Else if party state == 1 → file I/O loop (save-point pattern).
        // Otherwise just returns. The conditional flag write fires in all cases.
        ops.push({
          op: 0xFF10, pageIdx: pages.length,
          context: u16(body, i+2),
          enemy:   u16(body, i+4),
          aux1:    u16(body, i+6),
          aux2:    u16(body, i+8),
          aux3:    u16(body, i+10),
          aux4:    u16(body, i+12),
          cond:    u16(body, i+14),
          flagIdx: u16(body, i+16),
          flagVal: u16(body, i+18),
        });
      }
      else if(w === 0xFF20){
        // Flag set: (flagIdx, value) at [bx+0x3d8]
        ops.push({op: 0xFF20, pageIdx: pages.length, flag: u16(body, i+2), value: u16(body, i+4)});
      }
      else if(w === 0xFF30){
        const ax = u16(body, i+2);
        const dx = u16(body, i+4);
        effects.push({type: ax === 0 ? 'pickup' : 'gold', value: dx});
        ops.push({op: 0xFF30, pageIdx: pages.length, kind: ax, value: dx});
      }
      else if(w === 0xFF50){
        ops.push({op: 0xFF50, pageIdx: pages.length, sound: u16(body, i+2)});
      }
      else if(w === 0xFF55){
        ops.push({op: 0xFF55, pageIdx: pages.length, sound: u16(body, i+2)});
      }
      else if(w === 0xFF60){
        // NPC teleport/init (disasm 0x8DC4). Stride 0x20, 5 u16 params:
        //   (npcIdx, Y, X, sprite_id, movement_timer) — -1 means "skip".
        // bx = npcIdx*0x14 + 2 selects the 20-byte record; field writes go to
        // ds:[bx + 0x367a + K] for K=0(Y), 2(X), 8(sprite), 0x0E(timer).
        ops.push({
          op: 0xFF60, pageIdx: pages.length,
          npcIdx: u16(body, i+2),
          y:       u16(body, i+4),
          x:       u16(body, i+6),
          sprite:  u16(body, i+8),
          timer:   u16(body, i+10),
        });
      }
      else if(w === 0xFF65){
        // Write single NPC field (disasm 0x8E13). Stride 0x0A:
        //   (npcIdx, field_offset_in_record, value).
        ops.push({op: 0xFF65, pageIdx: pages.length, npcIdx: u16(body, i+2), field: u16(body, i+4), value: u16(body, i+6)});
      }
      else if(w === 0xFF70){
        // NPC walk (disasm 0x8E3C). Stride 8:
        //   dir (0=dec Y, 1=inc Y, 2=dec X, 3=inc X)
        //   npcIdx (or >= 0xC000 for special)
        //   extra — stored at field +0x0A (flag/direction)
        ops.push({
          op: 0xFF70, pageIdx: pages.length,
          dir: u16(body, i+2),
          npcIdx: u16(body, i+4),
          extra: u16(body, i+6),
        });
      }
      else if(w === 0xFF80){
        // disasm 0x90DE: pushes ds/es/regs, calls 0x97DE with di=si+2 (string-table op),
        // then `add si, 0xa`. Param block is 4 u16 values. Function not yet decoded.
        ops.push({op: 0xFF80, pageIdx: pages.length,
          p0: u16(body, i+2), p1: u16(body, i+4), p2: u16(body, i+6), p3: u16(body, i+8)});
      }
      else if(w === 0xFF90 || w === 0xFF91){
        // disasm 0x9101 / 0x9159: blit sprite at NPC [si+2]'s screen position.
        //   bx = npcIdx*0x14 selects record; reads X/Y at [bx+0x367c], [bx+0x367e].
        //   FF90 uses sprite source si=0; FF91 uses si=0x168 (alternate frame).
        ops.push({op: w, pageIdx: pages.length, npcIdx: u16(body, i+2)});
      }
      else if(w === 0xFFA0){
        // disasm 0x91B1: delay loop, ax = [si+2] passed to 0x10857 (wait-ticks).
        ops.push({op: 0xFFA0, pageIdx: pages.length, ticks: u16(body, i+2)});
      }
      else if(w === 0xFFA2){
        // disasm 0x91CC: sound playback — pushes (0, 0, 1, 2, ax=[si+2]) and calls
        // 0xB606, then 0x32-tick wait via 0x105ED. Audio is out of scope.
        ops.push({op: 0xFFA2, pageIdx: pages.length, sound: u16(body, i+2)});
      }
      else if(w === 0xFFB0){
        // disasm 0x9200: copy 8 bytes from [si+2..si+9] into ds:[0x3c69], then open
        // file at ds:[0x3c65] via int 21h AH=3D. Loads a sub-script/data file.
        // We capture the raw 8-byte filename for future support.
        ops.push({op: 0xFFB0, pageIdx: pages.length,
          name: body.subarray(i+2, i+10)});
      }
      else if(w === 0xFFC0){
        // disasm 0x925D: bx = [si+2] >> 1, then call 0x105ED (wait-ticks).
        ops.push({op: 0xFFC0, pageIdx: pages.length, ticks: u16(body, i+2)});
      }
      else if(w === 0xFFD0){
        // disasm 0x9278: dx = [si+2], call 0x1665 (RNG?), dec [si+0x286], call 0x151c.
        // Effect not yet decoded — capture param.
        ops.push({op: 0xFFD0, pageIdx: pages.length, value: u16(body, i+2)});
      }
      else if(w === 0xFFE0){
        // disasm 0x9298: re-render scene (call 0x33A9), copy framebuffer to A000:0,
        // and if param == 1 also call 0x14F2 (likely VSync / frame complete).
        // This is the "scene refresh during dialog" hook the engine was missing.
        ops.push({op: 0xFFE0, pageIdx: pages.length, mode: u16(body, i+2)});
      }
      else if(w === 0xFFF0){
        // disasm 0x92D3: call 0x9941 (snapshots player+NPC positions into history
        // slots) + 10-tick wait via 0x10857. Used to register a state checkpoint.
        ops.push({op: 0xFFF0, pageIdx: pages.length});
      }
      i += stride;
      if(TERMINATORS.has(w)){ flushPage(); break; }
    } else if(w === 0xC000 || w === 0xC001){
      line.push({space: true});
      i += 2;
      if(line.length >= 18){ flushLine(); if(page.length >= 4) flushPage(); }
    } else {
      // Default string cell (disasm 0x89B0 → 0x8A75 → 0x8A95 `loop`):
      //   word at i  = glyph count N
      //   bytes i+2..i+2+N*30 = N consecutive 30-byte 16x15 bitmaps
      // The original loops `cx = N` times calling 0xABB per glyph, advancing
      // si by 30 each iteration. Total cell stride = 2 + N*30 bytes.
      const count = w;
      // Sanity bounds — counts above ~30 wouldn't fit on one line and likely
      // mean we're reading garbage (misaligned past an opcode).
      if(count === 0 || count > 50 || i + 2 + count * 30 > body.length){
        // Skip 2 bytes to recover and try again rather than infinite-loop.
        i += 2;
        continue;
      }
      i += 2;
      for(let g = 0; g < count; g++){
        line.push({glyph: body.subarray(i, i+30)});
        i += 30;
        if(line.length >= 18){ flushLine(); if(page.length >= 4) flushPage(); }
      }
    }
  }
  flushPage();
  return {pages, effects, ops};
}

// Apply state-mutating opcodes for a given page index. Called as the player
// advances through the dialog so side effects land at the right moment.
export function applyScriptOps(ops, pageIdx, ctx){
  for(const o of ops){
    if(o.pageIdx !== pageIdx) continue;
    if(o.op === 0xFF60){
      const list = ctx.npcData[ctx.curArea]?.npcs;
      if(list && o.npcIdx < list.length){
        const n = list[o.npcIdx];
        if(o.y !== 0xFFFF) n.y = o.y;
        if(o.x !== 0xFFFF) n.x = o.x;
        if(o.sprite !== 0xFFFF) n.sprite = o.sprite;
        // timer param is runtime state; we don't model it
        n.hidden = false;
        n.spawned = true;
      }
    } else if(o.op === 0xFF65){
      const list = ctx.npcData[ctx.curArea]?.npcs;
      if(list && o.npcIdx < list.length){
        const n = list[o.npcIdx];
        // Field offsets inside the 20-byte NPC record.
        const FIELDS = {0: 'y', 2: 'x', 4: 'y2', 6: 'x2', 8: 'sprite', 0x0A: 'flag'};
        const f = FIELDS[o.field];
        if(f) n[f] = o.value;
      }
    } else if(o.op === 0xFF20){
      ctx.flags[o.flag] = o.value;
    } else if(o.op === 0xFF30){
      if(o.kind !== 0) ctx.addGold(o.value);
      // kind===0 = "show +N pickup" — displayed via effects[], no state change
    } else if(o.op === 0xFF70){
      // Disasm 0x8E3C: cx = [si+6] is the step count (do-while). Each iteration
      // moves one tile in `dir`, re-renders, and waits 5 ticks. We can't model
      // the per-step animation without a tick loop, but at least applying the
      // full displacement matches the end state.
      //
      // npcIdx >= 0xC000 targets the player (0xD000 is the "push player"
      // used by D01's invisible-block cutscene at (142, 50)).
      const steps = o.extra || 1;
      if(o.npcIdx >= 0xC000){
        if(ctx.state){
          ctx.state.pdir = o.dir & 3;
          for(let s = 0; s < steps; s++){
            if(o.dir === 0) ctx.state.pY--;
            else if(o.dir === 1) ctx.state.pY++;
            else if(o.dir === 2) ctx.state.pX--;
            else if(o.dir === 3) ctx.state.pX++;
          }
          ctx.state.updateCam?.();
        }
      } else {
        const list = ctx.npcData[ctx.curArea]?.npcs;
        if(list && o.npcIdx < list.length){
          const n = list[o.npcIdx];
          n.flag = (n.flag & ~3) | (o.dir & 3);
          for(let s = 0; s < steps; s++){
            if(o.dir === 0) n.y--;
            else if(o.dir === 1) n.y++;
            else if(o.dir === 2) n.x--;
            else if(o.dir === 3) n.x++;
          }
        }
      }
    }
    else if(o.op === 0xFF10){
      // Conditional flag write: if party_state == cond, flags[flagIdx] = flagVal & 0xFF.
      // ctx.partyState mirrors cs:0xb1d9 (defaults to 0 — lead character).
      const partyState = ctx.partyState ?? 0;
      if(partyState === o.cond){
        ctx.flags[o.flagIdx] = o.flagVal & 0xFF;
      }
      // The enemy-trigger side effect is left for a future combat rewrite;
      // storing the enemy ID so the engine can surface it if needed.
      ctx.pendingEnemy = o.enemy & 0xFF;
    }
  }
}

// Cutscene-format script fallback (e.g. TS001.15T).
// No per-entry header — the opcode stream starts at the first 0xFF** word.
// Returns the same shape as parseScript15T with a single entry at index 0.
export function parseCutscene15T(buf){
  const d = new Uint8Array(buf);
  let start = -1;
  for(let i = 0; i + 1 < d.length; i += 2){
    const w = d[i] | (d[i+1] << 8);
    if(w >= 0xFF00 && w <= 0xFFFF){ start = i; break; }
  }
  if(start < 0) return null;
  const entries = [{off: start, size: d.length - start}];
  for(let i = 1; i < 64; i++) entries.push({off: 0, size: 0});
  return {buf: d, entries};
}
