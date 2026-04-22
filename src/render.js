import {
  W, H, TW, TH, VCOLS, VROWS, MCOLS, MROWS,
  VOID, SMP_T, DOOR_T, DOOR_B, DIR_FRAMES,
} from './constants.js';

export function createRenderer(ctx, res){
  const {playerFrames, npcFrames, doorAtlas, doorCol, stringTable,
         itemTables = {}, tryByType = {}} = res;
  // Per-kind item-name lookup mirroring main.js `lookupItemTable`. Used as a
  // fallback when an inventory entry lost its cached glyphs (e.g. after a
  // hot reload before save/load lands again).
  function nameOf(id, kind){
    const tries = tryByType[kind === 2 ? 'equip' : 'basic'] || [];
    let fallback = null;
    for(const [src] of tries){
      const t = itemTables[src];
      if(!t) continue;
      const g = t[id];
      if(!g) continue;
      if(g.length / 30 >= 2) return g;
      if(!fallback) fallback = g;
    }
    return fallback;
  }

  function drawTile(ti, dx, dy, state){
    if(ti === VOID || !state.curAtlas) return;
    if(ti < SMP_T){
      const ac = state.curAtlas.cols;
      const sx = (ti % ac) * TW, sy = Math.floor(ti / ac) * TH;
      ctx.drawImage(state.curAtlas.canvas, sx, sy, TW, TH, dx, dy, TW, TH);
    } else if(ti < DOOR_B + DOOR_T){
      const dac = doorAtlas.cols, di = ti - DOOR_B;
      const sx = (di % dac) * TW, sy = Math.floor(di / dac) * TH;
      ctx.drawImage(doorAtlas.canvas, sx, sy, TW, TH, dx, dy, TW, TH);
    }
  }

  // .HEI byte controls layer-2 render depth (disasm 0x356E / 0x3643):
  //   0 = ground / no overlay (drawn before sprites)
  //   1 = foreground at natural row              (Pass A in 0x356E)
  //   2 = foreground top, tile extends 1 row up  (Pass B — drawn from row+1)
  //   3 = foreground top, tile extends 2 rows up (Pass C — drawn from row+2)
  //   4 = background overlay (Pass in 0x340A — drawn BEFORE sprites)
  // For our deferred-pass renderer that draws all foreground after sprites,
  // attrs 1/2/3 all go on top at their natural map position. attr=4 stays
  // as background.
  function tileIsForeground(ti, state){
    if(ti === VOID) return false;
    if(ti < SMP_T && state.curAtlas && state.curAtlas.attrs){
      const a = state.curAtlas.attrs[ti];
      return a >= 1 && a <= 3;
    }
    if(ti >= DOOR_B && ti < DOOR_B+DOOR_T && doorAtlas && doorAtlas.attrs){
      const a = doorAtlas.attrs[ti-DOOR_B];
      return a >= 1 && a <= 3;
    }
    return false;
  }

  function renderScene(state){
    if(!state.mapL1) return;
    const {mapL1, mapL2, cX, cY} = state;
    // Pass 1: ground layer.
    for(let r = 0; r < VROWS; r++){
      for(let c = 0; c < VCOLS; c++){
        const mr = cY + r, mc = cX + c;
        if(mr < 0 || mr >= MROWS || mc < 0 || mc >= MCOLS) continue;
        drawTile(mapL1[mr * MCOLS + mc], c * TW, r * TH, state);
      }
    }
    // Pass 2: layer-2 background tiles (attr != 1). Foreground drawn later.
    for(let r = 0; r < VROWS; r++){
      for(let c = 0; c < VCOLS; c++){
        const mr = cY + r, mc = cX + c;
        if(mr < 0 || mr >= MROWS || mc < 0 || mc >= MCOLS) continue;
        const ti = mapL2[mr * MCOLS + mc];
        if(!tileIsForeground(ti, state)) drawTile(ti, c * TW, r * TH, state);
      }
    }
  }

  // Pass 3: layer-2 foreground + any layer-1 foreground tiles. Called after
  // sprites so player walks under treetops / bridge rails.
  function renderForeground(state){
    if(!state.mapL1) return;
    const {mapL1, mapL2, cX, cY} = state;
    for(let r = 0; r < VROWS; r++){
      for(let c = 0; c < VCOLS; c++){
        const mr = cY + r, mc = cX + c;
        if(mr < 0 || mr >= MROWS || mc < 0 || mc >= MCOLS) continue;
        const ti2 = mapL2[mr * MCOLS + mc];
        if(tileIsForeground(ti2, state)) drawTile(ti2, c * TW, r * TH, state);
        const ti1 = mapL1[mr * MCOLS + mc];
        if(tileIsForeground(ti1, state)) drawTile(ti1, c * TW, r * TH, state);
      }
    }
  }

  function drawPlayer(state){
    const fi = DIR_FRAMES[state.pdir][state.walkTog];
    ctx.drawImage(playerFrames[fi], (state.pX - state.cX) * TW - 6, (state.pY - state.cY) * TH - 14);
  }

  function drawNPCs(state, npcData, npcHidden, npcPos){
    const aData = npcData[state.curArea];
    if(!aData || !npcFrames.length) return;
    // Alternate the 2 walk frames per direction at the real AI cadence
    // (30 fps / 0x1E ≈ 0.57 Hz) so static NPCs still idle-bob.
    const idleTog = Math.floor(performance.now() / 500) & 1;
    for(const n of aData.npcs){
      if(npcHidden(n)) continue;
      // Effective position — MOVE_WHEN_FLAG can shift a blocker NPC after
      // the gating quest completes (instead of HIDE_WHEN_FLAG removing it).
      const p = npcPos ? npcPos(n) : {x: n.x, y: n.y};
      if(p.x < state.cX - 2 || p.x >= state.cX + VCOLS + 2) continue;
      if(p.y < state.cY - 2 || p.y >= state.cY + VROWS + 2) continue;
      const dir = (n.flag & 3);
      const frames = DIR_FRAMES[dir] || DIR_FRAMES[0];
      const frameBase = (n.sprite * 8) + frames[idleTog];
      const fi = frameBase % npcFrames.length;
      ctx.drawImage(npcFrames[fi], (p.x - state.cX) * TW - 6, (p.y - state.cY) * TH - 14);
    }
  }

  function drawTreasures(state, treasureData){
    const list = treasureData[state.curArea];
    if(!list) return;
    const now = performance.now();
    for(const t of list){
      if(t.collected) continue;
      if(t.x < state.cX || t.x >= state.cX + VCOLS) continue;
      if(t.y < state.cY || t.y >= state.cY + VROWS) continue;
      const sx = (t.x - state.cX) * TW, sy = (t.y - state.cY) * TH;
      const pulse = Math.sin(now / 200) * 0.3 + 0.7;
      ctx.fillStyle = `rgba(255,215,0,${pulse})`;
      ctx.fillRect(sx + 2, sy + 1, 8, 8);
      ctx.fillStyle = '#8B4513';
      ctx.fillRect(sx + 3, sy + 2, 6, 6);
      ctx.fillStyle = '#ffcc00';
      ctx.fillRect(sx + 5, sy + 3, 2, 2);
    }
  }

  function drawTriggerOverlay(state, areas){
    if(!areas[state.curArea]) return;
    ctx.save();
    ctx.globalAlpha = 0.55;
    for(const t of areas[state.curArea].triggers){
      if(t.sx === 0 || t.sy === 0) continue;
      const sx = (t.sx - state.cX) * TW, sy = (t.sy - state.cY) * TH;
      if(sx < -TW || sx > W || sy < -TH || sy > H) continue;
      ctx.fillStyle = '#f0f';
      ctx.fillRect(sx, sy, TW, TH);
      ctx.fillStyle = '#fff';
      ctx.font = '6px monospace';
      ctx.fillText('A' + t.ta, sx, sy - 1);
    }
    for(const s of (areas[state.curArea].scripts || [])){
      const sx = (s.sx - state.cX) * TW, sy = (s.sy - state.cY) * TH;
      if(sx < -TW || sx > W || sy < -TH || sy > H) continue;
      ctx.fillStyle = '#0ff';
      ctx.fillRect(sx, sy, TW, TH);
      ctx.fillStyle = '#000';
      ctx.font = '6px monospace';
      ctx.fillText('S' + s.scriptId, sx, sy + TH - 1);
    }
    ctx.restore();
  }

  function drawHUD(state, areas, npcData, treasureData, showTriggers){
    if(showTriggers) drawTriggerOverlay(state, areas);
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(0, 0, W, 14);
    ctx.fillStyle = '#f44';
    ctx.fillRect(4, 4, (state.hp / state.maxHp) * 48, 6);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.strokeRect(4, 4, 48, 6);
    ctx.fillStyle = '#fff';
    ctx.font = '7px monospace';
    // MG2.15 entry 10 is the "HP" glyph (compact H+P). Use the real glyph
    // when available so the label matches DOSBox; fall back to text.
    const hpLabel = stringTable[10];
    if(hpLabel){
      // glyph is 16×15; HUD row is 14px tall. Draw at y=-1 and clip visually.
      ctx.save();
      ctx.beginPath();
      ctx.rect(54, 0, 14, 12);
      ctx.clip();
      drawGlyph(hpLabel.subarray(0, 30), 54, -1);
      ctx.restore();
      ctx.fillText(state.hp + '/' + state.maxHp, 69, 10);
    } else {
      ctx.fillText('HP ' + state.hp + '/' + state.maxHp, 55, 10);
    }
    ctx.fillStyle = '#ff0';
    ctx.fillText('$' + state.gold, 105, 10);
    ctx.fillStyle = '#0f0';
    const mapName = areas[state.curArea] ? areas[state.curArea].map : '?';
    ctx.fillText(mapName + ' (' + state.pX + ',' + state.pY + ')', 135, 10);
    ctx.fillStyle = '#888';
    ctx.fillText('SPACE:talk  ESC:menu', W - 110, 10);

    const mmX = W - 54, mmY = 16, mmSize = 50;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(mmX, mmY, mmSize, mmSize);
    ctx.strokeStyle = '#0f0';
    ctx.strokeRect(mmX, mmY, mmSize, mmSize);
    if(state.mapL1){
      for(let mr = Math.max(0, state.pY - 15); mr < Math.min(MROWS, state.pY + 15); mr++){
        for(let mc = Math.max(0, state.pX - 25); mc < Math.min(MCOLS, state.pX + 25); mc++){
          const ti = state.mapL1[mr * MCOLS + mc];
          if(ti === VOID) continue;
          const mpx = (mc - state.pX + 25) * mmSize / 50;
          const mpy = (mr - state.pY + 15) * mmSize / 30;
          ctx.fillStyle = (ti < SMP_T && state.curCol[ti] === 1) ? '#644' : '#4a4';
          ctx.fillRect(mmX + mpx, mmY + mpy, 1, 1);
        }
      }
    }
    if(areas[state.curArea]){
      for(const t of areas[state.curArea].triggers){
        if(t.sx === 0 || t.sy === 0) continue;
        const mpx = (t.sx - state.pX + 25) * mmSize / 50, mpy = (t.sy - state.pY + 15) * mmSize / 30;
        if(mpx >= 0 && mpx < mmSize && mpy >= 0 && mpy < mmSize){
          ctx.fillStyle = '#f0f';
          ctx.fillRect(mmX + mpx - 1, mmY + mpy - 1, 3, 3);
        }
      }
    }
    if(npcData[state.curArea]){
      for(const n of npcData[state.curArea].npcs){
        const mpx = (n.x - state.pX + 25) * mmSize / 50, mpy = (n.y - state.pY + 15) * mmSize / 30;
        if(mpx >= 0 && mpx < mmSize && mpy >= 0 && mpy < mmSize){
          ctx.fillStyle = '#ff0';
          ctx.fillRect(mmX + mpx - 1, mmY + mpy - 1, 2, 2);
        }
      }
    }
    if(treasureData[state.curArea]){
      for(const t of treasureData[state.curArea]){
        if(t.collected) continue;
        const mpx = (t.x - state.pX + 25) * mmSize / 50, mpy = (t.y - state.pY + 15) * mmSize / 30;
        if(mpx >= 0 && mpx < mmSize && mpy >= 0 && mpy < mmSize){
          ctx.fillStyle = '#fa0';
          ctx.fillRect(mmX + mpx - 1, mmY + mpy - 1, 2, 2);
        }
      }
    }
    ctx.fillStyle = '#fff';
    ctx.fillRect(mmX + mmSize / 2 - 1, mmY + mmSize / 2 - 1, 2, 2);
  }

  // Item category color map. `source` values match main.js `TABLE_NAMES`:
  //   item   (M.15)   — general items / spells
  //   weapon (ATT.15) — weapons, armor
  //   potion (P.15)   — potions / consumables
  //   misc   (MG2.15) — fallback / UI-label-sourced names
  //   script          — resolved by running a .15T entry
  const SOURCE_COLORS = {
    item:   '#9cf',   // cyan — items / spells
    weapon: '#f96',   // orange — weapons / armor
    potion: '#6f9',   // green — potions
    misc:   '#ccc',   // gray — unresolved / generic
    script: '#fc6',   // gold — from script run
  };
  const SOURCE_BADGES = {
    item: 'itm', weapon: 'wpn', potion: 'pot', misc: '---', script: 'spc',
  };

  // 30-byte 16×15 bitmap at 1:1. Downscaling Chinese glyphs merges strokes;
  // keep native size and use cell stride for breathing room instead.
  function drawGlyph(bytes, dx, dy, color){
    ctx.fillStyle = color || '#fff';
    for(let row = 0; row < 15; row++){
      const w = (bytes[row * 2] << 8) | bytes[row * 2 + 1];
      for(let col = 0; col < 16; col++){
        if(w & (1 << (15 - col))) ctx.fillRect(dx + col, dy + row, 1, 1);
      }
    }
  }

  // Dialog layout matches DOSBox (disasm 0xABB). Lines at y=128/145/162/179.
  const DLG_H = 78;
  const DLG_LINES = [128, 145, 162, 179];
  function drawScriptPage(page, speakerName, totalPages, pageIdx){
    const boxY = H - DLG_H;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, boxY, W, DLG_H);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, boxY + 0.5, W - 1, DLG_H - 1);
    // DOSBox renders cells at 17px stride (16px glyph + 1px gap). Without
    // the gap Chinese strokes from adjacent characters touch and the line
    // becomes unreadable.
    const textX = 4;
    const cw = 17;
    const maxCols = Math.floor((W - 8) / cw);
    for(let row = 0; row < Math.min(4, page.length); row++){
      const line = page[row];
      const ly = DLG_LINES[row];
      for(let col = 0; col < Math.min(line.length, maxCols); col++){
        const cell = line[col];
        if(cell.space) continue;
        drawGlyph(cell.glyph, textX + col * cw, ly);
      }
    }
    if(totalPages > 1){
      ctx.fillStyle = '#888';
      ctx.font = '7px monospace';
      ctx.fillText((pageIdx + 1) + '/' + totalPages, 4, boxY - 2);
    }
    if(Math.floor(performance.now() / 400) % 2){
      // MG2.15 entry 12 is the authentic ▼ "next page" indicator.
      const arrow = stringTable[12];
      if(arrow){
        drawGlyph(arrow.subarray(0, 30), W - 18, H - 14);
      } else {
        ctx.fillStyle = '#ff0';
        ctx.font = '9px monospace';
        ctx.fillText('\u25BC', W - 10, H - 3);
      }
    }
  }

  function drawTitle(titleC, titleMenu, has){
    ctx.drawImage(titleC, 0, 0);
    const menuY = H - 70;
    ctx.fillStyle = 'rgba(0,0,0,0.8)';
    ctx.fillRect(W/2 - 80, menuY, 160, 60);
    ctx.strokeStyle = '#ff0';
    ctx.lineWidth = 1;
    ctx.strokeRect(W/2 - 80, menuY, 160, 60);
    ctx.fillStyle = '#ff0';
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('MG2', W/2, menuY + 16);
    ctx.font = '10px monospace';
    const items = ['NEW GAME', has ? 'CONTINUE' : 'CONTINUE (no save)'];
    for(let i = 0; i < 2; i++){
      if(i === titleMenu){
        ctx.fillStyle = '#ff0';
        ctx.fillText('> ' + items[i] + ' <', W/2, menuY + 34 + i * 14);
      } else {
        ctx.fillStyle = '#888';
        ctx.fillText(items[i], W/2, menuY + 34 + i * 14);
      }
    }
    ctx.textAlign = 'left';
  }

  function drawTransition(msg){
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#0f0';
    ctx.font = '12px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(msg || 'Loading...', W/2, H/2);
    ctx.textAlign = 'left';
  }

  function drawPickupMsg(msg, timer){
    const alpha = Math.min(1, timer / 500);
    let boxW = 140;
    if(typeof msg === 'object' && msg.glyphs){
      boxW = Math.max(140, 60 + (msg.glyphs.length / 30) * 17);
    }
    const boxX = (W - boxW) / 2;
    ctx.fillStyle = `rgba(0,0,0,${alpha * 0.85})`;
    ctx.fillRect(boxX, 28, boxW, 24);
    ctx.strokeStyle = `rgba(255,215,0,${alpha})`;
    ctx.strokeRect(boxX, 28, boxW, 24);
    ctx.fillStyle = `rgba(255,255,0,${alpha})`;
    if(typeof msg === 'string'){
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(msg, W/2, 44);
      ctx.textAlign = 'left';
    } else if(msg.type === 'gold'){
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('+ ' + msg.amount + ' Gold', W/2, 44);
      ctx.textAlign = 'left';
    } else if(msg.type === 'item'){
      const tint = SOURCE_COLORS[msg.source] || '#fff';
      ctx.font = 'bold 10px sans-serif';
      ctx.fillStyle = `rgba(255,255,255,${alpha})`;
      ctx.fillText('Got', boxX + 6, 43);
      if(msg.glyphs){
        const nGlyphs = msg.glyphs.length / 30;
        const startX = boxX + 36;
        const startY = 33;
        ctx.save();
        ctx.globalAlpha = alpha;
        for(let g = 0; g < nGlyphs; g++){
          drawGlyph(msg.glyphs.subarray(g * 30, g * 30 + 30), startX + g * 17, startY, tint);
        }
        ctx.restore();
      } else {
        ctx.fillStyle = tint;
        ctx.fillText('#' + msg.id, boxX + 40, 43);
      }
      // Category badge beside the glyphs so pickup type is obvious.
      if(msg.source){
        ctx.fillStyle = tint;
        ctx.font = '7px monospace';
        ctx.fillText('[' + (SOURCE_BADGES[msg.source] || msg.source) + ']', boxX + boxW - 30, 43);
      }
    }
  }

  // Helper: draw a string table entry's glyphs horizontally at (x, y).
  function drawLabel(entryId, x, y){
    const g = stringTable[entryId];
    if(!g) return 0;
    const n = g.length / 30;
    for(let i = 0; i < n; i++) drawGlyph(g.subarray(i*30, i*30+30), x + i*17, y);
    return n * 17;
  }

  // Menu categories aligned with MG2.15 entries 0/1/2 (物品/魔法/裝備).
  // Order: Status, Items, Magic, Equipment, Save, Load, Close.
  // `extra` = {focus, subIdx, msg} for interactive sub-panels.
  function drawGameMenu(state, areas, inventory, gameMenu, magic, equipment, extra){
    const mw = 240, mh = 180;
    const mx = (W - mw) / 2, my = (H - mh) / 2;
    ctx.fillStyle = 'rgba(0,0,0,0.92)';
    ctx.fillRect(mx, my, mw, mh);
    ctx.strokeStyle = '#ff0';
    ctx.lineWidth = 1;
    ctx.strokeRect(mx, my, mw, mh);
    ctx.fillStyle = '#ff0';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('MENU', mx + mw / 2, my + 14);
    const items = [
      {text: 'Status'},
      {text: 'Items', glyph: 0},       // 物品
      {text: 'Magic', glyph: 1},       // 魔法
      {text: 'Equip', glyph: 2},       // 裝備
      {text: 'Save'},
      {text: 'Load'},
      {text: 'Close'},
    ];
    ctx.font = '9px monospace';
    ctx.textAlign = 'left';
    for(let i = 0; i < items.length; i++){
      const it = items[i];
      const y = my + 28 + i * 14;
      const x = mx + 12;
      ctx.fillStyle = (i === gameMenu) ? '#ff0' : '#aaa';
      ctx.fillText((i === gameMenu ? '> ' : '  ') + it.text, x, y + 8);
      if(it.glyph != null){
        ctx.save();
        if(i !== gameMenu) ctx.globalAlpha = 0.5;
        drawLabel(it.glyph, x + 60, y);
        ctx.restore();
      }
    }
    // Detail panel on the right half.
    const dx = mx + mw / 2 + 4, dw = mw / 2 - 8, dy = my + 28, dh = mh - 36;
    ctx.strokeStyle = '#666';
    ctx.strokeRect(dx, dy, dw, dh);
    ctx.fillStyle = '#fff';
    ctx.font = '8px monospace';
    if(gameMenu === 0){
      // Full status view — mirrors DOSBox status2.png layout with every
      // combat stat plus level, EXP, area, and adventure time.
      ctx.fillStyle = '#ffe';
      ctx.font = '8px monospace';
      let yLine = dy + 4;
      const hpG = stringTable[10], mpG = stringTable[11];
      if(hpG) drawGlyph(hpG.subarray(0, 30), dx + 6, yLine);
      else ctx.fillText('HP', dx + 6, yLine + 11);
      ctx.fillText(': ' + state.hp + '/' + state.maxHp, dx + 26, yLine + 11);
      yLine += 16;
      if(mpG) drawGlyph(mpG.subarray(0, 30), dx + 6, yLine);
      else ctx.fillText('MP', dx + 6, yLine + 11);
      ctx.fillText(': ' + state.mp + '/' + state.maxMp, dx + 26, yLine + 11);
      yLine += 16;
      // Combat stats (compact grid — two columns).
      const stats = [
        ['Lv',  state.level ?? 1],
        ['EXP', (state.exp ?? 0) + '/' + (state.level ?? 1) * 50],
        ['ATK', state.atk ?? 0],
        ['DEF', state.def ?? 0],
        ['SPD', state.spd ?? 0],
        ['mATK',state.mgAtk ?? 0],
        ['mDEF',state.mgDef ?? 0],
        ['$',   state.gold ?? 0],
      ];
      for(let i = 0; i < stats.length; i++){
        const [lbl, v] = stats[i];
        const col = i % 2, row = Math.floor(i / 2);
        const sx = dx + 6 + col * 55, sy = yLine + row * 10;
        ctx.fillStyle = '#ddd';
        ctx.fillText(lbl.padEnd(4) + ' ' + v, sx, sy);
      }
      yLine += 4 * 10 + 4;
      ctx.fillStyle = '#aaa';
      ctx.fillText('Area: ' + (areas[state.curArea]?.map || '?'), dx + 6, yLine);
      yLine += 10;
      // Adventure time (h:mm:ss).
      const secs = Math.floor((Date.now() - (state.playStart || Date.now())) / 1000);
      const h = Math.floor(secs / 3600), m = Math.floor(secs / 60) % 60, s = secs % 60;
      ctx.fillText('Time: ' + h + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0'),
                   dx + 6, yLine);
    } else if(gameMenu === 1){
      const focused = extra && extra.focus === 'items';
      let y = dy + 10;
      if(inventory.length === 0){
        ctx.fillStyle = '#888';
        ctx.fillText('(empty)', dx + 6, y + 8);
      } else {
        for(let i = 0; i < Math.min(6, inventory.length); i++){
          const it = inventory[i];
          const glyphs = it.glyphs || nameOf(it.id, it.kind);
          const tint = SOURCE_COLORS[it.source] || '#fff';
          const selected = focused && extra.subIdx === i;
          // Cursor ▶ when the item sub-panel has focus.
          if(selected){
            ctx.fillStyle = '#ff0';
            ctx.fillText('▶', dx - 1, y + 11);
          }
          if(glyphs){
            const n = glyphs.length / 30;
            for(let g = 0; g < n; g++){
              drawGlyph(glyphs.subarray(g * 30, g * 30 + 30), dx + 10 + g * 17, y, selected ? '#ff0' : tint);
            }
            ctx.fillStyle = selected ? '#ff0' : '#ccc';
            ctx.fillText('x' + it.count, dx + 10 + n * 17 + 2, y + 11);
          } else {
            // Shop-bought items have .shopName instead of glyphs.
            ctx.fillStyle = selected ? '#ff0' : tint;
            ctx.fillText((it.shopName || ('#' + it.id)) + ' x' + it.count, dx + 10, y + 11);
          }
          if(it.source){
            ctx.fillStyle = selected ? '#ff0' : tint;
            ctx.font = '7px monospace';
            ctx.fillText(SOURCE_BADGES[it.source] || it.source, dx + dw - 22, y + 10);
            ctx.font = '8px monospace';
          }
          y += 17;
        }
        // Footer hint + action message.
        ctx.fillStyle = '#aaa';
        ctx.font = '7px monospace';
        if(focused){
          ctx.fillText('SPACE 使用   ESC 返回', dx + 4, dy + dh - 14);
          if(extra.msg){
            ctx.fillStyle = '#0f0';
            ctx.fillText(extra.msg, dx + 4, dy + dh - 4);
          }
        } else {
          ctx.fillText('SPACE 開啟物品', dx + 4, dy + dh - 4);
        }
        ctx.font = '8px monospace';
      }
    } else if(gameMenu === 2){
      const focused = extra && extra.focus === 'magic';
      const spells = state.spells || [];
      if(spells.length === 0){
        ctx.fillStyle = '#888';
        ctx.fillText('(no spells learned)', dx + 6, dy + 14);
      } else {
        let y = dy + 10;
        for(let i = 0; i < Math.min(6, spells.length); i++){
          const sp = spells[i];
          const selected = focused && extra.subIdx === i;
          if(selected){
            ctx.fillStyle = '#ff0';
            ctx.fillText('▶', dx - 1, y + 8);
          }
          // Highlight heal spells as usable from menu; damage spells only in battle.
          const usableHere = sp.target === 'self' && sp.kind === 'heal';
          ctx.fillStyle = selected ? '#ff0' : (usableHere ? '#cfc' : '#aaa');
          ctx.fillText(sp.name + '  MP ' + sp.mpCost, dx + 10, y + 8);
          y += 12;
        }
        ctx.fillStyle = '#aaa';
        ctx.font = '7px monospace';
        if(focused){
          ctx.fillText('SPACE 使用   ESC 返回', dx + 4, dy + dh - 14);
          if(extra.msg){
            ctx.fillStyle = '#0f0';
            ctx.fillText(extra.msg, dx + 4, dy + dh - 4);
          }
        } else {
          ctx.fillText('SPACE 開啟魔法', dx + 4, dy + dh - 4);
        }
        ctx.font = '8px monospace';
      }
    } else if(gameMenu === 3){
      // Equipment — three-step picker: member → slot → item.
      const focus = (extra && extra.focus) || 'categories';
      const party = state.party || [];
      const mi = extra?.equipMember ?? 0;
      const slot = extra?.equipSlot || 'weapon';
      const itemSlotFn = extra?.itemSlot || (() => null);
      const member = party[mi] || null;
      const equipOf = (m, s) => (m && m.equipment && m.equipment[s]) || null;
      const nameOfEquip = (eq) => eq ? (eq.shopName || '#' + eq.id) : '(無)';

      let yLine = dy + 4;
      // Always show the active party member and both slots at the top so
      // the player sees what they're editing.
      ctx.fillStyle = '#ffe'; ctx.font = 'bold 8px monospace';
      ctx.fillText(member ? member.name : '?', dx + 4, yLine + 8);
      yLine += 12;
      ctx.font = '8px monospace';
      for(const s of ['weapon', 'armor']){
        const active = (focus === 'equip_slot' || focus === 'equip_pick') && slot === s;
        ctx.fillStyle = active ? '#ff0' : '#ccc';
        const label = s === 'weapon' ? '武器' : '防具';
        const eq = equipOf(member, s);
        ctx.fillText((active ? '▶ ' : '  ') + label + ': ' + nameOfEquip(eq), dx + 4, yLine + 8);
        yLine += 11;
      }
      yLine += 4;

      if(focus === 'equip_member'){
        ctx.fillStyle = '#aaa'; ctx.font = '7px monospace';
        ctx.fillText('選擇成員:', dx + 4, yLine + 6); yLine += 10;
        ctx.font = '8px monospace';
        for(let i = 0; i < party.length; i++){
          const pm = party[i];
          const sel = i === mi;
          ctx.fillStyle = sel ? '#ff0' : '#ccc';
          ctx.fillText((sel ? '▶ ' : '  ') + pm.name + ' Lv' + (pm.level || 1),
                       dx + 4, yLine + 8);
          yLine += 11;
        }
        ctx.fillStyle = '#aaa'; ctx.font = '7px monospace';
        ctx.fillText('↑↓ 選擇  SPACE 確定  ESC 返回', dx + 2, dy + dh - 4);
      } else if(focus === 'equip_pick'){
        // Inventory filtered by slot type.
        const matches = (inventory || [])
          .map((it, i) => ({it, i}))
          .filter(({it}) => itemSlotFn(it) === slot);
        ctx.fillStyle = '#aaa'; ctx.font = '7px monospace';
        ctx.fillText('選擇' + (slot === 'weapon' ? '武器' : '防具') + ':',
                     dx + 4, yLine + 6);
        yLine += 10;
        ctx.font = '8px monospace';
        if(matches.length === 0){
          ctx.fillStyle = '#888';
          ctx.fillText('(空)', dx + 4, yLine + 8);
        } else {
          const cursor = extra?.subIdx ?? 0;
          const startAt = Math.max(0, Math.min(cursor - 2, matches.length - 5));
          for(let k = 0; k < Math.min(5, matches.length - startAt); k++){
            const idx = startAt + k;
            const {it} = matches[idx];
            const sel = idx === cursor;
            const name = it.shopName || '#' + it.id;
            const glyphs = it.glyphs || nameOf(it.id, it.kind);
            ctx.fillStyle = sel ? '#ff0' : '#ccc';
            ctx.fillText(sel ? '▶' : ' ', dx + 2, yLine + 8);
            if(glyphs){
              const n = Math.min(4, glyphs.length / 30 | 0);
              for(let g = 0; g < n; g++){
                drawGlyph(glyphs.subarray(g*30, g*30 + 30), dx + 10 + g*14, yLine, sel ? '#ff0' : '#ccc');
              }
              ctx.fillText('x' + it.count, dx + 10 + n*14 + 2, yLine + 8);
            } else {
              ctx.fillText(name + ' x' + it.count, dx + 10, yLine + 8);
            }
            yLine += 11;
          }
        }
        ctx.fillStyle = '#aaa'; ctx.font = '7px monospace';
        ctx.fillText('↑↓ 選擇  SPACE 裝備  ESC 返回', dx + 2, dy + dh - 4);
      } else if(focus === 'equip_slot'){
        ctx.fillStyle = '#aaa'; ctx.font = '7px monospace';
        ctx.fillText('↑↓ 切換  SPACE 選物品  U 卸下  ESC 返回', dx + 2, dy + dh - 4);
      } else {
        // Not yet focused — show the hint.
        ctx.fillStyle = '#aaa'; ctx.font = '7px monospace';
        ctx.fillText('SPACE 開啟裝備', dx + 4, dy + dh - 4);
      }
      ctx.font = '8px monospace';
      if(extra && extra.msg){
        ctx.fillStyle = '#0f0'; ctx.font = '7px monospace';
        ctx.fillText(extra.msg, dx + 4, dy + dh - 14);
      }
    }
    ctx.textAlign = 'left';
  }

  function drawSlotPicker(picker, slots, areas){
    const mw = 260, mh = 160;
    const mx = (W - mw) / 2, my = (H - mh) / 2;
    // Dim anything behind the picker.
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#000';
    ctx.fillRect(mx, my, mw, mh);
    ctx.strokeStyle = '#ff0';
    ctx.lineWidth = 1;
    ctx.strokeRect(mx, my, mw, mh);
    ctx.fillStyle = '#ff0';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(picker.mode === 'save' ? 'SAVE TO SLOT' : 'LOAD SLOT', mx + mw / 2, my + 14);
    ctx.font = '9px monospace';
    ctx.textAlign = 'left';
    for(let i = 0; i < slots.length; i++){
      const meta = slots[i];
      const y = my + 28 + i * 20;
      ctx.fillStyle = (i === picker.index) ? '#ff0' : '#888';
      const pfx = (i === picker.index) ? '> ' : '  ';
      ctx.fillText(pfx + 'Slot ' + (i + 1), mx + 14, y + 10);
      if(meta){
        const mapName = areas[meta.area]?.map || meta.map || '?';
        const date = new Date(meta.time);
        const dateStr = date.toLocaleDateString() + ' ' + date.toTimeString().slice(0, 5);
        ctx.fillStyle = (i === picker.index) ? '#fff' : '#666';
        ctx.fillText(mapName + '  HP ' + meta.hp + '/' + meta.maxHp + '  $' + meta.gold, mx + 70, y + 10);
        ctx.fillStyle = (i === picker.index) ? '#aaa' : '#555';
        ctx.font = '7px monospace';
        ctx.fillText(dateStr, mx + 70, y + 17);
        ctx.font = '9px monospace';
      } else {
        ctx.fillStyle = (i === picker.index) ? '#888' : '#444';
        ctx.fillText('(empty)', mx + 70, y + 10);
      }
    }
    ctx.fillStyle = '#888';
    ctx.font = '7px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('↑↓ select  SPACE confirm  E export  I import  ESC cancel', mx + mw / 2, my + mh - 6);
    ctx.textAlign = 'left';
  }

  return {
    drawTile, tileIsForeground,
    renderScene, renderForeground,
    drawPlayer, drawNPCs, drawTreasures,
    drawHUD, drawGlyph, drawScriptPage,
    drawTitle, drawTransition, drawPickupMsg, drawGameMenu,
    drawSlotPicker,
  };
}
