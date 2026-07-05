import {
  W, H, TW, TH, VCOLS, VROWS, MCOLS, MROWS, DT,
  DOOR_T, loadBin
} from './constants.js';
import {
  parsePal, parseSprites24, parseAreas, parseNPCs,
  parseTreasures, parseMG215, buildAtlas, decodePBM,
  parseEnemyTOS, parseEnemyDAT, parseSJN,
  parseATTEncounterPool, parseATTLevelTable, parseATS,
  parseItemTable, parseInitialState,
  parseColorLUTs, parseN15, parseRawSprite, parseRawImage, parseAMTOS, parseATTP,
} from './parsers.js';
import {EQUIP_SLOTS, recomputeStats, slotForItem, canEquip} from './items.js';
import {createUI} from './ui.js';
import {parseScript15T, runScript15T, runScript15Tat, lookupStride60, applyScriptOps} from './script.js';
import {saveToSlot, loadFromSlot, listSlots, hasSave, SAVE_SLOTS,
        exportSlotToFile, importFileToSlot} from './save.js';
import {createInput} from './input.js';
import {
  createCaches, loadArea, blocked, checkTrigger,
  findNearbyTrigger, checkScriptTrigger,
} from './area.js';
import {createRenderer} from './render.js';
import {createBattleSystem, SPELL_LIB} from './battle.js';
import {createShopSystem} from './shop.js';
import {createItemNameResolver} from './itemName.js';
import {createMenuSystem} from './menu.js';
import {createDialogSystem} from './dialog.js';
import {createNpcState} from './npcState.js';

async function boot(){
  const pE = document.getElementById('prog');
  const sE = document.getElementById('stat');
  const st = (m, p) => { sE.textContent = m; pE.style.width = p + '%'; };

  try {
    st('Palette...', 5);
    const pal = parsePal(await loadBin('D/VGAM.DAC'));

    st('Player sprites...', 15);
    const playerFrames = parseSprites24(await loadBin('D/PLAYER.TOS'), pal);

    st('NPC sprites...', 22);
    const npcFrames = parseSprites24(await loadBin('D/POL001.TOS'), pal);

    st('Enemy sprites...', 26);
    // ATT.LOD (the battle overlay) loads its own palette VGA.DAC + tint
    // tables COLOR.DAT, NOT the overworld's VGAM.DAC — so every battle
    // asset (enemies, hero poses, backdrops) must decode against palVGA.
    const palVGA = parsePal(await loadBin('D/VGA.DAC'));
    // ENEMY.TOS — the real battle-monster catalog, loaded by ATT.LOD
    // (CS:0xbc2a). ~265 variable-size frames.
    const enemyFrames = parseEnemyTOS(await loadBin('D/ENEMY.TOS'), palVGA);
    // Battle chrome: AM.TOS backdrops (id = AREA_ENEMY.enemy / the
    // cs:0xb1ed write), the SSLLP01 command panel, and ATTP hero poses.
    const battleBackdrop = parseAMTOS(await loadBin('D/AM.TOS'), palVGA);
    let battlePanel = null, attpFrames = null, killFrames = null;
    try { battlePanel = parseRawImage(await loadBin('D/SSLLP01.DAT'), palVGA, 320, 50); } catch {}
    try { attpFrames = parseATTP(await loadBin('D/ATTP.TOS'), palVGA); } catch {}

    st('Enemy stats...', 28);
    // ENEMY.DAT — 300 × 80-byte stat records, 1:1 with ENEMY.TOS sprite
    // indices. Loaded by ATT.LOD at CS:0xb767. Replaces our previous
    // hand-picked ENEMY_PROFILE guess.
    const enemyStats = parseEnemyDAT(await loadBin('S/ENEMY.DAT'));

    // ATT.LOD encounter pool + EXP threshold table, both baked into
    // ATT.LOD's data segment. Pool sits at DS:0x30de (file 0x111CE),
    // EXP table at DS:0x34c6 (file 0x115B6).
    const attBuf = await loadBin('ATT.LOD');
    const encounterPool = parseATTEncounterPool(attBuf);
    const levelExpTable = parseATTLevelTable(attBuf);
    // Per-outdoor-area biome byte map. Only areas 1-3 have ATS files
    // (SMAP01..SMAP03). Area 4's ATS is referenced by MG2.EXE but the
    // file doesn't exist on disk — fall back to an all-zero map so the
    // picker uses biome 0 (the weak default pool).
    const atsMap = {};
    for(const [aid, fname] of [[1, 'SMAP01.ATS'], [2, 'SMAP02.ATS'], [3, 'SMAP03.ATS']]){
      try { atsMap[aid] = parseATS(await loadBin('D/' + fname)); } catch {}
    }

    st('Item table...', 29);
    // MG2.EXE carries the item stat/price table and the compiled-in
    // new-game state (initial party, gold, inventory, spawn position).
    const exeBuf = await loadBin('MG2.EXE');
    const itemTable = parseItemTable(exeBuf);
    const initState = parseInitialState(exeBuf);

    st('Areas...', 30);
    const areas = parseAreas(await loadBin('S/INOUT.DAT'));

    st('NPCs...', 35);
    const npcData = parseNPCs(await loadBin('S/POL.DAT'));

    st('Treasures...', 40);
    const treasureData = parseTreasures(await loadBin('S/GEM.DAT'));

    st('Quest blockers...', 42);
    // SJN.DAT — per-area conditional NPC override table, MG2's complete
    // quest-blocker map (FF80 dispatcher / disasm 0x9101 → 0x9699). 46
    // areas, 139 conditions covering every gate guard step-aside, every
    // post-quest NPC hide, and the rare sprite-swap.
    const sjnTable = parseSJN(await loadBin('S/SJN.DAT'));

    st('String table...', 45);
    // The engine ships with several MG2.15-format string tables, each one a
    // different CATEGORY. The original swaps them into EMS pages on demand;
    // we keep all four resident and route by item kind:
    //   MG2.15 — UI labels (HP, MP, 物品, 魔法, 裝備 …) + character names
    //   M.15   — Magic spell names (e.g. 火魔法 = fire magic)
    //   ATT.15 — Attack / weapon / armour names
    //   P.15   — Player items / potions / herbs (consumables)
    const stringTable = parseMG215(await loadBin('D/MG2.15'));
    const tableMagic   = parseMG215(await loadBin('D/M.15'));
    const tableWeapon  = parseMG215(await loadBin('D/ATT.15'));
    const tablePotion  = parseMG215(await loadBin('D/P.15'));

    st('Door tiles...', 48);
    const doorAtlas = buildAtlas(await loadBin('D/SMAPDOOR.SMP'), pal, DOOR_T);
    let doorCol = null;
    try { doorCol = new Uint8Array(await loadBin('D/SMAPDOOR.BIT')); } catch {}
    // .HEI = real foreground/height attr (see comment in area.js getTileset).
    try { doorAtlas.attrs = new Uint8Array(await loadBin('D/SMAPDOOR.HEI')); }
    catch { doorAtlas.attrs = new Uint8Array(DOOR_T); }

    st('UI chrome...', 52);
    // Authentic UI assets (see ARCHITECTURE/render.md): COLORM remap
    // tables, the 8×8 digit font, the hand cursor, the dead-marker skull,
    // and the !/? cutscene balloons. All optional — the UI degrades to
    // flat colors if a file is missing.
    const colorLUTs = parseColorLUTs(await loadBin('D/COLORM.DAT'), pal);
    const n15 = parseN15(await loadBin('D/N15.T15'));
    const mipBuf = await loadBin('D/M_IP.DAT');
    const handFrames = [parseRawSprite(mipBuf, pal, 20, 15, 0),
                        parseRawSprite(mipBuf, pal, 20, 15, 1)];
    const skullImg = parseRawSprite(await loadBin('D/DUO.DAT'), pal, 15, 15, 0);
    const liveBuf = await loadBin('D/LIVE.DAT');
    const balloonFrames = [parseRawSprite(liveBuf, pal, 20, 18, 0),
                           parseRawSprite(liveBuf, pal, 20, 18, 1)];
    // Per-member status portraits (PBIG01-04), 0xFF transparent.
    const portraits = [];
    for(const p of ['PBIG01', 'PBIG02', 'PBIG03', 'PBIG04']){
      try { portraits.push(decodePBM(await loadBin('D/' + p + '.PBM'), pal, true)); }
      catch { portraits.push(null); }
    }

    st('Title image...', 58);
    const titleC = decodePBM(await loadBin('D/STAR01.PBM'), pal);
    const portraitC = portraits[0];
    const goC = decodePBM(await loadBin('D/GAMEOVER.PBM'), pal);

    const {getTileset, getScript} = createCaches(pal);

    st('Canvas...', 72);
    const offC = document.createElement('canvas');
    offC.width = W; offC.height = H;
    const ctx = offC.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    const disp = document.createElement('canvas');
    disp.style.imageRendering = 'pixelated';
    document.body.appendChild(disp);
    const resize = () => {
      const s = Math.max(1, Math.min(innerWidth/W, innerHeight/H));
      const si = Math.max(1, Math.floor(s));
      disp.width = W * si; disp.height = H * si;
      disp.style.width = (W * si) + 'px'; disp.style.height = (H * si) + 'px';
      disp.getContext('2d').imageSmoothingEnabled = false;
    };
    resize();
    addEventListener('resize', resize);

    const ST = {TITLE: 0, PLAY: 3, OVER: 4, TRANS: 5, MENU: 6, NPC_TALK: 7, BATTLE: 8, SLOT_PICKER: 9, SHOP: 10};

    // Fresh level-1 hero straight from the EXE's compiled-in new-game
    // image (parseInitialState): HP 37/37, MP 5/5, base stats
    // [45,38,29,30,28,24], weapon 100 + armor 240 + shoes 370 equipped.
    // Effective stats are recomputed (base + equipment) right after.
    function freshParty(){
      const m0 = initState.members[0];
      const m = {
        name:   '亞特斯',
        sprite: 0,
        level:  m0.level, exp: m0.exp,
        hp: m0.hp, maxHp: m0.maxHp,
        mp: m0.mp, maxMp: m0.maxMp,
        base: {...m0.base},
        equipment: {...m0.equipment},
        atk: 0, def: 0, spd: 0, mgAtk: 0, mgDef: 0,
        spells: [{...SPELL_LIB[0]}, {...SPELL_LIB[1]}],
        defending: 0,
      };
      recomputeStats(m, itemTable);
      return [m];
    }
    function freshInventory(){
      // Initial inventory image (2 × herb) with cached P.15 name glyphs.
      return initState.inventory.map(it => ({
        id: it.id, count: it.count, glyphs: tablePotion[it.id] || null,
      }));
    }

    const state = {
      ST,
      state: ST.TITLE,
      curArea: null, curAtlas: null, curCol: null,
      mapL1: null, mapL2: null,
      pX: initState.x, pY: initState.y, pdir: 1, walkTog: 0,
      cX: 0, cY: 0,
      gold: initState.gold,
      // `party` is the source of truth for hero combat stats. The
      // getter/setter aliases below bridge legacy `state.hp / .atk / …`
      // accessors to `party[0]` so shop / menu / save code keeps working.
      party: freshParty(),
      partySize: 1,        // cs:0xb174 mirror, set by FF50/FF55
      playStart: Date.now(),
      visitedAreas: new Set(),
    };
    // Legacy aliases — keep `state.hp` / `.atk` / … working so the menu,
    // shop, save code (and anything else using top-level stats) still
    // reads through to `party[0]`. When companions join, they're appended
    // to `state.party[]` and only battle.js needs to iterate.
    for(const k of ['level','exp','hp','maxHp','mp','maxMp','atk','def','spd',
                    'mgAtk','mgDef','spells','equipment']){
      Object.defineProperty(state, k, {
        get(){ return state.party[0][k]; },
        set(v){ state.party[0][k] = v; },
        enumerable: true, configurable: true,
      });
    }
    const inventory = [];
    inventory.push(...freshInventory());
    const firedScripts = new Set();
    const flags = {};          // script-set flags (FF20)
    const walkQueue = [];       // NPC walk queue (FF70)

    // Try-list per pickup type. Each .15 file holds a different CATEGORY of
    // names — using the wrong table gives wildly wrong results (M.15[0] is
    // "fire magic", P.15[0] is "herbs"). flag2_hi from GEM.DAT picks which
    // table to try first; the first hit with ≥ 2 glyphs wins, otherwise
    // first match (even short) is the fallback.
    const TRY_BY_TYPE = {
      basic:  [['potion', 'P.15'],  ['weapon', 'ATT.15'], ['misc', 'MG2.15'], ['magic',  'M.15']],
      equip:  [['weapon', 'ATT.15'], ['magic',  'M.15'],   ['potion', 'P.15'],  ['misc', 'MG2.15']],
      magic:  [['magic',  'M.15'],   ['potion', 'P.15'],   ['weapon', 'ATT.15'], ['misc', 'MG2.15']],
    };
    const TABLES = {magic: tableMagic, weapon: tableWeapon, potion: tablePotion, misc: stringTable};

    // Authentic UI toolkit — window chrome, glyph painter, digit fonts,
    // hand cursor. Shared by the renderer and shop.
    const ui = createUI(ctx, pal, {stringTable, colorLUTs, n15, handFrames});

    // Battle UI runs on ATT.LOD's palette (VGA.DAC) + string table
    // (ATT.15), so glyph gradients and window tints match the overlay.
    const attStrings = parseMG215(await loadBin('D/ATT.15'));
    const battleColorLUTs = parseColorLUTs(await loadBin('D/COLOR.DAT'), palVGA);
    const battleN15 = parseN15(await loadBin('D/N15.T15'));  // same font, VGA palette
    const battleHand = [parseRawSprite(mipBuf, palVGA, 20, 15, 0),
                        parseRawSprite(mipBuf, palVGA, 20, 15, 1)];
    const battleUI = createUI(ctx, palVGA, {stringTable: attStrings, colorLUTs: battleColorLUTs,
                                            n15: battleN15, handFrames: battleHand});

    const renderer = createRenderer(ctx, {
      playerFrames, npcFrames, doorAtlas, doorCol, stringTable, portraitC,
      itemTables: TABLES, tryByType: TRY_BY_TYPE, itemTable,
      ui, portraits, balloonFrames, skullImg,
    });

    // P.15 glyph lookup by raw item id — the original's only item-name
    // source (renderer 0xA21).
    const itemGlyphs = (id) => tablePotion[id] || null;

    const battle = createBattleSystem(state, areas, npcFrames, playerFrames, enemyFrames, enemyStats, encounterPool, atsMap, levelExpTable, itemTable, {
      ui: battleUI, backdrop: battleBackdrop, panel: battlePanel, attp: attpFrames,
      itemTables: {potion: tablePotion, magic: tableMagic},
    });
    battle.setInventory(inventory);

    // Shop / inn system, opened by dialog FF01/FF02/FF03 terminators.
    // Inventory is shared via state._inventoryRef so shop.js can mutate
    // it without an additional setter.
    state._inventoryRef = inventory;
    const shop = createShopSystem({state, itemTable, itemGlyphs, ui, stringTable});
    const input = createInput();

    // FF80 / SJN-F1 map tile stamp (disasm 0x97DE): writes a w×h block of
    // consecutive tileset indices into the live map; a nonzero .HEI attr
    // routes the tile to layer 2 (the fs+0xFBE segment in the original).
    function stampTiles({mapY, mapX, tileRow, tileCol, w, h}){
      if(!state.mapL1) return;
      const attrs = state.curAtlas?.attrs;
      for(let r = 0; r < h; r++){
        const rowBase = (mapY + r) * MCOLS + mapX;
        let ti = (tileRow + r) * 25 + tileCol;
        for(let c = 0; c < w; c++, ti++){
          const si = rowBase + c;
          if(si < 0 || si >= MCOLS * MROWS) continue;
          if(attrs && attrs[ti]) state.mapL2[si] = ti;
          else state.mapL1[si] = ti;
        }
      }
    }

    // FFB0 cutscene image (D/<name>.PBM), drawn behind the dialog box.
    const pbmCache = {};
    let dialogImage = null;
    function showImage(name){
      if(!name){ dialogImage = null; return; }
      if(name in pbmCache){ dialogImage = pbmCache[name]; return; }
      loadBin('D/' + name + '.PBM')
        .then(buf => { pbmCache[name] = decodePBM(buf, pal); dialogImage = pbmCache[name]; })
        .catch(() => { pbmCache[name] = null; });
    }

    // Mission-blocker hiding rules. The original game removes gate-keeper
    // NPCs once a quest flag is set — talking to a specific NPC fires FF20
    const {applySJN, reapplySJN, npcPos, npcHidden, wanderTick} = createNpcState({
      state, areas, npcData, flags, sjnTable, MCOLS, MROWS, stampTiles,
    });

    // Two flavours:
    //   load(aid)         — normal area transition: loads the map AND
    //                       replays SJN.DAT so blocker NPCs are positioned
    //                       correctly for the current flags. Used by
    //                       triggers, warps, and initial boot.
    //   loadMapOnly(aid)  — just the map/tileset/camera setup, no SJN
    //                       replay. Used by doLoad so we can restore
    //                       flags BEFORE applying SJN.
    async function loadMapOnly(areaId){
      return loadArea(areaId, state, areas, getTileset);
    }
    async function load(areaId){
      const r = await loadMapOnly(areaId);
      // Replay SJN.DAT on area entry — same point MG2.EXE rebuilds its
      // NPC table after a transition. Any quest flag already set will
      // immediately move/hide the matching NPCs.
      applySJN(areaId);
      // Preload the area's .15T script so the first script-trigger fire
      // is synchronous — otherwise the async fetch gap lets the player
      // walk past the trigger tile before FF70 pushback applies.
      const scriptName = npcData[areaId]?.script;
      if(scriptName) await getScript(scriptName);
      return r;
    }

    st('Loading D02...', 88);
    await load(5);
    st('Ready!', 100);

    const params = new URLSearchParams(location.search);
    const debugSkip = params.has('skip');
    const showTriggers = params.has('triggers');
    const DEBUG_SCRIPTS = params.has('debugScripts');
    const debugArea = params.get('area');
    const debugPX = params.get('x');
    const debugPY = params.get('y');
    const debugTalk = params.get('talk');
    if(debugArea){
      const aid = parseInt(debugArea);
      if(areas[aid]) await load(aid);
    }
    if(debugPX) state.pX = parseInt(debugPX);
    if(debugPY) state.pY = parseInt(debugPY);
    if(params.has('visited')){
      for(const sp of params.get('visited').split(',')){
        const n = parseInt(sp);
        if(!isNaN(n)) state.visitedAreas.add(n);
      }
    }
    if(debugSkip) state.state = ST.PLAY;

    function updateCam(){
      state.cX = Math.max(0, Math.min(state.pX - 13, MCOLS - VCOLS));
      state.cY = Math.max(0, Math.min(state.pY - 10, MROWS - VROWS));
    }
    // Expose the cam recompute on `state` so battle.js can snap the
    // camera when it teleports the player into / out of battle stance
    // without importing main.js's internals.
    state.updateCam = updateCam;
    updateCam();

    const scriptCtx = {
      get curArea(){ return state.curArea; },
      npcData,
      flags,
      state,
      partyState: 0,   // cs:0xb1d9 — party leader index; only Artes is playable
      pendingEnemy: 0,
      addGold: (v) => { state.gold += v; },
      queueWalk: (npcIdx, dir, steps) => walkQueue.push({npcIdx, dir, steps}),
      stampTiles,                                       // FF80 / SJN F1
      showImage,                                        // FFB0
      setPartySize: (n) => { state.partySize = n; },    // FF50 / FF55
      removeItem: (id) => {                             // FFD0
        const i = inventory.findIndex(it => it.id === id);
        if(i < 0) return;
        inventory[i].count = (inventory[i].count || 1) - 1;
        if(inventory[i].count <= 0) inventory.splice(i, 1);
      },
      healParty: () => {                                // FFF0
        for(const m of state.party){ m.hp = m.maxHp; m.mp = m.maxMp; }
      },
    };

    let titleMenu = 0, gameMenu = 0;
    // Menu focus: 'categories' | 'items' | 'magic' | 'equip_member' |
    // 'equip_slot' | 'equip_pick'. When focused on a sub-panel the player
    // can navigate/use items inside it.
    let menuFocus = 'categories';
    let menuSubIdx = 0;
    let equipMember = 0;           // which party member is being equipped
    let equipSlotIdx = 0;          // index into EQUIP_SLOTS (6 real slots)
    let menuMsg = '', menuMsgTimer = 0;
    let transitionMsg = '';
    let pickupMsg = '';
    let pickupMsgTimer = 0;
    // Dialog / cutscene state lives inside `dialog` (see below).
    let pendingTrigger = null;
    let slotPicker = {mode: 'load', index: 0, returnTo: ST.TITLE};

    function isBlocked(c, r){ return blocked(c, r, state, npcData, doorCol, npcHidden, npcPos); }

    // Extract all glyph bytes from a script page (for item-name resolution).
    // Returns a single Uint8Array concat of 30-byte glyphs, or null.
    const itemNames = createItemNameResolver({
      tryByType: TRY_BY_TYPE,
      tables: TABLES,
      getScript,
      getCurrentAreaScript: () => npcData[state.curArea]?.script || '',
    });
    const {pageToGlyphs, lookupItemTable, resolveItemName} = itemNames;

    // The tile (and the one to its right, since the player is 2 wide) directly
    // ahead of the player in their facing direction. Shared by the SPACE
    // handler for pickups, notice-board script triggers, and door entry.
    function facingTiles(){
      let dx = 0, dy = 0;
      if(state.pdir === 0) dy = -1;
      else if(state.pdir === 1) dy = 1;
      else if(state.pdir === 2) dx = -1;
      else if(state.pdir === 3) dx = 1;
      const tx = state.pX + dx, ty = state.pY + dy;
      return {tx, ty, dx, dy};
    }

    async function tryPickupTreasure(){
      const list = treasureData[state.curArea];
      if(!list) return false;
      const {dx, dy} = facingTiles();
      // Look 1 OR 2 tiles ahead so notice boards / fountains / signs whose
      // tile is solid (player can't step adjacent) are still reachable.
      // Same logic as `getFacingNPC` for shopkeepers behind counters.
      const candidates = [];
      for(let step = 1; step <= 2; step++){
        candidates.push({tx: state.pX + dx*step, ty: state.pY + dy*step});
      }
      for(const t of list){
        // GEM record dispatch (disasm 0x84B7 / 0x8514):
        //   flag2_hi == 0 → basic pickup, name = string-table[id]
        //   flag2_hi == 1 → gold, id = amount
        //   flag2_hi == 2 → SCRIPT TRIGGER (fountain / sign / statue) — runs
        //                   the stride-60 sub-entry [id] of the area's .15T
        //                   as a dialog. Re-fireable; nothing collected.
        const flag2_hi = (t.flag2 >> 8) & 0xFF;
        // Skip "collected" check for script triggers so they remain re-readable.
        if(flag2_hi !== 2 && t.collected) continue;
        let hit = false;
        for(const {tx, ty} of candidates){
          if(t.y !== ty) continue;
          if(t.x !== tx && t.x !== tx + 1) continue;
          hit = true; break;
        }
        if(!hit) continue;

        if(flag2_hi === 2){
          // Stride-60 dispatch script (fountain / notice board) —
          // display as dialog, no inventory pickup.
          const aScript = npcData[state.curArea]?.script || '';
          const scr = aScript ? await getScript(aScript) : null;
          const sub = scr ? lookupStride60(scr, t.id, flags) : null;
          if(sub && dialog.openResult(runScript15Tat(scr, sub.off, sub.size))) return true;
          pickupMsg = '...';
          pickupMsgTimer = 800;
          return true;
        }

        t.collected = true;
        if(flag2_hi === 1){
          state.gold += t.id;
          pickupMsg = {type: 'gold', amount: t.id};
        } else {
          // Resolve the name ONCE at pickup time and cache name + category on
          // the inventory entry so the menu can label/colorise it later.
          const r = await resolveItemName(t.id, 'basic');
          const glyphs = r ? r.glyphs : null;
          const source = r ? r.source : null;
          const existing = inventory.find(i => i.id === t.id);
          if(existing) existing.count++;
          else inventory.push({id: t.id, count: 1, glyphs, source, kind: flag2_hi});
          pickupMsg = {type: 'item', id: t.id, glyphs, source};
        }
        pickupMsgTimer = 2500;
        return true;
      }
      return false;
    }

    function getFacingNPC(){
      const aData = npcData[state.curArea];
      if(!aData) return null;
      // Walk 1 then 2 tiles in facing direction. Shopkeepers sit 2 tiles behind
      // a counter, and SPACE still needs to reach them without hijacking to
      // random nearby NPCs.
      const {dx, dy} = facingTiles();
      for(let step = 1; step <= 2; step++){
        const tx = state.pX + dx*step, ty = state.pY + dy*step;
        for(const n of aData.npcs){
          if(npcHidden(n)) continue;
          const p = npcPos(n);
          if((p.x === tx || p.x+1 === tx || p.x === tx+1) && p.y === ty) return n;
        }
      }
      return null;
    }

    // Script trigger one tile ahead — used by SPACE for notice boards and
    // other "interact with object" hotspots that aren't reachable via auto-fire.
    function getFacingScriptTrigger(){
      const a = areas[state.curArea];
      if(!a || !a.scripts) return null;
      const {tx, ty} = facingTiles();
      for(const s of a.scripts){
        if(s.sx === 0 || s.sy === 0) continue;
        if(s.sy !== ty) continue;
        if(s.sx !== tx && s.sx !== tx + 1) continue;
        const key = state.curArea + ':' + s.scriptId;
        if(firedScripts.has(key)) continue;
        return s;
      }
      return null;
    }

    // Specific (non-wildcard) door/portal trigger ahead — used by SPACE for
    // entering buildings. Wildcard triggers (edge wraps) auto-fire on walk.
    function getFacingTrigger(){
      const a = areas[state.curArea];
      if(!a) return null;
      const {dx, dy} = facingTiles();
      // Up to 2 tiles ahead so SPACE works whether the player is right at the
      // door or one back from a solid trigger tile.
      for(let step = 0; step <= 2; step++){
        const cx = state.pX + dx * step, cy = state.pY + dy * step;
        for(const t of a.triggers){
          if(t.sx === 0 || t.sy === 0) continue;
          if(t.sy !== cy) continue;
          if(t.sx !== cx && t.sx !== cx + 1) continue;
          return t;
        }
      }
      return null;
    }

    async function handleTransition(trig){
      state.state = ST.TRANS;
      const tgt = areas[trig.ta];
      if(!tgt){
        transitionMsg = 'Area ' + trig.ta + ' missing';
        await new Promise(r => setTimeout(r, 800));
        transitionMsg = ''; state.state = ST.PLAY; return;
      }
      transitionMsg = 'Entering ' + tgt.map + '...';
      const ok = await load(trig.ta);
      if(ok){
        state.pX = trig.tx; state.pY = trig.ty;
        if(isBlocked(state.pX, state.pY)){
          for(let d = 1; d < 10; d++){
            let found = false;
            for(let dr = -d; dr <= d && !found; dr++) for(let dc = -d; dc <= d && !found; dc++){
              if(Math.abs(dr) === d || Math.abs(dc) === d){
                if(!isBlocked(state.pX + dc, state.pY + dr)){ state.pX += dc; state.pY += dr; found = true; }
              }
            }
            if(found) break;
          }
        }
        updateCam();
      } else {
        transitionMsg = 'Failed to load ' + tgt.map;
        await new Promise(r => setTimeout(r, 800));
      }
      transitionMsg = ''; state.state = ST.PLAY;
    }

    const dialog = createDialogSystem({
      state, npcData, getScript, shop, ST, scriptCtx,
      onPageOpsApplied: () => reapplySJN(),
      onClose: () => { dialogImage = null; },
    });
    const runScript = dialog.runScript;
    const openNPCTalk = dialog.openNPCTalk;
    const applyPageOps = dialog.applyPageOps;

    // Script-trigger dispatch via MG2.EXE's stride-60 table (disasm 0x8840).
    // `scriptId` comes from an INOUT.DAT SCRIPT trigger (ta=0xF000, ty=id).
    // Sub-0 is a flag-check table; the resolved sub-entry may be null (flag
    // says "skip"), in which case the player walks through freely. We don't
    // latch via firedScripts — the flag table handles one-shot semantics.
    async function fireScriptTrigger(sTrig){
      // Freeze movement BEFORE the async gap — the tick loop is a fixed-
      // timestep accumulator that can fire multiple `tickLogic()` calls in
      // one RAF, and microtasks don't run between them. Without this, the
      // player walks a tile or two past the trigger before the dialog (or
      // FF70 pushback) can open.
      const priorState = state.state;
      state.state = ST.TRANS;
      const scriptName = npcData[state.curArea]?.script
        || (state.curArea === 5 ? 'TS001' : '');
      const scr = scriptName ? await getScript(scriptName) : null;
      const sub = scr ? lookupStride60(scr, sTrig.scriptId, flags) : null;
      if(DEBUG_SCRIPTS) console.log('[script]', state.curArea, 'id=' + sTrig.scriptId, 'at', state.pX + ',' + state.pY, '-> sub', sub);
      if(!sub){
        // No dispatch (flag says "skip" or script missing) — release the
        // freeze so normal play resumes.
        if(state.state === ST.TRANS) state.state = priorState;
        return;
      }
      const opened = dialog.openResult(runScript15Tat(scr, sub.off, sub.size));
      // openResult sets state = NPC_TALK on success. If it failed (empty
      // pages) revert to the prior state so play resumes.
      if(!opened && state.state === ST.TRANS) state.state = priorState;
    }

    // Menu actions (inventory / magic / equip). Delegated to menu.js.
    const menuActions = createMenuSystem({
      state, inventory, itemTable,
      msg: {set(text, ttl){ menuMsg = text; menuMsgTimer = ttl; }},
    });
    const {unequipSlot, equipFromInventory} = menuActions;
    function useItemFromMenu(idx){
      const r = menuActions.useItemFromMenu(idx);
      if(r.consumed){
        if(menuSubIdx >= inventory.length) menuSubIdx = Math.max(0, inventory.length - 1);
        if(r.empty) menuFocus = 'categories';
      }
    }
    const castSpellFromMenu = menuActions.castSpellFromMenu;


    if(debugTalk !== null){
      const npcIdx = parseInt(debugTalk);
      const aData = npcData[state.curArea];
      if(aData && aData.npcs[npcIdx]) openNPCTalk(aData.npcs[npcIdx]);
    }
    if(params.get('action') === 'enter'){
      const trig = findNearbyTrigger(state, areas);
      if(trig){
        pendingTrigger = trig;
        handleTransition(trig).then(() => { pendingTrigger = null; });
      }
    }
    if(params.has('encounter')){
      const tier = parseInt(params.get('encounter')) || 1;
      battle.startBattle(tier);
    }
    if(params.has('pickup')){
      // Debug ?pickup=N — same flow as the in-game tryPickupTreasure so the
      // resolved name + cached glyphs land on the inventory entry.
      const list = treasureData[state.curArea] || [];
      const idx = parseInt(params.get('pickup')) || 0;
      const t = list[idx];
      if(t){
        t.collected = true;
        const flag2_hi = (t.flag2 >> 8) & 0xFF;
        if(flag2_hi === 1){
          state.gold += t.id;
          pickupMsg = {type: 'gold', amount: t.id};
        } else {
          const kind = flag2_hi === 2 ? 'equip' : 'basic';
          const r = await resolveItemName(t.id, kind);
          let glyphs = r ? r.glyphs : null;
          let source = r ? r.source : null;
          if(!glyphs && flag2_hi === 2){ glyphs = stringTable[2]; source = 'weapon'; }
          inventory.push({id: t.id, count: 1, glyphs, source, kind: flag2_hi});
          pickupMsg = {type: 'item', id: t.id, glyphs, source};
        }
        pickupMsgTimer = 5000;
      }
    }

    document.getElementById('loading').style.display = 'none';

    let last = performance.now(), acc = 0, mAcc = 0, wanderAcc = 0;

    function tickLogic(){
      input.updateKeys();
      const {keys, pressed} = input;

      if(state.state === ST.TITLE){
        if(pressed.has('ArrowUp') || pressed.has('ArrowDown')) titleMenu = 1 - titleMenu;
        if(pressed.has('Space') || pressed.has('Enter')){
          if(titleMenu === 1 && hasSave()){
            openSlotPicker('load', ST.TITLE);
          } else {
            state.pX = initState.x; state.pY = initState.y; state.pdir = 1;
            firedScripts.clear();
            state.visitedAreas.clear();
            inventory.length = 0;
            inventory.push(...freshInventory());
            // Reset party + gold to the EXE's compiled-in new-game image.
            state.party = freshParty();
            state.gold = initState.gold;
            state.playStart = Date.now();
            (async () => {
              state.state = ST.TRANS;
              if(state.curArea !== 5) await load(5);
              updateCam();
              state.state = ST.PLAY;
              const ok = await runScript('TS001', 1, '', 0);
              if(!ok) await runScript('TS001', 0, '', 0);
            })().catch(e => {
              // ST.TRANS has no input exit — a rejection here would
              // soft-lock on a black screen, so fall back to the title.
              console.error('new game', e);
              state.state = ST.TITLE;
            });
          }
        }
      } else if(state.state === ST.PLAY){
        // NPC wander AI runs on the original's cadence: the AI counter
        // gate is 30 ticks at 72 Hz ≈ 417 ms (disasm 0x3771).
        wanderAcc += DT;
        if(wanderAcc >= 417){ wanderAcc = 0; wanderTick(); }
        mAcc += DT;
        if(mAcc >= 80){
          let dc = 0, dr = 0, moved = false;
          // Direction codes match disasm convention (0=UP, 1=DOWN, 2=LEFT, 3=RIGHT)
          // so the same values flow through DIR_FRAMES, NPC AI, and FF70.
          if(keys.has('ArrowUp')){ dr = -1; state.pdir = 0; moved = true; }
          else if(keys.has('ArrowDown')){ dr = 1; state.pdir = 1; moved = true; }
          else if(keys.has('ArrowLeft')){ dc = -1; state.pdir = 2; moved = true; }
          else if(keys.has('ArrowRight')){ dc = 1; state.pdir = 3; moved = true; }
          if(moved && !isBlocked(state.pX + dc, state.pY + dr)){
            state.pX += dc; state.pY += dr; state.walkTog ^= 1;
            // Treasure pickup is SPACE-only now (mg2.exe behaviour); no
            // auto-collect on walk-by.
            const trig = checkTrigger(state, areas);
            if(trig && !pendingTrigger){
              pendingTrigger = trig;
              handleTransition(trig).then(() => { pendingTrigger = null; }).catch(e => {
                // ST.TRANS has no input exit — recover instead of soft-locking.
                console.error('transition', e);
                pendingTrigger = null; transitionMsg = ''; state.state = ST.PLAY;
              });
            } else {
              const sTrig = checkScriptTrigger(state, areas, firedScripts);
              if(sTrig){
                // Do NOT record the trigger as "fired" yet — the stride-60
                // dispatcher may rewrite flags (FF20) or skip entirely when
                // the quest flag is set. Re-entering the tile after a state
                // change should re-dispatch.
                fireScriptTrigger(sTrig).catch(e => {
                  // ST.TRANS has no input exit — recover instead of soft-locking.
                  console.error('script trigger', e);
                  if(state.state === ST.TRANS) state.state = ST.PLAY;
                });
              } else {
                battle.tryEncounter();
              }
            }
          }
          mAcc = 0;
        }
        updateCam();
        if(pressed.has('Space') || pressed.has('Enter')){
          // Priority order: talk to NPC, read notice board / interact with
          // script object, open door, then pick up treasure. Each takes
          // precedence so the player isn't surprised by a wrong action.
          const npc = getFacingNPC();
          if(npc){
            openNPCTalk(npc);
          } else {
            const sTrig = getFacingScriptTrigger();
            if(sTrig){
              fireScriptTrigger(sTrig).catch(e => {
                // ST.TRANS has no input exit — recover instead of soft-locking.
                console.error('script trigger', e);
                if(state.state === ST.TRANS) state.state = ST.PLAY;
              });
            } else {
              const trig = getFacingTrigger();
              if(trig && !pendingTrigger){
                pendingTrigger = trig;
                handleTransition(trig).then(() => { pendingTrigger = null; }).catch(e => {
                  // ST.TRANS has no input exit — recover instead of soft-locking.
                  console.error('transition', e);
                  pendingTrigger = null; transitionMsg = ''; state.state = ST.PLAY;
                });
              } else {
                tryPickupTreasure().catch(e => console.error('pickup', e));
              }
            }
          }
        }
        if(pressed.has('Escape')){ state.state = ST.MENU; gameMenu = 0; }
      } else if(state.state === ST.NPC_TALK){
        if(pressed.has('Space') || pressed.has('Enter')){
          dialog.advance();
        }
        if(pressed.has('Escape')) dialog.close();
      } else if(state.state === ST.MENU){
        // ESC menu — the original's six categories in a 2x3 column-major
        // grid (disasm 0x2e1c): col 0 = 物品/魔法/裝備 (0-2), col 1 =
        // 狀態/進度/系統 (3-5). 進度 opens the save/load chooser (0xa0b4,
        // options MG2.15 0x190/0x191); 系統 asks to quit (0x303c).
        if(menuMsgTimer > 0) menuMsgTimer -= DT;
        if(menuFocus === 'categories'){
          const col = (gameMenu / 3) | 0, row = gameMenu % 3;
          if(pressed.has('ArrowUp'))    gameMenu = col * 3 + (row + 2) % 3;
          if(pressed.has('ArrowDown'))  gameMenu = col * 3 + (row + 1) % 3;
          if(pressed.has('ArrowLeft') || pressed.has('ArrowRight'))
            gameMenu = ((col ^ 1) * 3) + row;
          if(pressed.has('Escape')) state.state = ST.PLAY;
          if(pressed.has('Space') || pressed.has('Enter')){
            if(gameMenu === 0 && inventory.length > 0){
              menuFocus = 'items'; menuSubIdx = 0;
            } else if(gameMenu === 1 && state.spells.length > 0){
              menuFocus = 'magic'; menuSubIdx = 0;
            } else if(gameMenu === 2){
              // Equip — the original opens straight into the inventory
              // list (0x4c62); items route to their id-derived slot.
              equipMember = 0;
              equipSlotIdx = 0;
              menuSubIdx = 0;
              menuFocus = 'equip_pick';
            } else if(gameMenu === 3){
              menuFocus = 'status';
            } else if(gameMenu === 4){
              menuFocus = 'progress'; menuSubIdx = 0;
            } else if(gameMenu === 5){
              menuFocus = 'system';
            }
          }
        } else if(menuFocus === 'items'){
          if(pressed.has('ArrowUp')) menuSubIdx = (menuSubIdx + inventory.length - 1) % inventory.length;
          if(pressed.has('ArrowDown')) menuSubIdx = (menuSubIdx + 1) % inventory.length;
          if(pressed.has('Escape')){ menuFocus = 'categories'; menuMsg = ''; }
          if(pressed.has('Space') || pressed.has('Enter')){
            useItemFromMenu(menuSubIdx);
          }
        } else if(menuFocus === 'magic'){
          if(pressed.has('ArrowUp')) menuSubIdx = (menuSubIdx + state.spells.length - 1) % state.spells.length;
          if(pressed.has('ArrowDown')) menuSubIdx = (menuSubIdx + 1) % state.spells.length;
          if(pressed.has('Escape')){ menuFocus = 'categories'; menuMsg = ''; }
          if(pressed.has('Space') || pressed.has('Enter')){
            castSpellFromMenu(menuSubIdx);
          }
        } else if(menuFocus === 'status'){
          // Read-only screen; any confirm/cancel returns.
          if(pressed.has('Escape') || pressed.has('Space') || pressed.has('Enter')){
            menuFocus = 'categories';
          }
        } else if(menuFocus === 'progress'){
          // Save/load chooser (儲存目前進度 / 讀取以前進度).
          if(pressed.has('ArrowUp') || pressed.has('ArrowDown')) menuSubIdx ^= 1;
          if(pressed.has('Escape')){ menuFocus = 'categories'; }
          if(pressed.has('Space') || pressed.has('Enter')){
            menuFocus = 'categories';
            openSlotPicker(menuSubIdx === 0 ? 'save' : 'load', ST.MENU);
          }
        } else if(menuFocus === 'system'){
          // Quit confirm — yes returns to the title.
          if(pressed.has('Escape')){ menuFocus = 'categories'; }
          if(pressed.has('Space') || pressed.has('Enter')){
            menuFocus = 'categories';
            state.state = ST.TITLE;
          }
        } else if(menuFocus === 'equip_pick'){
          // Full inventory list (original 0x4b45); picking an item equips
          // it into its own slot (0x4f1b). U switches to unequip mode.
          if(inventory.length === 0){ menuFocus = 'categories'; return; }
          if(menuSubIdx >= inventory.length) menuSubIdx = inventory.length - 1;
          if(pressed.has('ArrowUp')) menuSubIdx = (menuSubIdx + inventory.length - 1) % inventory.length;
          if(pressed.has('ArrowDown')) menuSubIdx = (menuSubIdx + 1) % inventory.length;
          if(pressed.has('Escape')){ menuFocus = 'categories'; menuMsg = ''; }
          if(pressed.has('KeyU')){ menuFocus = 'equip_slot'; }
          if(pressed.has('Space') || pressed.has('Enter')){
            equipFromInventory(equipMember, menuSubIdx);
            if(menuSubIdx >= inventory.length) menuSubIdx = Math.max(0, inventory.length - 1);
          }
        } else if(menuFocus === 'equip_slot'){
          // Unequip mode: cursor over the six slots (0x515b).
          const N = EQUIP_SLOTS.length;
          if(pressed.has('ArrowUp'))   equipSlotIdx = (equipSlotIdx + N - 1) % N;
          if(pressed.has('ArrowDown')) equipSlotIdx = (equipSlotIdx + 1) % N;
          if(pressed.has('Escape')){ menuFocus = 'equip_pick'; menuMsg = ''; }
          if(pressed.has('Space') || pressed.has('Enter') || pressed.has('KeyU')){
            const ok = unequipSlot(equipMember, EQUIP_SLOTS[equipSlotIdx]);
            menuMsg = ok ? '已卸下' : '無裝備';
            menuMsgTimer = 800;
          }
        }
      } else if(state.state === ST.SLOT_PICKER){
        if(pressed.has('ArrowUp')) slotPicker.index = (slotPicker.index + SAVE_SLOTS - 1) % SAVE_SLOTS;
        if(pressed.has('ArrowDown')) slotPicker.index = (slotPicker.index + 1) % SAVE_SLOTS;
        if(pressed.has('Escape')) state.state = slotPicker.returnTo;
        if(pressed.has('Space') || pressed.has('Enter')) confirmSlotPicker();
        // E = export selected slot to a downloaded .json; I = import a .json
        // file and overwrite the selected slot in localStorage. Both work
        // regardless of save/load mode since they operate on the slot itself.
        if(pressed.has('KeyE')){
          const ok = exportSlotToFile(slotPicker.index);
          pickupMsg = ok ? ('Exported slot ' + (slotPicker.index + 1)) : 'Slot is empty';
          pickupMsgTimer = 1500;
        }
        if(pressed.has('KeyI')){
          importFileToSlot(slotPicker.index).then(res => {
            pickupMsg = res.ok
              ? ('Imported to slot ' + (slotPicker.index + 1))
              : ('Import failed: ' + (res.error || '?'));
            pickupMsgTimer = 1800;
          });
        }
      } else if(state.state === ST.BATTLE){
        // Battle is now multi-enemy with submenus, so it needs the full
        // arrow set + Escape (for "back" out of magic / item submenus).
        let k = '';
        if(pressed.has('ArrowUp')) k = 'ArrowUp';
        else if(pressed.has('ArrowDown')) k = 'ArrowDown';
        else if(pressed.has('ArrowLeft')) k = 'ArrowLeft';
        else if(pressed.has('ArrowRight')) k = 'ArrowRight';
        else if(pressed.has('Space')) k = 'Space';
        else if(pressed.has('Enter')) k = 'Enter';
        else if(pressed.has('Escape')) k = 'Escape';
        battle.battleTick(k);
      } else if(state.state === ST.SHOP){
        let k = '';
        if(pressed.has('ArrowUp')) k = 'ArrowUp';
        else if(pressed.has('ArrowDown')) k = 'ArrowDown';
        else if(pressed.has('ArrowLeft')) k = 'ArrowLeft';
        else if(pressed.has('ArrowRight')) k = 'ArrowRight';
        else if(pressed.has('Space')) k = 'Space';
        else if(pressed.has('Enter')) k = 'Enter';
        else if(pressed.has('Escape')) k = 'Escape';
        shop.tick(k, ST);
      } else if(state.state === ST.OVER){
        if(pressed.has('Space') || pressed.has('Enter')) state.state = ST.TITLE;
      }
    }

    function snapshotState(){
      const collectedByArea = {};
      for(const aid in treasureData){
        const taken = treasureData[aid].map(t => t.collected);
        if(taken.some(t => t)) collectedByArea[aid] = taken;
      }
      // Per-NPC mutable state — capture every field SJN.DAT or a script
      // could have changed. Compare against the cached POL.DAT defaults
      // (_origX/_origY/_origSprite/_origFlag etc — set in parseNPCs);
      // only NPCs that diverge get saved, to keep the blob small.
      const npcMutated = {};
      for(const aid in npcData){
        const list = npcData[aid].npcs;
        for(const n of list){
          const changed = (n.x !== n._origX) || (n.y !== n._origY)
                       || (n.sprite !== n._origSprite) || (n.flag !== n._origFlag)
                       || (n.x2 !== n._origX2) || (n.y2 !== n._origY2)
                       || n.hidden || n.spawned;
          if(changed){
            npcMutated[aid + ':' + n.rawIdx] = {
              x: n.x, y: n.y, x2: n.x2, y2: n.y2,
              sprite: n.sprite, flag: n.flag,
              hidden: !!n.hidden, spawned: !!n.spawned,
            };
          }
        }
      }
      // Inventory entries hold raw glyph Uint8Arrays for fast rendering.
      // JSON serializes those as `{0: byte, 1: byte, ...}` objects which we
      // can't reconstruct on load — strip them here and re-resolve from
      // P.15 when the save is restored.
      const inventorySer = inventory.map(it => ({id: it.id, count: it.count}));
      return {
        area: state.curArea,
        map: areas[state.curArea]?.map || '',
        pX: state.pX, pY: state.pY, pdir: state.pdir,
        gold: state.gold,
        playStart: state.playStart,
        // Serialize each party member; spells stored as id-only and
        // re-hydrated from SPELL_LIB on load. Base stats + equipment
        // item ids are the persistent truth — effective stats are
        // recomputed on load (0x6fbb semantics).
        party: state.party.map(m => ({
          name: m.name, sprite: m.sprite,
          level: m.level, exp: m.exp,
          hp: m.hp, maxHp: m.maxHp, mp: m.mp, maxMp: m.maxMp,
          base: {...m.base},
          equipment: {...m.equipment},
          spells: (m.spells || []).map(s => ({id: s.id})),
        })),
        inventory: inventorySer,
        collected: collectedByArea,
        visited: [...state.visitedAreas],
        flags,
        npcs: npcMutated,
      };
    }

    function doSave(slot){
      return saveToSlot(slot, snapshotState());
    }

    // doLoad — restore a save. Order matters because the SJN dispatcher
    // is flag-driven AND we also want per-NPC script mutations (FF60 from
    // a cutscene that landed someone outside SJN's rules) to survive the
    // round-trip. Sequence:
    //
    //   1. Reset EVERY NPC in every area back to POL.DAT defaults (so a
    //      downward time-travel to an earlier save wipes out "extra"
    //      mutations from a later playthrough still in memory).
    //   2. Restore flags / inventory / party / treasures / visited set.
    //   3. loadMapOnly(s.area) — brings tile atlas + camera online.
    //   4. applySJN(s.area) — with the correct flags now in place.
    //   5. Overlay s.npcs deltas — catches non-SJN mutations AND (harmlessly)
    //      re-asserts SJN positions in case the blob captured them too.
    async function doLoad(slot){
      const s = loadFromSlot(slot);
      if(!s) return false;
      // (1) Reset every NPC — wipe ALL mutable fields back to POL.DAT
      // defaults (x, y, x2, y2, sprite, flag/direction, hidden, spawned).
      // Anything SJN or a script can write must be reset here so a
      // backwards-time-travel reload doesn't leak forward state from
      // the previous playthrough still in memory.
      for(const aid in npcData){
        for(const n of npcData[aid].npcs){
          n.x = n._origX; n.y = n._origY;
          n.x2 = n._origX2; n.y2 = n._origY2;
          n.sprite = n._origSprite; n.flag = n._origFlag;
          n.hidden = false; n.spawned = false;
        }
      }
      // (2) Restore flags FIRST so applySJN sees the right state.
      if(s.flags){
        for(const k in flags) delete flags[k];
        Object.assign(flags, s.flags);
      }
      state.visitedAreas.clear();
      if(Array.isArray(s.visited)) for(const a of s.visited) state.visitedAreas.add(a);
      // (3) Map-only load, no SJN yet.
      await loadMapOnly(s.area);
      state.pX = s.pX; state.pY = s.pY; state.pdir = s.pdir || 0;
      state.gold = s.gold ?? 50;
      state.playStart = s.playStart ?? Date.now();
      // Rebuild party from saved blob. Members carry base stats +
      // equipment ids; effective stats are recomputed (0x6fbb). Legacy
      // saves (flat stats, object-shaped equipment with hand-authored
      // shop ids) predate the real item table — their stats become the
      // base and their equipment is dropped as unmappable.
      const hydrate = (m) => {
        const member = {
          name: m.name ?? '亞特斯', sprite: m.sprite ?? 0,
          level: m.level ?? 1, exp: m.exp ?? 0,
          hp: m.hp ?? 37, maxHp: m.maxHp ?? 37,
          mp: m.mp ?? 5, maxMp: m.maxMp ?? 5,
          base: m.base ? {...m.base} : {
            atk: m.atk ?? 45, def: m.def ?? 38, spd: m.spd ?? 29,
            mgAtk: m.mgAtk ?? 30, mgDef: m.mgDef ?? 28, x6: 24,
          },
          equipment: (m.base && m.equipment)
            ? {...m.equipment}
            : {weapon: 0, shield: 0, helmet: 0, armor: 0, acc1: 0, acc2: 0},
          atk: 0, def: 0, spd: 0, mgAtk: 0, mgDef: 0,
          spells: (m.spells || []).map(sp => SPELL_LIB[sp.id] ? {...SPELL_LIB[sp.id]} : null).filter(Boolean),
          defending: 0,
        };
        recomputeStats(member, itemTable);
        return member;
      };
      state.party = (Array.isArray(s.party) && s.party.length)
        ? s.party.map(hydrate)
        : [hydrate(s)];
      inventory.length = 0;
      if(s.inventory){
        for(const it of s.inventory){
          inventory.push({
            id: it.id,
            count: it.count || 1,
            glyphs: itemGlyphs(it.id),
          });
        }
      }
      if(s.collected){
        for(const aid in s.collected){
          if(treasureData[aid]){
            const taken = s.collected[aid];
            for(let i = 0; i < taken.length && i < treasureData[aid].length; i++){
              treasureData[aid][i].collected = taken[i];
            }
          }
        }
      }
      // (4) SJN replay with restored flags. Moves every blocker NPC
      // into position for the current quest state.
      applySJN(s.area);
      // (5) Overlay the saved NPC deltas. The snapshot captures every
      // NPC whose (x, y, hidden, spawned) differs from POL.DAT, which
      // INCLUDES the SJN-driven positions — so most of this loop rewrites
      // the same values applySJN just wrote (idempotent). The important
      // case is NPCs moved by cutscene FF60 / FF65 that SJN doesn't
      // cover — those only make it back via this overlay.
      if(s.npcs){
        for(const key in s.npcs){
          const [aidStr, idxStr] = key.split(':');
          const aid = +aidStr, idx = +idxStr;
          const list = npcData[aid]?.npcs;
          if(!list) continue;
          const n = list.find(x => x.rawIdx === idx);
          if(!n) continue;
          const v = s.npcs[key];
          if(v.x      != null) n.x = v.x;
          if(v.y      != null) n.y = v.y;
          if(v.x2     != null) n.x2 = v.x2;
          if(v.y2     != null) n.y2 = v.y2;
          if(v.sprite != null) n.sprite = v.sprite;
          if(v.flag   != null) n.flag = v.flag;
          n.hidden  = !!v.hidden;
          n.spawned = !!v.spawned;
        }
      }
      updateCam();
      return true;
    }

    function openSlotPicker(mode, returnTo){
      slotPicker.mode = mode;
      slotPicker.index = 0;
      slotPicker.returnTo = returnTo;
      state.state = ST.SLOT_PICKER;
    }

    async function confirmSlotPicker(){
      const {mode, index, returnTo} = slotPicker;
      if(mode === 'save'){
        const ok = doSave(index);
        pickupMsg = ok ? ('Saved to slot ' + (index + 1)) : 'Save failed';
        pickupMsgTimer = 1500;
        state.state = returnTo;
      } else { // load
        const slots = listSlots();
        if(!slots[index]){
          pickupMsg = 'Empty slot'; pickupMsgTimer = 1200;
          return;
        }
        state.state = ST.TRANS;
        let ok = false;
        try{ ok = await doLoad(index); }
        catch(e){
          // ST.TRANS has no input exit — a corrupt/imported save that
          // rejects mid-load must land back on the picker's caller.
          console.error('load', e);
        }
        state.state = ok ? ST.PLAY : returnTo;
      }
    }

    let lastTickErr = '';
    function tick(now){
      try{
        tickFrame(now);
      }catch(e){
        // A data-dependent throw must cost one frame, not the whole game:
        // rescheduling lives outside the try so the RAF chain survives.
        // Dedup so a persistent error doesn't flood the console.
        if(String(e) !== lastTickErr){ lastTickErr = String(e); console.error('tick', e); }
      }
      requestAnimationFrame(tick);
    }

    function tickFrame(now){
      let dt = now - last; last = now;
      if(dt > 200) dt = 200;
      acc += dt;
      while(acc >= DT){
        tickLogic();
        acc -= DT;
      }

      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);

      if(state.state === ST.TITLE){
        renderer.drawTitle(titleC, titleMenu, hasSave());
      } else if(state.state === ST.PLAY || state.state === ST.MENU){
        renderer.renderScene(state);
        renderer.drawTreasures(state, treasureData, showTriggers);
        renderer.drawNPCs(state, npcData, npcHidden, npcPos);
        renderer.drawPlayer(state);
        renderer.renderForeground(state);
        renderer.drawHUD(state, areas, npcData, treasureData, showTriggers);
        if(pickupMsg && pickupMsgTimer > 0){
          pickupMsgTimer -= dt;
          renderer.drawPickupMsg(pickupMsg);
          if(pickupMsgTimer <= 0) pickupMsg = '';
        }
        if(state.state === ST.MENU) renderer.drawGameMenu(
          state, areas, inventory, gameMenu, state.magic, state.equipment,
          {focus: menuFocus, subIdx: menuSubIdx, msg: menuMsgTimer > 0 ? menuMsg : '',
           equipMember, equipSlotIdx, itemGlyphs,
           canWear: (id, mi) => canEquip(itemTable[id], mi)}
        );
      } else if(state.state === ST.NPC_TALK){
        renderer.renderScene(state);
        renderer.drawTreasures(state, treasureData, showTriggers);
        renderer.drawNPCs(state, npcData, npcHidden, npcPos);
        renderer.drawPlayer(state);
        renderer.renderForeground(state);
        // FFB0 cutscene image covers the scene until the dialog closes.
        if(dialogImage) ctx.drawImage(dialogImage, 0, 0);
        if(dialog.pages.length > 0 && dialog.pageIdx < dialog.pages.length){
          renderer.drawScriptPage(dialog.pages[dialog.pageIdx], dialog.currentNPCName, dialog.pages.length, dialog.pageIdx);
        }
      } else if(state.state === ST.TRANS){
        renderer.drawTransition(transitionMsg);
      } else if(state.state === ST.SLOT_PICKER){
        // Draw the underlying screen dimmed, then the picker on top.
        if(slotPicker.returnTo === ST.TITLE){
          renderer.drawTitle(titleC, titleMenu, hasSave());
        } else {
          renderer.renderScene(state);
          renderer.drawNPCs(state, npcData, npcHidden, npcPos);
          renderer.drawPlayer(state);
          renderer.renderForeground(state);
        }
        renderer.drawSlotPicker(slotPicker, listSlots(), areas);
      } else if(state.state === ST.BATTLE){
        // MG2 battles run on a DEDICATED screen (ATT.LOD): AM.TOS
        // backdrop (rows 0-149) + SSLLP01 command panel (rows 150-199),
        // enemy formation, hero poses, status. Not the overworld map.
        battle.drawScreen(ctx);
      } else if(state.state === ST.SHOP){
        // Render the shop interior scene + overlay shop UI on top.
        renderer.renderScene(state);
        renderer.drawNPCs(state, npcData, npcHidden, npcPos);
        renderer.drawPlayer(state);
        renderer.renderForeground(state);
        shop.draw(ctx, W, H);
      } else if(state.state === ST.OVER){
        ctx.drawImage(goC, 0, 0);
      }

      disp.getContext('2d').drawImage(offC, 0, 0, disp.width, disp.height);
    }

    requestAnimationFrame(tick);
  } catch(e){
    console.error(e);
    sE.textContent = 'Error: ' + e.message;
    sE.style.color = '#f44';
  }
}

boot();
