import {W, H, TW, TH, MCOLS, MROWS, TRANSP} from './constants.js';

// Palette (VGAM.DAC / VGA.DAC): 768 bytes = 256 × (R,G,B) at 6-bit.
export function parsePal(buf){
  const b = new Uint8Array(buf);
  const o = new Uint32Array(256);
  for(let i = 0; i < 256; i++){
    const r = (b[i*3] << 2) | (b[i*3] >> 4);
    const g = (b[i*3+1] << 2) | (b[i*3+1] >> 4);
    const bl = (b[i*3+2] << 2) | (b[i*3+2] >> 4);
    o[i] = 0xFF000000 | (bl << 16) | (g << 8) | r;
  }
  return o;
}

// Tile atlas (SMAP*.SMP): [count × 120 pixel bytes] [count × attr bytes].
// Attr: 0 = ground, 1 = foreground overlay, 2 = skip.
export function buildAtlas(buf, pal, tileCount){
  const d = new Uint8Array(buf);
  const acols = 40, arows = Math.ceil(tileCount / acols);
  const c = document.createElement('canvas');
  c.width = acols * TW;
  c.height = arows * TH;
  const cx = c.getContext('2d');
  const img = cx.createImageData(c.width, c.height);
  const px = new Uint32Array(img.data.buffer);
  for(let t = 0; t < tileCount; t++){
    const base = t * TW * TH;
    const ax = (t % acols) * TW;
    const ay = Math.floor(t / acols) * TH;
    for(let y = 0; y < TH; y++){
      for(let x = 0; x < TW; x++){
        const pv = d[base + y * TW + x];
        px[(ay + y) * c.width + ax + x] = (pv === TRANSP) ? 0 : pal[pv];
      }
    }
  }
  cx.putImageData(img, 0, 0);
  const attrOff = tileCount * TW * TH;
  const attrs = new Uint8Array(d.buffer, d.byteOffset + attrOff, tileCount);
  return {canvas: c, cols: acols, attrs: new Uint8Array(attrs)};
}

// 24×24 sprites (PLAYER.TOS: 32 frames; POL001.TOS: 640 frames = 80 chars × 8).
export function parseSprites24(buf, pal){
  const d = new Uint8Array(buf);
  const N = d.length / 576 | 0;
  const frames = [];
  for(let f = 0; f < N; f++){
    const c = document.createElement('canvas');
    c.width = 24; c.height = 24;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(24, 24);
    const px = new Uint32Array(img.data.buffer);
    for(let i = 0; i < 576; i++){
      const idx = d[f*576 + i];
      px[i] = (idx === TRANSP) ? 0 : pal[idx];
    }
    ctx.putImageData(img, 0, 0);
    frames.push(c);
  }
  return frames;
}

// ENEMY.TOS battle-monster sprites.
// Format extracted from ATT.LOD (the battle-mode overlay MZ executable) at
// CS:0xbc2a — the loader that MG2.EXE chains to when combat starts.
//
//   Header: N × 4 bytes, each = u32 file offset encoded as
//           (u16 HIGH, u16 LOW) — both u16s are little-endian, but the
//           TWO-word order is big-endian. i.e. offset = (w0 << 16) | w1.
//   Frame : (u16 width-1 LE, u16 height-1 LE), then width×height raw palette
//           bytes (no compression).  0xFF = transparent.
//
// N is derived from firstOffset/4 (the first frame begins right after the
// header table). Frames with out-of-range dimensions are returned as null.
// File is ~2.1 MB, 300 header slots, ~265 valid frames (lizards, dragons,
// slimes, skeletons, the big grey lizard from fight1.png, etc).
export function parseEnemyTOS(buf, pal){
  const data = new Uint8Array(buf);
  const dv = new DataView(buf);
  const readOff = (i) => (dv.getUint16(i*4, true) << 16) | dv.getUint16(i*4 + 2, true);
  const first = readOff(0);
  const N = (first / 4) | 0;
  const out = new Array(N);
  for(let i = 0; i < N; i++){
    const off = readOff(i);
    if(off === 0 || off + 4 >= data.length){ out[i] = null; continue; }
    const w = dv.getUint16(off, true) + 1;
    const h = dv.getUint16(off + 2, true) + 1;
    if(w === 0 || h === 0 || w > 320 || h > 200 || off + 4 + w*h > data.length){
      out[i] = null; continue;
    }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    const px = new Uint32Array(img.data.buffer);
    const base = off + 4;
    for(let p = 0; p < w*h; p++){
      const pv = data[base + p];
      px[p] = (pv === TRANSP) ? 0 : pal[pv];
    }
    ctx.putImageData(img, 0, 0);
    out[i] = {w, h, canvas: c};
  }
  return out;
}

// ENEMY.DAT — per-sprite stat table (opened by ATT.LOD at CS:0xb767).
// 300 × 80-byte records. Record i describes the monster drawn by
// ENEMY.TOS sprite i (1:1 mapping, confirmed by matching known big
// bosses — record 9 HP=3500 matches the big red muscle demon sprite,
// record 17 HP=850 matches the big grey lizard, record 122 HP=6/DEF=999/
// SPD=999/EXP=10000 matches the GOLDEN sparkling boxer "metal slime").
//
// Field layout (u16 LE, by 2-byte index):
//   [0]  HP current    [1]  MP current
//   [2]  HP max        [3]  MP max
//   [4]  ATK           [5]  DEF
//   [6]  SPD           [7]  ? (nonzero on some)
//   [8]  mATK          [9]  mDEF
//   [10] ? elem resist flags
//   [16] alive flag (always 1)
//   [19] element type (0-5)
//   [20-22] class/type metadata (not a name index — 195/196 share these)
//   [36] EXP reward   [38] gold reward
export function parseEnemyDAT(buf){
  const data = new Uint8Array(buf);
  const dv = new DataView(buf);
  const N = (data.length / 80) | 0;
  const out = new Array(N);
  for(let i = 0; i < N; i++){
    const o = i * 80;
    out[i] = {
      hp:     dv.getUint16(o + 4,  true),   // use [2] HP-max as the encounter HP
      maxHp:  dv.getUint16(o + 4,  true),
      mp:     dv.getUint16(o + 6,  true),
      maxMp:  dv.getUint16(o + 6,  true),
      atk:    dv.getUint16(o + 8,  true),
      def:    dv.getUint16(o + 10, true),
      spd:    dv.getUint16(o + 12, true),
      mgAtk:  dv.getUint16(o + 16, true),
      mgDef:  dv.getUint16(o + 18, true),
      element:dv.getUint16(o + 38, true),
      exp:    dv.getUint16(o + 72, true),
      gold:   dv.getUint16(o + 76, true),
      sprite: i,   // 1:1 with ENEMY.TOS
    };
  }
  return out;
}

// ATT.LOD encounter pool — the REAL monster selection table.
//
// Lives at DS:0x30de in ATT.LOD (file offset 0xE0F0 + 0x30DE = 0x111CE,
// where 0xE0F0 is the data-segment base reached via `mov ds, cs:[0x72]`
// after relocation). Layout:
//   2 groups × 25 biomes × 10 × u16
//   group 0 = "low-level pool" used when MG2.EXE writes cs:[0xb1e9]=0
//             (outdoor tile-picker for areas 1-4)
//   group 1 = "standard pool" used when cs:[0xb1e9]=1 (AREA_ENEMY zones)
// Each u16 is a direct ENEMY.DAT record index. A biome's 10 slots are
// RNG'd uniformly at encounter time.
//
// MG2.EXE's `cs:[0xb1ed]` (the 1-4 tile-picker value) is WRITTEN but not
// read by ATT.LOD — the actual monster comes from the pool. That's why
// a strict "cs:[0xb1ed] → ENEMY.DAT" read produced HP-420 blue spearmen
// on grass tiles: we were indexing the wrong way.
export function parseATTEncounterPool(buf){
  const data = new Uint8Array(buf);
  const dv = new DataView(buf);
  // 2 groups × 500 bytes each × 10 biomes — parse both groups fully.
  // We only care about groups 0 and 1 in the picker; groups 2+ are the
  // reward / scaling tables.
  const out = [[], []];
  const TABLE_OFF = 0x111CE;  // file offset of group 0 biome 0
  for(let g = 0; g < 2; g++){
    for(let b = 0; b < 25; b++){
      const base = TABLE_OFF + g * 0x1f4 + b * 20;
      const ids = new Array(10);
      for(let i = 0; i < 10; i++){
        ids[i] = dv.getUint16(base + i * 2, true);
      }
      out[g][b] = ids;
    }
  }
  return out;
}

// SMAPNN.ATS — per-map biome layer. One byte per tile (208 × 155 = 32240 bytes).
// MG2.EXE areas 1-4 seek to `pY * 208 + pX` and read 1 byte → the biome id
// for the player's current tile (disasm 0x19c1-0x19e4 / 0x19f4-0x1a17).
export function parseATS(buf){
  return new Uint8Array(buf);
}

// ATT.LOD level-up EXP threshold table (disasm ATT.LOD 0x1c67). The code
// reads `[bx + 0x34c6]` with DS base at image offset 0xdef0, so the table
// sits at file offset 0xE0F0 + 0x34C6 = 0x115B6. 70 × u16 entries indexed
// by (level - 1). Beyond level 70 the code hard-codes 0x84D0 = 33,872 +
// RNG(0..132).
//
// The runtime threshold applied to the party member is:
//     next_exp_threshold = table[level-1] + RNG(0..(table[level-1] >> 8))
// i.e. the high byte of the table value is the random-jitter range.
export function parseATTLevelTable(buf){
  const dv = new DataView(buf);
  const BASE = 0x115B6;
  const N = 70;
  const out = new Uint16Array(N);
  for(let i = 0; i < N; i++){
    out[i] = dv.getUint16(BASE + i * 2, true);
  }
  return out;
}

// PackBits (disasm 0x2480): b>=0x80 → (256-b+1) copies of next byte; else (b+1) literals.
export function decodePBM(buf, pal){
  const src = new Uint8Array(buf);
  const px = new Uint8Array(W * H);
  let i = 0, o = 0;
  while(o < W*H && i < src.length){
    const b = src[i++];
    if(b >= 0x80){
      const n = 256 - b + 1;
      const v = src[i++];
      for(let k = 0; k < n && o < W*H; k++) px[o++] = v;
    } else {
      const n = b + 1;
      for(let k = 0; k < n && o < W*H; k++){
        if(i >= src.length) break;
        px[o++] = src[i++];
      }
    }
  }
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H);
  const rgba = new Uint32Array(img.data.buffer);
  for(let k = 0; k < W*H; k++) rgba[k] = pal[px[k]];
  ctx.putImageData(img, 0, 0);
  return c;
}

// INOUT.DAT areas (disasm 0x2190). Trigger target fields are (Y, X) — see 0x22E6.
// target_area == 0xF000 means SCRIPT (target_y = script_id).
export function parseAreas(buf){
  const data = new Uint8Array(buf);
  const dv = new DataView(buf);
  const areas = {};
  const max = Math.min(200, data.length / 4 | 0);
  for(let aid = 1; aid < max; aid++){
    const off = dv.getUint16(aid*4, true);
    const sz = dv.getUint16(aid*4+2, true);
    if(off === 0 || off >= data.length || sz < 13 || off+sz > data.length) continue;
    let name = '';
    for(let i = 0; i < 8; i++){
      const b = data[off+i];
      if(b < 32) break;
      name += String.fromCharCode(b);
    }
    name = name.trim();
    if(!name || !/^[A-Z0-9-]+$/i.test(name)) continue;
    const tileset = dv.getUint16(off+8, true);
    const flag = data[off+10];
    const misc = dv.getUint16(off+11, true);
    const triggers = [];
    const scripts = [];
    for(let i = off+13; i+10 <= off+sz; i += 10){
      const sy = dv.getUint16(i, true);
      const sx = dv.getUint16(i+2, true);
      const ta = dv.getUint16(i+4, true);
      const ty = dv.getUint16(i+6, true);
      const tx = dv.getUint16(i+8, true);
      if(ta === 0xF000) scripts.push({sx, sy, scriptId: ty});
      else if(ta >= 1 && ta < 300) triggers.push({sx, sy, ta, tx, ty});
    }
    areas[aid] = {map: name, tileset, flag, misc, triggers, scripts};
  }
  return areas;
}

// POL.DAT (disasm 0x234E). sprite is CHARACTER index (0–79); flag & 3 = facing.
export function parseNPCs(buf){
  const data = new Uint8Array(buf);
  const dv = new DataView(buf);
  const by = {};
  for(let aid = 0; aid < 200; aid++){
    if(aid*4+4 > data.length) break;
    const off = dv.getUint16(aid*4, true);
    const count = dv.getUint16(aid*4+2, true);
    if(off === 0 || off >= data.length || count > 50) continue;
    let script = '';
    for(let i = 0; i < 8; i++){
      const b = data[off+i];
      if(b < 32) break;
      script += String.fromCharCode(b);
    }
    // count === 0 means "no NPCs but the area has a .15T script file" — e.g.
    // D01 has no NPCs but dispatches TD001 for its (142,50) invisible-block.
    // Register a bare entry so the script-trigger path can still find the name.
    if(count === 0){ by[aid] = {script: script.trim(), npcs: []}; continue; }
    const npcs = [];
    for(let i = 0; i < count; i++){
      const e = off + 28 + i * 20;
      if(e + 20 > data.length) break;
      const y = dv.getUint16(e, true);
      const x = dv.getUint16(e+2, true);
      const y2 = dv.getUint16(e+4, true);
      const x2 = dv.getUint16(e+6, true);
      const sprite = dv.getUint16(e+8, true);
      const flag = dv.getUint16(e+10, true);
      if(x === 10 && y === 10 && sprite === 0) continue;
      // `rawIdx` is the position in the POL.DAT block before any filtering,
      // matching the disasm's `dx` counter at 0x2D0B onward. The script
      // dispatcher (0x8840) uses this as the script_id, and dialog text
      // sits at .15T entry [rawIdx*10 + 1].
      // Cache _orig* for every field SJN.DAT or a script can mutate.
      // doLoad uses these to wipe the NPC table back to POL.DAT defaults
      // before replaying flags + SJN — without this, loading an older
      // save can leak forward state (e.g. the gate guard's direction)
      // from the newer playthrough still in memory.
      // `spawned` is set true by FF60 when a script first materialises
      // a script-bound NPC; before that script runs the NPC is hidden
      // if its position collides with a 0xF000 script trigger.
      if(x < MCOLS && y < MROWS) npcs.push({
        x, y, x2, y2, sprite, flag,
        hidden: false, spawned: false,
        rawIdx: i,
        _origX: x, _origY: y, _origX2: x2, _origY2: y2,
        _origSprite: sprite, _origFlag: flag,
      });
    }
    if(npcs.length > 0) by[aid] = {script: script.trim(), npcs};
  }
  return by;
}

// GEM.DAT: 200 × 302 bytes = count(u16) + count × (y,x,id,f1,f2) u16.
export function parseTreasures(buf){
  const data = new Uint8Array(buf);
  const dv = new DataView(buf);
  const by = {};
  for(let aid = 0; aid < 200; aid++){
    const off = aid * 302;
    if(off + 2 > data.length) break;
    const count = dv.getUint16(off, true);
    if(count === 0 || count > 30) continue;
    const list = [];
    for(let i = 0; i < count; i++){
      const r = off + 2 + i*10;
      if(r + 10 > data.length) break;
      const y = dv.getUint16(r, true);
      const x = dv.getUint16(r+2, true);
      const id = dv.getUint16(r+4, true);
      const f1 = dv.getUint16(r+6, true);
      const f2 = dv.getUint16(r+8, true);
      if(x < MCOLS && y < MROWS){
        list.push({x, y, id, flag1: f1, flag2: f2, collected: false});
      }
    }
    if(list.length > 0) by[aid] = list;
  }
  return by;
}

// SJN.DAT — per-area conditional NPC override table consumed by FF80
// (disasm 0x9101 → 0x9699 → 0x97DE) in MG2.EXE. This is THE complete
// quest-blocker map: 46 areas × ~3 conditions each = 139 total
// "if flag X meets value, mutate NPC Y" rules.
//
// Format:
//   [aid * 4]: u16 offset, u16 length    (offset = 0 means area unused)
//   body at offset:
//     repeat:
//       u16 flag_idx, u8 op, u8 value      (4-byte condition header)
//         ops: 0='==', 1='!=', 2='>=', 3='<=', 4='>', 5='<'
//       result records until FF1A (0x1A 0xFF):
//         0xF0 npc field val             (NPC field write — primary)
//         0xF1 ...                       (7-byte map-tile rewrite)
//         <other>                        (6-byte map-tile rewrite)
//     terminated by FF1A
//
// We parse F0 records into structured data and keep raw bytes for the
// other types so a future tile-rewrite pass can consume them.
export function parseSJN(buf){
  const data = new Uint8Array(buf);
  const dv = new DataView(buf);
  const out = {};
  for(let aid = 0; aid < 200; aid++){
    if(aid*4 + 4 > data.length) break;
    const off = dv.getUint16(aid*4, true);
    const sz  = dv.getUint16(aid*4 + 2, true);
    if(!off || !sz || off + sz > data.length) continue;
    const conds = [];
    let i = off;
    const end = off + sz;
    while(i < end){
      if(i + 4 > end) break;
      const w = data[i] | (data[i+1] << 8);
      if(w === 0xFF1A) break;
      const cond = {flag: w, op: data[i+2], value: data[i+3], npcWrites: [], rawTiles: []};
      let j = i + 4;
      while(j < end){
        if(j + 1 < end && data[j] === 0x1A && data[j+1] === 0xFF){ j += 2; break; }
        if(data[j] === 0xF0){
          cond.npcWrites.push({npc: data[j+1], field: data[j+2], value: data[j+3]});
          j += 4;
        } else if(data[j] === 0xF1){
          cond.rawTiles.push(data.slice(j, j+7));
          j += 7;
        } else {
          cond.rawTiles.push(data.slice(j, j+6));
          j += 6;
        }
      }
      conds.push(cond);
      i = j;
    }
    if(conds.length) out[aid] = conds;
  }
  return out;
}

// MG2.15 shared string table (disasm 0xA21).
// 1000 × (u8 glyph_count, u16 offset) → 30-byte 16×15 glyph bitmaps.
export function parseMG215(buf){
  const data = new Uint8Array(buf);
  const dv = new DataView(buf);
  const names = {};
  for(let i = 0; i < 1000; i++){
    if(i*3 + 3 > data.length) break;
    const count = data[i*3];
    const off = dv.getUint16(i*3 + 1, true);
    if(count > 0 && count < 16 && off + count*30 <= data.length){
      names[i] = data.subarray(off, off + count*30);
    }
  }
  return names;
}
