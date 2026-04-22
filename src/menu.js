// ESC-menu logic for inventory, spells, and equipment.
//
// Equipping MOVES an item from inventory into `member.equipment[slot]`
// and applies the stat delta immediately. Unequipping / swapping puts
// the previous piece back. The shop's Sell list iterates `inventory`,
// so it naturally can't show currently-equipped gear — the player must
// take it off before selling.

import {SHOP_ITEMS} from './shop.js';

export function createMenuSystem({state, inventory, msg}){
  // `msg` is a setter object: { set(text, ttlMs) } so the caller owns
  // the on-screen message timer.

  function useItemFromMenu(idx){
    const it = inventory[idx];
    if(!it) return {consumed: false};
    if(it.source === 'potion'){
      if(state.hp >= state.maxHp){ msg.set('HP 已滿', 700); return {consumed: false}; }
      const heal = Math.min(state.maxHp - state.hp, 25);
      state.hp += heal;
      msg.set('+' + heal + ' HP', 900);
    } else if(it.source === 'magic'){
      if(state.mp >= state.maxMp){ msg.set('MP 已滿', 700); return {consumed: false}; }
      const r = Math.min(state.maxMp - state.mp, 10);
      state.mp += r;
      msg.set('+' + r + ' MP', 900);
    } else if(it.source === 'weapon' || it.source === 'armor'){
      msg.set('從裝備使用', 800);
      return {consumed: false};
    } else {
      msg.set('使用不能', 700);
      return {consumed: false};
    }
    it.count = (it.count || 1) - 1;
    if(it.count <= 0){ inventory.splice(idx, 1); return {consumed: true, empty: inventory.length === 0}; }
    return {consumed: true, empty: false};
  }

  function castSpellFromMenu(idx){
    const sp = state.spells[idx];
    if(!sp){ return; }
    // Only self-target heals are usable outside battle.
    if(sp.target !== 'self' || sp.kind !== 'heal'){ msg.set('戰鬥中使用', 800); return; }
    if(state.mp < sp.mpCost){ msg.set('MP 不足', 700); return; }
    if(state.hp >= state.maxHp){ msg.set('HP 已滿', 700); return; }
    state.mp -= sp.mpCost;
    const heal = Math.min(state.maxHp - state.hp, sp.power);
    state.hp += heal;
    msg.set(sp.name + ' +' + heal + ' HP', 900);
  }

  // Which equipment slot an inventory item fits. Shop-bought gear uses
  // a string kind ('weapon' / 'armor'); `.15T` pickups arrive with
  // kind === 2 (flag2_hi=2) and are routed by the source table
  // (ATT.15 → weapon, others → armor/accessory).
  function itemSlot(it){
    if(!it) return null;
    if(it.kind === 'weapon') return 'weapon';
    if(it.kind === 'armor')  return 'armor';
    if(it.kind === 2) return it.source === 'weapon' ? 'weapon' : 'armor';
    return null;
  }

  // Stat bonuses when equipped. Shop items pull from SHOP_ITEMS; .15T
  // pickups have no numeric stats in the game data so we give a token
  // bonus so the piece still matters.
  function itemStats(it){
    if(!it) return {atk: 0, def: 0, spd: 0, mgAtk: 0, mgDef: 0};
    const def = SHOP_ITEMS[it.id];
    if(def){
      return {
        atk: def.atk || 0, def: def.def || 0, spd: def.spd || 0,
        mgAtk: def.mgAtk || 0, mgDef: def.mgDef || 0,
      };
    }
    if(it.kind === 2){
      return it.source === 'weapon'
        ? {atk: 3, def: 0, spd: 0, mgAtk: 0, mgDef: 0}
        : {atk: 0, def: 3, spd: 0, mgAtk: 0, mgDef: 0};
    }
    return {atk: 0, def: 0, spd: 0, mgAtk: 0, mgDef: 0};
  }

  function applyStats(m, s, sign){
    m.atk   += sign * s.atk;
    m.def   += sign * s.def;
    m.spd   += sign * s.spd;
    m.mgAtk += sign * s.mgAtk;
    m.mgDef += sign * s.mgDef;
  }

  function unequipSlot(memberIdx, slot){
    const m = state.party[memberIdx];
    const old = m.equipment[slot];
    if(!old) return false;
    applyStats(m, itemStats(old), -1);
    const existing = inventory.find(i => i.id === old.id);
    if(existing) existing.count = (existing.count || 1) + 1;
    else inventory.push({...old, count: 1});
    m.equipment[slot] = null;
    return true;
  }

  function equipFromInventory(memberIdx, slot, invIdx){
    const m = state.party[memberIdx];
    const it = inventory[invIdx];
    if(!it) return false;
    if(itemSlot(it) !== slot){ msg.set('無法裝備', 800); return false; }
    const taken = {id: it.id, count: 1, kind: it.kind, source: it.source,
                   shopName: it.shopName, glyphs: it.glyphs};
    it.count = (it.count || 1) - 1;
    if(it.count <= 0) inventory.splice(invIdx, 1);
    unequipSlot(memberIdx, slot);
    m.equipment[slot] = taken;
    applyStats(m, itemStats(taken), +1);
    msg.set((taken.shopName || '裝備') + ' 已裝備', 900);
    return true;
  }

  return {
    useItemFromMenu, castSpellFromMenu,
    itemSlot, itemStats,
    unequipSlot, equipFromInventory,
  };
}
