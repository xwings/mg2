// Authentic UI chrome toolkit, replicating MG2.EXE's drawing primitives
// (all coordinates/colors from the disasm — see ARCHITECTURE/render.md):
//
//   drawWindow  — 0xB503: translucent darken of what's behind (COLORM
//                 LUT 2, approximated as an alpha overlay) + 3 nested
//                 1-px borders: black, palette 0x4A yellow, 0x54 brown.
//   drawString  — 0x989/0xABB: MG2.15 entry, 16-px advance; per glyph
//                 4 offset outline passes (up 0x0C, down 0x0E, left
//                 0x0B, right black) + 5-band vertical gradient body
//                 (colors base..base+4, 3 rows per band).
//   drawGlyphs  — 0xB97 style (P.15/M.15/dialog text): black drop
//                 shadow (+0,+1)/(+1,0) + same gradient body.
//   drawNum     — 0xC26/0xCBC/0xE10 8×8 N15.T15 digits (outline +
//                 3-band gradient) and 0xF64/0x1040/0x111A 16-px digits
//                 (MG2.15 entries 0x3D4+d).
//   drawHand    — M_IP.DAT 20×15 hand cursor with the timer wiggle.
//   drawSelBar  — 102×20 darken bar + 1-px palette 0xBD red border.
//
// Base color 0xEF is the "fire gradient": the original palette-cycles
// DAC entries 0xEF-0xF3 every 14 ticks (~194 ms); we rotate the band
// colors on the same period.

const FIRE_BASE = 0xEF;
const FIRE_PERIOD_MS = 194;

export function createUI(ctx, pal, {stringTable, colorLUTs, n15, handFrames}){
  const css = (idx) => {
    const c = pal[idx] ?? 0;
    return 'rgb(' + (c & 0xFF) + ',' + ((c >> 8) & 0xFF) + ',' + ((c >> 16) & 0xFF) + ')';
  };
  const windowAlpha = colorLUTs?.[2]?.darken ?? 0.35;
  const barAlpha    = colorLUTs?.[0]?.darken ?? 0.15;

  function firePhase(){
    return Math.floor(performance.now() / FIRE_PERIOD_MS) % 5;
  }

  // Gradient band colors for a base index; fire base rotates.
  function bandColors(base){
    const out = [];
    const phase = base === FIRE_BASE ? firePhase() : 0;
    for(let b = 0; b < 5; b++) out.push(css(base + (b + phase) % 5));
    return out;
  }

  function hollowRect(x, y, w, h, color){
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, 1);
    ctx.fillRect(x, y + h - 1, w, 1);
    ctx.fillRect(x, y, 1, h);
    ctx.fillRect(x + w - 1, y, 1, h);
  }

  function drawWindow(x, y, w, h){
    ctx.fillStyle = 'rgba(0,0,0,' + windowAlpha.toFixed(3) + ')';
    ctx.fillRect(x, y, w, h);
    hollowRect(x,     y,     w,     h,     css(0x00));
    hollowRect(x + 1, y + 1, w - 2, h - 2, css(0x4A));
    hollowRect(x + 2, y + 2, w - 4, h - 4, css(0x54));
  }

  // ── Glyph rendering (16×15, 30 bytes, 2 big-endian bytes per row) ──
  // Rendered once per (bitmap, base, style, phase) into a cached 18×17
  // canvas so per-frame drawing is one drawImage per glyph.
  const glyphCache = new Map();

  function glyphHash(bytes){
    let h = 0;
    for(let i = 0; i < 30; i++) h = (h * 31 + bytes[i]) >>> 0;
    return h;
  }

  function renderGlyph(bytes, base, outlined, phase){
    const c = document.createElement('canvas');
    c.width = 18; c.height = 17;                 // 1-px margin for offsets
    const g = c.getContext('2d');
    const put = (dx, dy, color) => {
      g.fillStyle = color;
      for(let row = 0; row < 15; row++){
        const w = (bytes[row*2] << 8) | bytes[row*2 + 1];
        for(let col = 0; col < 16; col++){
          if(w & (1 << (15 - col))) g.fillRect(1 + dx + col, 1 + dy + row, 1, 1);
        }
      }
    };
    if(outlined){
      put(0, -1, css(0x0C)); put(0, 1, css(0x0E));
      put(-1, 0, css(0x0B)); put(1, 0, css(0x00));
    } else {
      put(0, 1, css(0x00)); put(1, 0, css(0x00));
    }
    // Body: 5 bands × 3 rows, colors base..base+4 (fire base rotated).
    for(let b = 0; b < 5; b++){
      const color = css(base + (b + phase) % 5);
      g.fillStyle = color;
      for(let row = b*3; row < b*3 + 3 && row < 15; row++){
        const w = (bytes[row*2] << 8) | bytes[row*2 + 1];
        for(let col = 0; col < 16; col++){
          if(w & (1 << (15 - col))) g.fillRect(1 + col, 1 + row, 1, 1);
        }
      }
    }
    return c;
  }

  function glyphCanvas(bytes, base, outlined){
    const phase = base === FIRE_BASE ? firePhase() : 0;
    const key = glyphHash(bytes) + ':' + base + ':' + (outlined ? 1 : 0) + ':' + phase;
    let c = glyphCache.get(key);
    if(!c){ c = renderGlyph(bytes, base, outlined, phase); glyphCache.set(key, c); }
    return c;
  }

  // Draw a run of raw 30-byte glyphs; returns x after the last glyph.
  function drawGlyphs(bytes, x, y, base, outlined = false){
    if(!bytes) return x;
    const n = bytes.length / 30 | 0;
    for(let i = 0; i < n; i++){
      ctx.drawImage(glyphCanvas(bytes.subarray(i*30, i*30 + 30), base, outlined), x - 1, y - 1);
      x += 16;
    }
    return x;
  }

  // MG2.15 UI string (outlined style).
  function drawString(entryId, x, y, base){
    return drawGlyphs(stringTable[entryId], x, y, base, true);
  }

  // ── Digits ──
  // 8×8 N15.T15 (0x12CD): 1-px black outline + 3-band gradient.
  const digitCache = new Map();
  function smallDigitCanvas(d, base){
    const key = d + ':' + base;
    let c = digitCache.get(key);
    if(c) return c;
    c = document.createElement('canvas');
    c.width = 10; c.height = 10;
    const g = c.getContext('2d');
    const mask = n15[d];
    const put = (dx, dy, color) => {
      g.fillStyle = color;
      for(let i = 0; i < 64; i++){
        if(mask[i]) g.fillRect(1 + dx + (i & 7), 1 + dy + (i >> 3), 1, 1);
      }
    };
    put(0,-1,'#000'); put(0,1,'#000'); put(-1,0,'#000'); put(1,0,'#000');
    for(let band = 0; band < 3; band++){
      g.fillStyle = css(base + band);
      const r0 = band * 3, r1 = band === 2 ? 8 : r0 + 3;
      for(let i = 0; i < 64; i++){
        const row = i >> 3;
        if(row >= r0 && row < r1 && mask[i]) g.fillRect(1 + (i & 7), 1 + row, 1, 1);
      }
    }
    digitCache.set(key, c);
    return c;
  }

  // Number rendering. opts: {font:'small'|'big', cells:N (fixed-slot,
  // leading zeros blank) or leftPack:true}. Returns x after last digit.
  function drawNum(value, x, y, base, opts = {}){
    const font = opts.font || 'small';
    const pitch = font === 'small' ? 8 : 16;
    const s = String(Math.max(0, Math.floor(value)));
    const drawDigit = (d, dx) => {
      if(font === 'small') ctx.drawImage(smallDigitCanvas(d, base), dx - 1, y - 1);
      else {
        const g = stringTable[0x3D4 + d];
        if(g) drawGlyphs(g.subarray(0, 30), dx, y, base, true);
      }
    };
    if(opts.leftPack){
      for(let i = 0; i < s.length; i++) drawDigit(+s[i], x + i*pitch);
      return x + s.length * pitch;
    }
    const cells = opts.cells || 5;
    const pad = cells - s.length;
    for(let i = 0; i < s.length; i++) drawDigit(+s[i], x + (pad + i) * pitch);
    return x + cells * pitch;
  }

  // ── Cursor / selection ──
  // Hand wiggle (0x5198): 32-tick cycle → x+1, x, x−1, x at ~72 Hz.
  // M_IP.DAT holds two mirrored hands: frame 0 points RIGHT (menus —
  // drawn left of the selection), frame 1 points LEFT (battle target —
  // drawn right of the enemy; only ATT.LOD uses it).
  function drawHand(x, y, frame = 0){
    const img = handFrames && (handFrames[frame] || handFrames[0]);
    if(!img) return;
    const t = Math.floor(performance.now() / 13.9) & 0x1F;
    const dx = t < 9 ? 1 : t < 17 ? 0 : t < 25 ? -1 : 0;
    ctx.drawImage(img, x + dx, y);
  }

  function drawSelBar(x, y, w = 102, h = 20){
    ctx.fillStyle = 'rgba(0,0,0,' + barAlpha.toFixed(3) + ')';
    ctx.fillRect(x, y, w, h);
    hollowRect(x, y, w, h, css(0xBD));
  }

  return {css, drawWindow, hollowRect, drawString, drawGlyphs, drawNum,
          drawHand, drawSelBar, firePhase};
}
