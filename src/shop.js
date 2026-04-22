// Shop + inn system.
//
// A shop is a specific NPC whose dialog is replaced by a buy/sell UI. The
// original game's shop dialog fires a special opcode that opens the trading
// screen (shop1.png / shop2.png reference). Until that opcode is decoded we
// use a data table keyed by `(area:rawIdx)` with the shopkeeper's stock.
//
// An "inn" shopkeeper restores HP/MP for a fixed gold cost — shopkeeper
// asks, player accepts, gold deducts, screen briefly fades, stats refill.
//
// Adding a new shop: pick the NPC's area + raw POL.DAT index, add a line
// to SHOP_BY_NPC below with its type + items.

// Catalog of sellable goods. `id` is arbitrary (unique per item); `stat`
// describes the stat delta if EQUIPPED. Consumables set `source: 'potion'`
// or `'magic'` — battle.js `itemEffect()` reads that to decide the heal.
//
// Keep shop item ids ≥ 200 so they don't collide with GEM.DAT treasure ids.
// Items are grouped by tier: basic (200s), mid (230s), advanced (260s),
// legendary (290s). Each village stocks the tier that matches its story
// position (see SHOP_BY_NPC below).
export const SHOP_ITEMS = {
  // ── Weapons ───────────────────────────────────────────
  200: {name: '木棍',    price: 10,  kind: 'weapon', atk: 2},
  201: {name: '小刀',    price: 25,  kind: 'weapon', atk: 3},
  202: {name: '銅劍',    price: 30,  kind: 'weapon', atk: 5},
  230: {name: '鐵劍',    price: 120, kind: 'weapon', atk: 12},
  231: {name: '戰斧',    price: 180, kind: 'weapon', atk: 16},
  232: {name: '長矛',    price: 150, kind: 'weapon', atk: 14, spd: 2},
  260: {name: '鋼劍',    price: 300, kind: 'weapon', atk: 20},
  261: {name: '雙刃劍',  price: 450, kind: 'weapon', atk: 24, spd: 1},
  262: {name: '銀劍',    price: 500, kind: 'weapon', atk: 22, mgAtk: 4},
  290: {name: '魔法劍',  price: 800, kind: 'weapon', atk: 32, mgAtk: 6},
  291: {name: '聖劍',    price: 1500,kind: 'weapon', atk: 45, mgAtk: 10},
  // ── Armor / shields / helms ──────────────────────────
  210: {name: '布衣',    price: 22,  kind: 'armor',  def: 2},
  211: {name: '皮甲',    price: 75,  kind: 'armor',  def: 4},
  212: {name: '皮盾',    price: 130, kind: 'armor',  def: 7},
  240: {name: '鐵甲',    price: 260, kind: 'armor',  def: 12},
  241: {name: '銀盾',    price: 340, kind: 'armor',  def: 10, mgDef: 3},
  242: {name: '鐵帽',    price: 180, kind: 'armor',  def: 6},
  270: {name: '鋼甲',    price: 520, kind: 'armor',  def: 18},
  271: {name: '鋼盾',    price: 600, kind: 'armor',  def: 14, mgDef: 5},
  280: {name: '龍鱗甲',  price: 1200,kind: 'armor',  def: 28, mgDef: 8},
  // ── Accessories ───────────────────────────────────────
  214: {name: '皮帽子',  price: 150, kind: 'armor',  def: 5},
  215: {name: '髮圈',    price: 210, kind: 'armor',  spd: 3},
  250: {name: '銀戒指',  price: 400, kind: 'armor',  mgDef: 4, spd: 2},
  251: {name: '力手環',  price: 350, kind: 'armor',  atk: 3, def: 2},
  285: {name: '神秘護符',price: 900, kind: 'armor',  mgAtk: 6, mgDef: 6},
  // ── Consumables ───────────────────────────────────────
  // Low tier
  220: {name: '藥草',    price: 15,  kind: 'potion', source: 'potion'},
  221: {name: '魔水',    price: 30,  kind: 'magic',  source: 'magic'},
  222: {name: '解毒藥',  price: 20,  kind: 'potion', source: 'potion'},
  // Mid tier
  225: {name: '大藥草',  price: 50,  kind: 'potion', source: 'potion'},
  226: {name: '大魔水',  price: 90,  kind: 'magic',  source: 'magic'},
  // High tier
  228: {name: '神仙水',  price: 200, kind: 'potion', source: 'potion'},
  229: {name: '回生丹',  price: 300, kind: 'potion', source: 'potion'},
};

// Stock presets keyed by TIER — reused across villages so a shop's stock
// scales with where in the story you find it.
const STOCK = {
  // Tier 1 — spawn-town villages (C02-1 etc.)
  weapons1: [200, 201, 202, 230, 210, 211, 214],
  items1:   [220, 221, 222],
  inn1:     8,
  // Tier 2 — mid-game villages (C03-1 / C04-1 etc.)
  weapons2: [230, 231, 232, 211, 212, 242, 214, 215],
  items2:   [220, 225, 226, 222],
  inn2:     20,
  // Tier 3 — late villages / fortress towns (C07-1 etc.)
  weapons3: [260, 261, 262, 240, 241, 251, 215, 250],
  items3:   [225, 226, 228, 229, 222],
  inn3:     50,
  // Tier 4 — final / hidden shops
  weapons4: [290, 291, 270, 271, 280, 285, 250, 251],
  items4:   [228, 229, 226, 225],
  inn4:     120,
};

// Shop ↔ NPC mapping. Each entry hides the NPC's normal dialog and opens
// the trade UI instead. `type: 'weapons' | 'items' | 'inn'`. The shopkeeper
// is the specific NPC at its raw POL.DAT position; the player stands
// 1–2 tiles away and presses SPACE (our `getFacingNPC` reaches over the
// counter).
//
// Multiple areas share the same map filename (`C02-1` / `C03-1` / etc.) —
// they're separate buildings reusing the same tileset, so each has its own
// shop entry and stock.
export const SHOP_BY_NPC = {
  // ── C02-1 (area 107) — the first proper village ─────────────────────
  '107:0': {type: 'weapons', sells: STOCK.weapons1},   // (20, 7) weapon/armor
  '107:1': {type: 'items',   sells: STOCK.items1},     // (57, 10) pharmacist
  '107:2': {type: 'inn',     cost:  STOCK.inn1},       // (30, 39) innkeeper

  // ── C02-1 (area 108) — sister village, same tier ────────────────────
  '108:1': {type: 'weapons', sells: STOCK.weapons1},   // (58, 10) weapons
  '108:3': {type: 'items',   sells: STOCK.items1},     // (54, 15) items
  '108:5': {type: 'inn',     cost:  STOCK.inn1},       // (129, 74) inn

  // ── C02-1 (area 110) — tier 2 stock (further town) ──────────────────
  '110:1': {type: 'weapons', sells: STOCK.weapons2},   // (57, 10)
  '110:3': {type: 'items',   sells: STOCK.items2},     // (137, 60)
  '110:5': {type: 'inn',     cost:  STOCK.inn2},       // (69, 78)

  // ── C03-1 (area 109) — tier 2 equipment ─────────────────────────────
  '109:2': {type: 'weapons', sells: STOCK.weapons2},   // (20, 7)
  '109:3': {type: 'items',   sells: STOCK.items2},     // (148,106)

  // ── C03-1 (area 113) — tier 2/3 ─────────────────────────────────────
  '113:0': {type: 'weapons', sells: STOCK.weapons2},   // (69, 56)
  '113:4': {type: 'items',   sells: STOCK.items2},     // (146,109)
  '113:7': {type: 'inn',     cost:  STOCK.inn2},       // (29, 49)

  // ── C07-1 (area 112) — tier 3 fortress town ─────────────────────────
  '112:0': {type: 'weapons', sells: STOCK.weapons3},   // (88, 14)
  '112:4': {type: 'items',   sells: STOCK.items3},     // (160,14)
  '112:1': {type: 'inn',     cost:  STOCK.inn3},       // (20,109)

  // ── C09-1 (area 115) — late-game ────────────────────────────────────
  '115:1': {type: 'weapons', sells: STOCK.weapons3},   // (57, 10)
  '115:3': {type: 'items',   sells: STOCK.items3},     // (17, 39)
  '115:6': {type: 'inn',     cost:  STOCK.inn3},       // (64,108)

  // ── C11-1 (area 117) — late-game ────────────────────────────────────
  '117:0': {type: 'weapons', sells: STOCK.weapons3},   // (69, 56)
  '117:5': {type: 'items',   sells: STOCK.items3},     // (83, 57)

  // ── C12-1 (area 118) — hidden / final shop ──────────────────────────
  '118:0': {type: 'weapons', sells: STOCK.weapons4},   // (184, 61)
};

export function createShopSystem(state, areas, stringTable, itemTables){
  // ST constants are passed in at wire-up time from main.js.
  let shop = null;   // active trade session

  // Opens a shop for NPC (or null if NPC isn't a shopkeeper).
  function tryOpenShop(areaId, npcRawIdx, ST){
    const key = areaId + ':' + npcRawIdx;
    const def = SHOP_BY_NPC[key];
    if(!def) return false;
    shop = {
      def,
      type: def.type,
      mode: def.type === 'inn' ? 'inn-prompt' : 'menu',
      menu: 0,           // 0 = Buy, 1 = Sell, 2 = Leave
      listIdx: 0,        // cursor in buy/sell list
      listScroll: 0,
      confirm: false,    // awaiting yes/no on a purchase
      msg: '',
      msgTimer: 0,
    };
    state.state = ST.SHOP;
    return true;
  }

  function closeShop(ST){
    shop = null;
    state.state = ST.PLAY;
  }

  function getBuyList(){
    return (shop.def.sells || []).map(id => ({id, def: SHOP_ITEMS[id]})).filter(x => x.def);
  }

  function inventoryRef(){
    return state._inventoryRef;   // set by main.js wire-up
  }

  function sellPriceFor(item){
    // Half of book price (rounded) — classic JRPG buyback.
    const def = SHOP_ITEMS[item.id];
    const base = def?.price ?? 10;
    return Math.max(1, Math.floor(base / 2));
  }

  function confirmBuy(ST){
    const list = getBuyList();
    const entry = list[shop.listIdx];
    if(!entry) return;
    const {def} = entry;
    if(state.gold < def.price){
      shop.msg = '金錢不足'; shop.msgTimer = 800; return;
    }
    state.gold -= def.price;
    const inv = inventoryRef();
    if(!inv) return;
    // Inventory entry uses the same shape as GEM pickups so the menu and
    // battle item code don't need special cases.
    const existing = inv.find(i => i.id === entry.id);
    if(existing) existing.count++;
    else inv.push({
      id:     entry.id,
      count:  1,
      kind:   def.kind,
      source: def.source || def.kind,
      glyphs: null,       // shop items have names only, no MG2.15 glyphs
      shopName: def.name,
    });
    shop.msg = '購入 ' + def.name;
    shop.msgTimer = 800;
  }

  function confirmSell(ST){
    const inv = inventoryRef();
    if(!inv) return;
    const it = inv[shop.listIdx];
    if(!it){ shop.mode = 'menu'; return; }
    const price = sellPriceFor(it);
    state.gold += price;
    it.count = (it.count || 1) - 1;
    if(it.count <= 0) inv.splice(shop.listIdx, 1);
    if(shop.listIdx >= inv.length) shop.listIdx = Math.max(0, inv.length - 1);
    shop.msg = '+' + price + 'G';
    shop.msgTimer = 800;
    if(inv.length === 0){ shop.mode = 'menu'; }
  }

  function innRest(ST){
    if(state.gold < shop.def.cost){
      shop.msg = '金錢不足'; shop.msgTimer = 800;
      shop.mode = 'inn-prompt'; return;
    }
    state.gold -= shop.def.cost;
    state.hp = state.maxHp;
    state.mp = state.maxMp;
    shop.msg = 'HP/MP回復';
    shop.msgTimer = 1500;
    shop.mode = 'inn-done';
  }

  function tick(pressedKey, ST){
    if(!shop) return;
    if(shop.msgTimer > 0){
      shop.msgTimer -= 16;  // coarse but matches DT-ish
      if(shop.msgTimer > 0) return;
      if(shop.mode === 'inn-done'){ closeShop(ST); return; }
    }
    if(!pressedKey) return;

    const inv = inventoryRef();

    if(shop.mode === 'menu'){
      if(pressedKey === 'ArrowUp')   shop.menu = (shop.menu + 2) % 3;
      if(pressedKey === 'ArrowDown') shop.menu = (shop.menu + 1) % 3;
      if(pressedKey === 'Escape'){ closeShop(ST); return; }
      if(pressedKey === 'Space' || pressedKey === 'Enter'){
        if(shop.menu === 0){ shop.mode = 'buy';  shop.listIdx = 0; shop.listScroll = 0; }
        else if(shop.menu === 1){
          if(!inv || inv.length === 0){ shop.msg = '物品無'; shop.msgTimer = 700; }
          else { shop.mode = 'sell'; shop.listIdx = 0; shop.listScroll = 0; }
        }
        else closeShop(ST);
      }
      return;
    }

    if(shop.mode === 'buy'){
      const list = getBuyList();
      if(pressedKey === 'ArrowUp')   shop.listIdx = (shop.listIdx + list.length - 1) % list.length;
      if(pressedKey === 'ArrowDown') shop.listIdx = (shop.listIdx + 1) % list.length;
      if(pressedKey === 'Escape')   { shop.mode = 'menu'; return; }
      if(pressedKey === 'Space' || pressedKey === 'Enter') confirmBuy(ST);
      return;
    }

    if(shop.mode === 'sell'){
      if(!inv || inv.length === 0){ shop.mode = 'menu'; return; }
      if(pressedKey === 'ArrowUp')   shop.listIdx = (shop.listIdx + inv.length - 1) % inv.length;
      if(pressedKey === 'ArrowDown') shop.listIdx = (shop.listIdx + 1) % inv.length;
      if(pressedKey === 'Escape')   { shop.mode = 'menu'; return; }
      if(pressedKey === 'Space' || pressedKey === 'Enter') confirmSell(ST);
      return;
    }

    if(shop.mode === 'inn-prompt'){
      // Yes/No via Space (yes) / Escape (no).
      if(pressedKey === 'Space' || pressedKey === 'Enter') innRest(ST);
      if(pressedKey === 'Escape') closeShop(ST);
      return;
    }
  }

  function draw(ctx, W, H){
    if(!shop) return;
    const boxY = H - 88, boxH = 88;

    // Background panel — parchment/wood look.
    ctx.fillStyle = '#2a1810';
    ctx.fillRect(0, boxY, W, boxH);
    ctx.fillStyle = '#5a3520';
    ctx.fillRect(2, boxY + 2, W - 4, boxH - 4);
    ctx.strokeStyle = '#1a0a05';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, boxY + 0.5, W - 1, boxH - 1);

    ctx.fillStyle = '#ffe';
    ctx.font = '8px monospace';

    if(shop.type === 'inn' && (shop.mode === 'inn-prompt' || shop.mode === 'inn-done')){
      ctx.fillText('歡迎光臨客棧！', 8, boxY + 16);
      ctx.fillText('住宿一晚 ' + shop.def.cost + ' G。', 8, boxY + 32);
      ctx.fillText('HP/MP 全回復', 8, boxY + 46);
      ctx.fillStyle = '#ff0';
      ctx.fillText('SPACE 住宿   ESC 離開', 8, boxY + 74);
      ctx.fillStyle = '#fff';
      ctx.fillText('持有: ' + state.gold + ' G', W - 110, boxY + 16);
      if(shop.msg){
        ctx.fillStyle = '#0f0';
        ctx.fillText(shop.msg, 8, boxY + 60);
      }
      return;
    }

    if(shop.mode === 'menu'){
      ctx.fillText('歡迎光臨！', 8, boxY + 14);
      ctx.fillText('請選擇服務：', 8, boxY + 28);
      const opts = ['買', '賣', '離開'];
      for(let i = 0; i < opts.length; i++){
        ctx.fillStyle = i === shop.menu ? '#ff0' : '#ddc';
        ctx.fillText((i === shop.menu ? '▶ ' : '  ') + opts[i], 16, boxY + 46 + i * 11);
      }
      ctx.fillStyle = '#fff';
      ctx.fillText('持有: ' + state.gold + ' G', W - 110, boxY + 14);
      if(shop.msg){
        ctx.fillStyle = '#ff0';
        ctx.fillText(shop.msg, W - 110, boxY + 28);
      }
      return;
    }

    if(shop.mode === 'buy'){
      const list = getBuyList();
      ctx.fillStyle = '#ff0';
      ctx.fillText('買什麼？', 8, boxY + 12);
      ctx.fillStyle = '#fff';
      ctx.fillText(state.gold + ' G', W - 50, boxY + 12);
      // Two-column grid — up to 8 items.
      const visible = list.slice(0, 8);
      for(let i = 0; i < visible.length; i++){
        const {def} = visible[i];
        const col = i % 2, row = Math.floor(i / 2);
        const cx = 8 + col * 150, cy = boxY + 22 + row * 12;
        ctx.fillStyle = i === shop.listIdx ? '#ff0' : '#ccc';
        ctx.fillText((i === shop.listIdx ? '▶ ' : '  ') + def.name, cx, cy);
        ctx.fillStyle = i === shop.listIdx ? '#ff0' : '#9a7';
        ctx.fillText(String(def.price).padStart(3) + 'G', cx + 90, cy);
      }
      // Selected-item stat preview.
      const sel = list[shop.listIdx];
      if(sel){
        const d = sel.def;
        const parts = [];
        if(d.atk) parts.push('ATK +' + d.atk);
        if(d.def) parts.push('DEF +' + d.def);
        if(d.spd) parts.push('SPD +' + d.spd);
        if(d.kind === 'potion') parts.push('HP 回復');
        if(d.kind === 'magic')  parts.push('MP 回復');
        ctx.fillStyle = '#8f8';
        ctx.fillText(parts.join('   ') || d.kind, 8, boxY + boxH - 6);
      }
      ctx.fillStyle = '#aaa';
      ctx.font = '7px monospace';
      ctx.fillText('SPACE 購買   ESC 返回', W - 140, boxY + boxH - 6);
      ctx.font = '8px monospace';
      if(shop.msg){
        ctx.fillStyle = '#0f0';
        ctx.fillText(shop.msg, W - 120, boxY + 24);
      }
      return;
    }

    if(shop.mode === 'sell'){
      const inv = inventoryRef() || [];
      ctx.fillStyle = '#ff0';
      ctx.fillText('賣什麼？', 8, boxY + 12);
      ctx.fillStyle = '#fff';
      ctx.fillText(state.gold + ' G', W - 50, boxY + 12);
      const visible = inv.slice(0, 8);
      for(let i = 0; i < visible.length; i++){
        const it = visible[i];
        const col = i % 2, row = Math.floor(i / 2);
        const cx = 8 + col * 150, cy = boxY + 22 + row * 12;
        ctx.fillStyle = i === shop.listIdx ? '#ff0' : '#ccc';
        const name = it.shopName || SHOP_ITEMS[it.id]?.name ||
                     (stringTable?.[it.id] ? '#' + it.id : '?');
        ctx.fillText((i === shop.listIdx ? '▶ ' : '  ') +
          name.substr(0, 8) + ' x' + it.count, cx, cy);
        ctx.fillStyle = i === shop.listIdx ? '#ff0' : '#9a7';
        ctx.fillText(sellPriceFor(it) + 'G', cx + 110, cy);
      }
      ctx.fillStyle = '#aaa';
      ctx.font = '7px monospace';
      ctx.fillText('SPACE 出售   ESC 返回', W - 140, boxY + boxH - 6);
      ctx.font = '8px monospace';
      if(shop.msg){
        ctx.fillStyle = '#0f0';
        ctx.fillText(shop.msg, W - 120, boxY + 24);
      }
    }
  }

  return {tryOpenShop, closeShop, tick, draw, getShop: () => shop};
}
