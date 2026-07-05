// Shop + inn system, driven by the .15T shop opcodes.
//
// The original opens the trade UI from three dialog terminators
// (disasm 0x8B82/0x8BAC/0x8BD6):
//   FF01 → inn: param = advertised price. On "yes" the screen fades and
//          the whole party is fully healed (0x98DD → 0x244 fade →
//          0x9941 heal). The price is DISPLAY ONLY — no code path ever
//          deducts it from gold (verified against every write to
//          cs:0xb1d1), and we reproduce that quirk.
//   FF02 → item shop, FF03 → equipment shop: params = 10 stock item
//          ids (0x3E7 = empty). Prices come from the item table
//          (+0x10 dword); buy checks gold (0x9c04) and stack space
//          (99/stack, 82 slots — 0x15db); quantity picker 1..99 with
//          ±1/±10 steps (0x998F). Sell price = price >> 1 (0x9f95);
//          price-0 items are unsellable quest goods (0x9fb7).
//
// dialog.js calls openInn/openShop when an NPC's dialog ends in one of
// these opcodes — there is no NPC→shop mapping table in the game.

import {slotForItem, canEquip} from './items.js';

export function createShopSystem({state, itemTable, itemGlyphs, ui, stringTable}){
  let shop = null;   // active trade session

  function openShop(stock, kind, ST){
    shop = {
      type: kind,                    // 'items' | 'equip'
      stock: (stock || []).filter(id => itemTable[id]),
      mode: 'menu',
      menu: 0,                       // 0 = Buy, 1 = Sell, 2 = Leave
      listIdx: 0,
      qty: 1,                        // quantity-picker value
      msg: '',
      msgTimer: 0,
    };
    state.state = ST.SHOP;
    return true;
  }

  function openInn(price, ST){
    // yesNo = 0 (是) / 1 (否) — the 0x13A0 selector widget defaults to
    // "yes" and toggles with left/right.
    shop = {type: 'inn', price, mode: 'inn-prompt', yesNo: 0, msg: '', msgTimer: 0};
    state.state = ST.SHOP;
    return true;
  }

  function closeShop(ST){
    shop = null;
    state.state = ST.PLAY;
  }

  function inventoryRef(){
    return state._inventoryRef;   // set by main.js wire-up
  }

  function heldCount(id){
    const it = inventoryRef()?.find(i => i.id === id);
    return it ? (it.count || 1) : 0;
  }

  // Max purchasable quantity: gold / price, capped by stack space
  // (disasm 0x9c69 divide + 0x1665 held-count check, 99/stack).
  function maxBuyQty(id){
    const price = itemTable[id].price;
    const byGold = price > 0 ? Math.floor(state.gold / price) : 99;
    return Math.max(0, Math.min(byGold, 99 - heldCount(id)));
  }

  function commitBuy(id, qty){
    const inv = inventoryRef();
    if(!inv) return;
    state.gold -= itemTable[id].price * qty;
    const existing = inv.find(i => i.id === id);
    if(existing) existing.count += qty;
    else inv.push({id, count: qty});
    shop.msg = '多謝惠顧';
    shop.msgTimer = 800;
  }

  function commitSell(it, qty){
    const inv = inventoryRef();
    state.gold += (itemTable[it.id].price >> 1) * qty;
    it.count -= qty;
    if(it.count <= 0){
      inv.splice(inv.indexOf(it), 1);
      if(shop.listIdx >= inv.length) shop.listIdx = Math.max(0, inv.length - 1);
    }
    shop.msg = '多謝!';
    shop.msgTimer = 800;
    if(inv.length === 0) shop.mode = 'menu';
  }

  function innRest(ST){
    // Fade + full party heal (HP, MP, status). The advertised price is
    // never charged — original behavior.
    for(const m of state.party){ m.hp = m.maxHp; m.mp = m.maxMp; m.defending = 0; }
    shop.msg = 'HP/MP回復';
    shop.msgTimer = 1500;
    shop.mode = 'inn-done';
  }

  function adjustQty(pressedKey, max){
    if(pressedKey === 'ArrowUp')    shop.qty = Math.min(max, shop.qty + 1);
    if(pressedKey === 'ArrowDown')  shop.qty = Math.max(1, shop.qty - 1);
    if(pressedKey === 'ArrowRight') shop.qty = Math.min(max, shop.qty + 10);
    if(pressedKey === 'ArrowLeft')  shop.qty = Math.max(1, shop.qty - 10);
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
        if(shop.menu === 0){ shop.mode = 'buy'; shop.listIdx = 0; }
        else if(shop.menu === 1){
          if(!inv || inv.length === 0){ shop.msg = '物品無'; shop.msgTimer = 700; }
          else { shop.mode = 'sell'; shop.listIdx = 0; }
        }
        else closeShop(ST);
      }
      return;
    }

    if(shop.mode === 'buy'){
      const n = shop.stock.length;
      if(n === 0){ shop.mode = 'menu'; return; }
      if(pressedKey === 'ArrowUp')   shop.listIdx = (shop.listIdx + n - 1) % n;
      if(pressedKey === 'ArrowDown') shop.listIdx = (shop.listIdx + 1) % n;
      if(pressedKey === 'Escape')   { shop.mode = 'menu'; return; }
      if(pressedKey === 'Space' || pressedKey === 'Enter'){
        const id = shop.stock[shop.listIdx];
        if(state.gold < itemTable[id].price){
          shop.msg = '金錢不足'; shop.msgTimer = 800; return;
        }
        if(maxBuyQty(id) < 1){ shop.msg = '不能再拿'; shop.msgTimer = 800; return; }
        shop.qty = 1;
        shop.mode = 'buy-qty';
      }
      return;
    }

    if(shop.mode === 'buy-qty'){
      const id = shop.stock[shop.listIdx];
      adjustQty(pressedKey, maxBuyQty(id));
      if(pressedKey === 'Escape') shop.mode = 'buy';
      if(pressedKey === 'Space' || pressedKey === 'Enter'){
        commitBuy(id, shop.qty);
        shop.mode = 'buy';
      }
      return;
    }

    if(shop.mode === 'sell'){
      if(!inv || inv.length === 0){ shop.mode = 'menu'; return; }
      if(pressedKey === 'ArrowUp')   shop.listIdx = (shop.listIdx + inv.length - 1) % inv.length;
      if(pressedKey === 'ArrowDown') shop.listIdx = (shop.listIdx + 1) % inv.length;
      if(pressedKey === 'Escape')   { shop.mode = 'menu'; return; }
      if(pressedKey === 'Space' || pressedKey === 'Enter'){
        const it = inv[shop.listIdx];
        if(!itemTable[it.id] || itemTable[it.id].price === 0){
          shop.msg = '不能賣'; shop.msgTimer = 800; return;
        }
        shop.qty = 1;
        shop.mode = 'sell-qty';
      }
      return;
    }

    if(shop.mode === 'sell-qty'){
      const it = inv[shop.listIdx];
      if(!it){ shop.mode = 'sell'; return; }
      adjustQty(pressedKey, it.count || 1);
      if(pressedKey === 'Escape') shop.mode = 'sell';
      if(pressedKey === 'Space' || pressedKey === 'Enter'){
        commitSell(it, shop.qty);
        shop.mode = 'sell';
      }
      return;
    }

    if(shop.mode === 'inn-prompt'){
      // 是/否 selector (disasm 0x13A0): left/right toggle the choice,
      // confirm acts on the highlighted option, Esc = 否.
      if(pressedKey === 'ArrowLeft' || pressedKey === 'ArrowRight' ||
         pressedKey === 'ArrowUp' || pressedKey === 'ArrowDown'){
        shop.yesNo ^= 1;
      }
      if(pressedKey === 'Space' || pressedKey === 'Enter'){
        if(shop.yesNo === 0) innRest(ST);
        else closeShop(ST);
      }
      if(pressedKey === 'Escape') closeShop(ST);
      return;
    }
  }

  // Compare arrow vs the equipped piece in the same slot (equip-shop
  // party panel, disasm 0x7e80-0x80cd): weapon compares stat[0],
  // armor/shield/helmet stat[1], accessories stat[2]. Uses MG2.15
  // glyphs #0xC (better) / #0xD (worse) / #9 (equal) like the original.
  function compareEntry(id){
    const slot = slotForItem(id);
    if(!slot) return null;
    if(!canEquip(itemTable[id], 0)) return {entry: null, x: true};
    const key = slot === 'weapon' ? 0 : (slot === 'acc1' || slot === 'acc2') ? 2 : 1;
    const m = state.party[0];
    const cur = m.equipment[slot] ? itemTable[m.equipment[slot]].stats[key] : 0;
    const cand = itemTable[id].stats[key];
    return {entry: cand > cur ? 0x0C : cand < cur ? 0x0D : 0x09};
  }

  // Shop screen — authentic chrome (disasm 0x76D6 item / 0x793F equip):
  // stock window (5,3) 310×112, gold box (10,110) 120×25, 2-col grid,
  // hand cursor + red selection frame, prompt line in the dialog window.
  function drawGoldBox(){
    ui.drawWindow(10, 110, 120, 25);
    ui.drawString(0x13D, 18, 115, 0x2B);                    // 金錢
    ui.drawNum(state.gold, 60, 119, 1, {leftPack: true});
  }

  function draw(ctx, W, H){
    if(!shop) return;

    if(shop.type === 'inn'){
      if(shop.mode === 'inn-prompt'){
        ui.drawWindow(0, 140, W, 60);
        const x = ui.drawString(0x258, 10, 145, 1);         // 歡迎光臨…住宿一晚
        ui.drawNum(shop.price, x + 2, 145, 0x2B, {leftPack: true, font: 'big'});
        ui.drawString(0x259, 10, 165, 1);                   // 元。請問您要住宿嗎？
        // 是/否 selector — the highlighted option uses the fire gradient
        // (0x13A0: selected color 0xEF, unselected 1).
        ui.drawWindow(250, 125, 60, 25);
        ui.drawString(0x384, 258, 130, shop.yesNo === 0 ? 0xEF : 1);
        ui.drawString(0x385, 284, 130, shop.yesNo === 1 ? 0xEF : 1);
      } else {
        // inn-done: the original fades the palette to black while the
        // party sleeps (0x98DD → 0x244), then fades back in. Approximate
        // the sleep with a black overlay that peaks mid-way through the
        // rest timer.
        const t = Math.max(0, Math.min(1, 1 - shop.msgTimer / 1500));
        const alpha = Math.sin(t * Math.PI);
        ctx.fillStyle = 'rgba(0,0,0,' + alpha.toFixed(3) + ')';
        ctx.fillRect(0, 0, W, H);
      }
      return;
    }

    if(shop.mode === 'menu'){
      // Greeting in dialog window + 買/賣/離開 chooser.
      ui.drawWindow(0, 140, W, 60);
      ui.drawString(0x28A, 10, 145, 1);                     // 歡迎光臨！…
      ui.drawWindow(250, 120, 62, 40);
      const opts = [0x294, 0x295, 0x1FD];                   // 買 賣 (結束)
      for(let i = 0; i < 3; i++){
        ui.drawString(opts[i], 258, 125 + i * 11, i === shop.menu ? 0xEF : 1);
      }
      return;
    }

    const buying = shop.mode === 'buy' || shop.mode === 'buy-qty';
    const inv = inventoryRef() || [];
    const list = buying ? shop.stock : inv.map(it => it.id);

    // Stock/inventory window + gold box.
    ui.drawWindow(5, 3, 310, 112);
    drawGoldBox();

    // Prompt in the dialog window (0x29E buy / 0x2B2 sell).
    ui.drawWindow(0, 140, W, 60);
    ui.drawString(buying ? 0x29E : 0x2B2, 10, 145, 0xBA);
    if(shop.msg){
      ctx.fillStyle = ui.css(0xBA);
      ctx.font = '8px monospace';
      ctx.fillText(shop.msg, 10, 172);
    }

    // 2-column × 5-row grid. Cell origins from the LUT: x = 26/166.
    const first = Math.max(0, Math.min((shop.listIdx | 0) - 4, Math.max(0, list.length - 10)));
    for(let k = 0; k < Math.min(10, list.length - first); k++){
      const i = first + k;
      const id = list[i];
      const col = k % 2, row = (k / 2) | 0;
      const cx = 26 + col * 140, cy = 11 + row * 20;
      const sel = i === shop.listIdx;
      if(sel){ ui.drawSelBar(cx - 5, cy - 3, 130, 18); ui.drawHand(cx - 15, cy + 2); }
      const g = itemGlyphs(id);
      if(g) ui.drawGlyphs(g, cx + 8, cy + 6, sel ? 0xEF : 0x71);
      // Price (buy) or sell price (half).
      const rec = itemTable[id];
      const price = buying ? rec.price : (rec && rec.price ? rec.price >> 1 : 0);
      ui.drawNum(price, cx + 78, cy + 10, 0x2B, {leftPack: true});
      if(!buying) ui.drawNum(inv[i].count, cx + 108, cy + 10, 1, {cells: 2});
      if(buying && shop.type === 'equip'){
        const c = compareEntry(id);
        if(c && c.entry != null) ui.drawString(c.entry, cx + 120, cy, 0xEF);
      }
    }

    // Quantity picker overlay.
    if(shop.mode === 'buy-qty' || shop.mode === 'sell-qty'){
      const id = buying ? shop.stock[shop.listIdx] : inv[shop.listIdx]?.id;
      if(id != null){
        const unit = buying ? itemTable[id].price : (itemTable[id].price >> 1);
        ui.drawWindow(150, 120, 84, 24);
        ui.drawString(0x28F, 158, 124, 0x2B);               // 數量
        ui.drawNum(shop.qty, 200, 124, 1, {cells: 2, font: 'big'});
        let x = ui.drawString(0x299, 8, 148, 0x2B);         // 總共是
        x = ui.drawNum(unit * shop.qty, x + 2, 148, 1, {leftPack: true, font: 'big'});
        ui.drawString(0x3BB, x + 2, 148, 0x2B);             // 元
      }
    }
  }

  return {openShop, openInn, closeShop, tick, draw, getShop: () => shop};
}
