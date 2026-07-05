import {
  W, H, TW, TH, VCOLS, VROWS, MCOLS, MROWS,
  VOID, SMP_T, DOOR_T, DOOR_B, DIR_FRAMES,
} from './constants.js';

export function createRenderer(ctx, res){
  const {playerFrames, npcFrames, doorAtlas, doorCol, stringTable,
         itemTables = {}, tryByType = {}, itemTable = [], ui,
         portraits = [], balloonFrames = [], skullImg = null} = res;
  // Item-name lookup for entries without cached glyphs. P.15 at the raw
  // item id is the original's only item-name source (renderer 0xA21);
  // the kind cascade remains as a legacy fallback.
  function nameOf(id, kind){
    const p15 = itemTables.potion && itemTables.potion[id];
    if(p15) return p15;
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

  // The original has NO treasure sprite — a chest is a map tile baked
  // into the .MAP (opened chests are a tile rewrite, disasm 0x85DE), so
  // renderScene already draws it. This debug-only overlay marks pickup
  // spots when the ?triggers overlay is on.
  function drawTreasures(state, treasureData, debug){
    if(!debug) return;
    const list = treasureData[state.curArea];
    if(!list) return;
    for(const t of list){
      if(t.collected) continue;
      if(t.x < state.cX || t.x >= state.cX + VCOLS) continue;
      if(t.y < state.cY || t.y >= state.cY + VROWS) continue;
      const sx = (t.x - state.cX) * TW, sy = (t.y - state.cY) * TH;
      ctx.strokeStyle = '#ff0';
      ctx.strokeRect(sx + 0.5, sy + 0.5, TW - 1, TH - 1);
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

  // The original draws NO persistent overworld HUD (verified: frame
  // pipeline 0x33A9 is map + sprites only — no HP/gold/minimap). Stats
  // live in the ESC menu. This routine now only renders the debug
  // trigger/minimap overlay when ?triggers is active.
  function drawHUD(state, areas, npcData, treasureData, showTriggers){
    if(!showTriggers) return;
    drawTriggerOverlay(state, areas);
    ctx.fillStyle = '#0f0';
    ctx.font = '7px monospace';
    const mapName = areas[state.curArea] ? areas[state.curArea].map : '?';
    ctx.fillText(mapName + ' (' + state.pX + ',' + state.pY + ')  $' + state.gold +
                 '  HP ' + state.hp + '/' + state.maxHp, 4, 8);

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
    ctx.fillStyle = '#fff';
    ctx.fillRect(mmX + mmSize / 2 - 1, mmY + mmSize / 2 - 1, 2, 2);
  }

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

  // Dialog window (disasm 0x8536/0x8b8d): (0,140) 320x60 via the 0xB503
  // window primitive; 3 text lines at (10,145/162/179), 16-px glyph
  // advance, white gradient (base 1). Next-page marker = MG2.15 entry
  // 0x0F, fire color 0xEF, drawn right after the last glyph (no blink,
  // disasm 0x8afe).
  const DLG_LINES = [145, 162, 179];
  function drawScriptPage(page, speakerName, totalPages, pageIdx){
    ui.drawWindow(0, 140, W, 60);
    let lastX = 10, lastY = DLG_LINES[0];
    for(let row = 0; row < Math.min(3, page.length); row++){
      const line = page[row];
      let x = 10;
      const ly = DLG_LINES[row];
      for(let col = 0; col < Math.min(line.length, 18); col++){
        const cell = line[col];
        if(!cell.space) ui.drawGlyphs(cell.glyph, x, ly, 1);
        x += 16;
      }
      if(line.length){ lastX = x; lastY = ly; }
    }
    if(pageIdx < totalPages - 1){
      const marker = stringTable[0x0F];
      if(marker && lastX <= W - 18) ui.drawGlyphs(marker.subarray(0, 30), lastX, lastY, 0xEF);
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

  // Pickup / gold / empty message — the original draws these in the
  // standard dialog window at (0,140) 320×60 (disasm 0x8522/0x855B):
  // "得到了" = MG2.15 entry 0x2C8 (color 0x2B) at (10,145), then the item
  // name (P.15 glyphs, color 0xBB) or gold amount (color 0xBB) + "元"
  // (entry 0x3BB, color 0x2B). Empty chest = entry 0x2BC, color 1.
  function drawPickupMsg(msg){
    ui.drawWindow(0, 140, W, 60);
    if(typeof msg === 'string'){
      // Latin status strings (Saved / Exported / …) — not part of the
      // original UI; render as plain text in the window.
      ctx.fillStyle = ui.css(1);
      ctx.font = '9px monospace';
      ctx.fillText(msg, 10, 155);
      return;
    }
    if(msg.type === 'gold'){
      let x = ui.drawString(0x2C8, 10, 145, 0x2B);           // 得到了
      x = ui.drawNum(msg.amount, x + 4, 145, 0xBB, {leftPack: true, font: 'big'});
      ui.drawString(0x3BB, x + 2, 145, 0x2B);                // 元
    } else if(msg.type === 'item'){
      const x = ui.drawString(0x2C8, 10, 145, 0x2B);
      if(msg.glyphs) ui.drawGlyphs(msg.glyphs, x + 4, 145, 0xBB);
      else ui.drawNum(msg.id, x + 4, 145, 0xBB, {leftPack: true, font: 'big'});
    } else if(msg.type === 'empty'){
      ui.drawString(0x2BC, 10, 145, 1);
    }
  }

  // Helper: draw a string table entry's glyphs at (x, y) via the UI
  // gradient painter; returns width used. `base` defaults to white.
  function drawLabel(entryId, x, y, base = 1){
    return ui.drawString(entryId, x, y, base) - x;
  }

  // ── ESC menu (disasm 0x2e1c): a small window at (12,8) 100x70 with
  // the six category labels (MG2.15 entries 0-5: 物品 魔法 裝備 狀態
  // 進度 系統) in a 2x3 column-major grid at (25,15)/(25,35)/(25,55)
  // and (70,15)/(70,35)/(70,55). Selection = fire-gradient color swap
  // only (no cursor). Each category opens its own full window:
  // item/spell browser (0,0) 306x150 (0x3e6c), status (0,10) 320x185
  // (0x739b), equip 3-panel (0x6deb), 進度 chooser (40,60) 120x50
  // (0xa0b4), 系統 quit confirm (80,85) 170x60 (0x303c).
  const CAT_POS = [[25,15],[25,35],[25,55],[70,15],[70,35],[70,55]];

  function drawCategories(gameMenu){
    ui.drawWindow(12, 8, 100, 70);
    for(let i = 0; i < 6; i++){
      ui.drawString(i, CAT_POS[i][0], CAT_POS[i][1], i === gameMenu ? 0xEF : 1);
    }
  }

  // Shared browser chrome (0x4525): main window (0,0) 306x150 + bottom
  // message panel (0,149) 320x51; 7 rows x 2 cols from (30,8), column
  // stride 140, row stride 20; highlight bar 102x20 at x=26/166,
  // y=5+20*row with the hand at (barX-20, barY+5).
  function drawBrowser(rows, cursor, msg){
    ui.drawWindow(0, 0, 306, 150);
    ui.drawWindow(0, 149, W, 51);
    const first = Math.max(0, Math.min(cursor - 12, rows.length - 14));
    for(let k = 0; k < Math.min(14, rows.length - first); k++){
      const i = first + k;
      const col = k % 2, row = (k / 2) | 0;
      const x = 30 + col * 140, y = 8 + row * 20;
      if(i === cursor){
        ui.drawSelBar(26 + col * 140, 5 + row * 20);
        ui.drawHand(6 + col * 140, 10 + row * 20);
      }
      rows[i](x, y, i === cursor);
    }
    if(msg){
      ctx.fillStyle = ui.css(0xBA);
      ctx.font = '8px monospace';
      ctx.fillText(msg, 8, 162);
    }
  }

  function drawGameMenu(state, areas, inventory, gameMenu, magic, equipment, extra){
    const focus = (extra && extra.focus) || 'categories';
    const glyphsFor = extra?.itemGlyphs || ((id) => nameOf(id, 2));
    const msg = extra?.msg || '';

    if(focus === 'categories'){
      drawCategories(gameMenu);
      return;
    }

    if(focus === 'items'){
      const rows = inventory.map((it) => (x, y, sel) => {
        const g = it.glyphs || glyphsFor(it.id);
        const base = sel ? 0xEF : (it.id < 100 ? 0x71 : 0x78);
        if(g) ui.drawGlyphs(g, x, y, base);
        else ui.drawNum(it.id, x, y, base, {leftPack: true});
        ui.drawString(0x3B6, x + 64, y, 0x8D);               // ：
        ui.drawNum(it.count, x + 56, y + 5, 1, {cells: 5});
      });
      drawBrowser(rows, extra?.subIdx ?? 0, msg);
      return;
    }

    if(focus === 'magic'){
      const spells = state.spells || [];
      const rows = spells.map((sp) => (x, y, sel) => {
        const usable = sp.target === 'self' && sp.kind === 'heal';
        const base = sel ? 0xEF : (usable ? 0x71 : 0x78);
        const g = itemTables.magic && itemTables.magic[sp.id];
        if(g) ui.drawGlyphs(g, x, y, base);
        ui.drawString(0x3B6, x + 64, y, 0x8D);
        ui.drawNum(sp.mpCost, x + 56, y + 5, 1, {cells: 5});
      });
      drawBrowser(rows, extra?.subIdx ?? 0, msg);
      return;
    }

    if(focus === 'status'){
      // Full status screen (0x739b): window (0,10) 320x185, PBIG
      // portrait, 體力/魔力 + level + five stats + 經驗 + equipment.
      const mi = extra?.equipMember ?? 0;
      const m = (state.party || [])[mi] || state;
      ui.drawWindow(0, 10, 320, 185);
      const portrait = portraits[mi];
      if(portrait) ctx.drawImage(portrait, 0, 0);
      ui.drawString(0x12C, 10, 20, 0x2B);                    // 體力
      let x = ui.drawNum(m.hp, 40, 23, 1, {cells: 4});
      ui.drawString(0x11, 80, 26, 1);                        // ／
      ui.drawNum(m.maxHp, 96, 29, 0x64, {cells: 4});
      ui.drawString(0x12D, 10, 40, 0x2B);                    // 魔力
      ui.drawNum(m.mp, 40, 43, 1, {cells: 4});
      ui.drawString(0x11, 80, 46, 1);
      ui.drawNum(m.maxMp, 96, 49, 0x64, {cells: 4});
      ui.drawString(0x12E, 210, 20, 0x7F);                   // 等級
      ui.drawNum(m.level ?? 1, 242, 20, 0x48, {cells: 2, font: 'big'});
      const LBL = [0x131, 0x132, 0x133, 0x134, 0x135];
      const VAL = [m.atk, m.def, m.spd, m.mgAtk, m.mgDef];
      for(let s = 0; s < 5; s++){
        ui.drawString(LBL[s], 10, 60 + s * 20, 0x2B);
        ui.drawNum(VAL[s] ?? 0, 48, 63 + s * 20, 1, {cells: 5});
      }
      ui.drawString(0x13C, 10, 165, 0x2B);                   // 經驗
      ui.drawNum(m.exp ?? 0, 40, 168, 1, {cells: 8});
      ui.drawString(0x14 + mi, 132, 150, 0xB9);              // name
      // Equipped items (six slots) down the right side.
      const SLOTS = ['weapon','shield','helmet','armor','acc1','acc2'];
      for(let s = 0; s < 6; s++){
        const id = m.equipment ? m.equipment[SLOTS[s]] : 0;
        if(!id) continue;
        const g = glyphsFor(id);
        if(g) ui.drawGlyphs(g, 248, 50 + s * 20, 0x71);
      }
      // Adventure time (0x1E 冒險時間) bottom center.
      const secs = Math.floor((Date.now() - (state.playStart || Date.now())) / 1000);
      ui.drawString(0x1E, 128, 175, 0x2B);
      let tx = ui.drawNum(Math.floor(secs / 3600), 196, 178, 1, {cells: 2});
      tx = ui.drawString(0x13, tx + 2, 175, 1);
      tx = ui.drawNum(Math.floor(secs / 60) % 60, tx + 2, 178, 1, {cells: 2});
      tx = ui.drawString(0x13, tx + 2, 175, 1);
      ui.drawNum(secs % 60, tx + 2, 178, 1, {cells: 2});
      return;
    }

    if(focus === 'progress'){
      // 進度 chooser (0xa0b4): 儲存目前進度 (0x190) / 讀取以前進度 (0x191).
      drawCategories(gameMenu);
      ui.drawWindow(40, 60, 200, 50);
      ui.drawString(0x190, 50, 68, (extra?.subIdx ?? 0) === 0 ? 0xEF : 1);
      ui.drawString(0x191, 50, 88, (extra?.subIdx ?? 0) === 1 ? 0xEF : 1);
      return;
    }

    if(focus === 'system'){
      // Quit confirm (0x303c): 0x19A text + 是/否.
      drawCategories(gameMenu);
      ui.drawWindow(80, 85, 170, 60);
      ui.drawString(0x19A, 100, 93, 0xBC);
      ui.drawString(0x384, 130, 120, 0xEF);                  // 是 (confirm = Space)
      ui.drawString(0x385, 164, 120, 1);                     // 否 (ESC)
      return;
    }

    if(focus === 'equip_pick' || focus === 'equip_slot'){
      // Equip screen (0x6deb): stats panel (1,1) 156x73, slots panel
      // (8,75) 140x125, inventory panel (160,5) 141x190 with 9 rows.
      const SLOTS = ['weapon','shield','helmet','armor','acc1','acc2'];
      const mi = extra?.equipMember ?? 0;
      const slotIdx = extra?.equipSlotIdx ?? 0;
      const m = (state.party || [])[mi];
      ui.drawWindow(1, 1, 156, 73);
      ui.drawWindow(8, 75, 140, 125);
      ui.drawWindow(160, 5, 155, 190);
      // Stats panel: 攻/防/速/魔攻/魔防 (0xE6-0xEA), values grad 0x48.
      ui.drawString(0xE6, 10, 8, 1);  ui.drawNum(m?.atk ?? 0, 30, 12, 0x48, {cells: 3});
      ui.drawString(0xE7, 10, 28, 1); ui.drawNum(m?.def ?? 0, 30, 32, 0x48, {cells: 3});
      ui.drawString(0xE8, 10, 48, 1); ui.drawNum(m?.spd ?? 0, 30, 52, 0x48, {cells: 3});
      ui.drawString(0xE9, 76, 18, 1); ui.drawNum(m?.mgAtk ?? 0, 112, 22, 0x48, {cells: 3});
      ui.drawString(0xEA, 76, 38, 1); ui.drawNum(m?.mgDef ?? 0, 112, 42, 0x48, {cells: 3});
      // Slots panel: labels 0xDC-0xE1 + equipped names.
      for(let s = 0; s < 6; s++){
        const y = 80 + s * 20;
        const active = focus === 'equip_slot' && slotIdx === s;
        ui.drawString(0xDC + s, 15, y, active ? 0xEF : 1);
        const id = m ? m.equipment[SLOTS[s]] : 0;
        if(id){
          const g = glyphsFor(id);
          if(g) ui.drawGlyphs(g, 63, y, active ? 0xEF : 0x2B);
        }
      }
      // Inventory panel: 9 rows at (190, 13+20r); colors — consumables
      // grey 0x78, equippable-by-member 0x71, else 0xAC (0x4b7c-0x4ba1).
      const cursor = extra?.subIdx ?? 0;
      const canWear = extra?.canWear || (() => false);
      const first = Math.max(0, Math.min(cursor - 4, inventory.length - 9));
      for(let k = 0; k < Math.min(9, inventory.length - first); k++){
        const i = first + k;
        const it = inventory[i];
        const y = 13 + k * 20;
        const sel = focus === 'equip_pick' && i === cursor;
        if(sel){ ui.drawSelBar(187, 10 + k * 20); ui.drawHand(167, 15 + k * 20); }
        const base = sel ? 0xEF
          : it.id < 100 ? 0x78
          : canWear(it.id, mi) ? 0x71 : 0xAC;
        const g = it.glyphs || glyphsFor(it.id);
        if(g) ui.drawGlyphs(g, 190, y, base);
        ui.drawString(0x3B6, 254, y, 0x8D);
        ui.drawNum(it.count, 246, y + 5, 1, {cells: 5});
      }
      if(msg){
        ctx.fillStyle = ui.css(0xBA);
        ctx.font = '8px monospace';
        ctx.fillText(msg, 14, 196);
      }
      return;
    }
  }

  // Slot picker — save/load chooser window (disasm 0xa145 (140,40)
  // 120×110). Kept our 5-slot metadata (map/HP/gold/date) since our save
  // format is richer than the original's progress word.
  function drawSlotPicker(picker, slots, areas){
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, W, H);
    const mw = 240, mh = 150, mx = (W - mw) / 2, my = (H - mh) / 2;
    ui.drawWindow(mx, my, mw, mh);
    ui.drawString(picker.mode === 'save' ? 0x190 : 0x191, mx + 12, my + 8, 0x2B);
    for(let i = 0; i < slots.length; i++){
      const meta = slots[i];
      const y = my + 26 + i * 20;
      const sel = i === picker.index;
      if(sel) ui.drawHand(mx + 6, y + 1);
      ui.drawString(0x3D5 + i, mx + 24, y, sel ? 0xEF : 1);    // slot digit glyph
      if(meta){
        const mapName = areas[meta.area]?.map || meta.map || '?';
        ctx.fillStyle = ui.css(sel ? 0xEF : 1);
        ctx.font = '8px monospace';
        ctx.fillText(mapName, mx + 48, y + 8);
        ui.drawString(0x12E, mx + 96, y, 0x2B);                // 等級
        ui.drawNum(meta.hp ?? 0, mx + 136, y, 1, {cells: 4});
        ctx.fillStyle = ui.css(0x2B);
        ctx.font = '7px monospace';
        const date = new Date(meta.time);
        ctx.fillText(date.toLocaleDateString() + ' ' + date.toTimeString().slice(0,5), mx + 48, y + 16);
      } else {
        ui.drawString(0x2BC, mx + 48, y, 0x78);                // empty
      }
    }
    ctx.fillStyle = ui.css(0x2B);
    ctx.font = '7px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('SPACE / E export / I import / ESC', mx + mw/2, my + mh - 6);
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
