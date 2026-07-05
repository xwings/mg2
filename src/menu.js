// ESC-menu logic for inventory, spells, and equipment.
//
// Mirrors the original equip flow (disasm 0x4eb1-0x4fe7): slot is
// derived from the item id's range, the equip-permission bitmask gates
// per member, and stats are RECOMPUTED from base + all equipped items
// (0x6fbb) rather than delta'd. Equipping swaps the old piece back into
// the inventory; unequip (0x515b) returns the piece and zeroes the slot.

import {slotForItem, isConsumable, canEquip, recomputeStats, applyConsumable}
  from './items.js';

export function createMenuSystem({state, inventory, msg, itemTable}){
  // `msg` is a setter object: { set(text, ttlMs) } so the caller owns
  // the on-screen message timer.

  function useItemFromMenu(idx){
    const it = inventory[idx];
    if(!it) return {consumed: false};
    if(!isConsumable(it.id)){
      msg.set('從裝備使用', 800);
      return {consumed: false};
    }
    const r = applyConsumable(state.party[0], itemTable[it.id], it.id, itemTable);
    msg.set(r.msg, r.used ? 900 : 700);
    if(!r.used) return {consumed: false};
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

  // Inventory indices whose item fits `slot` AND is permitted for the
  // member (mask bit test, disasm 0x4ebd).
  function eligibleForSlot(slot, memberIdx){
    const out = [];
    for(let i = 0; i < inventory.length; i++){
      const it = inventory[i];
      if(slotForItem(it.id) !== slot) continue;
      if(!canEquip(itemTable[it.id], memberIdx)) continue;
      out.push(i);
    }
    return out;
  }

  // Return one unit of item `id` to the inventory (disasm 0x1586).
  function returnToInventory(id){
    const existing = inventory.find(i => i.id === id);
    if(existing) existing.count = (existing.count || 1) + 1;
    else inventory.push({id, count: 1});
  }

  function unequipSlot(memberIdx, slot){
    const m = state.party[memberIdx];
    const old = m.equipment[slot];
    if(!old) return false;
    returnToInventory(old);
    m.equipment[slot] = 0;
    recomputeStats(m, itemTable);
    return true;
  }

  function equipFromInventory(memberIdx, invIdx){
    const m = state.party[memberIdx];
    const it = inventory[invIdx];
    if(!it) return false;
    const slot = slotForItem(it.id);
    if(!slot){ msg.set('無法裝備', 800); return false; }
    if(!canEquip(itemTable[it.id], memberIdx)){ msg.set('不能裝備', 800); return false; }
    const old = m.equipment[slot];
    it.count = (it.count || 1) - 1;
    if(it.count <= 0) inventory.splice(invIdx, 1);
    if(old) returnToInventory(old);
    m.equipment[slot] = it.id;
    recomputeStats(m, itemTable);
    msg.set('已裝備', 900);
    return true;
  }

  return {
    useItemFromMenu, castSpellFromMenu,
    eligibleForSlot, unequipSlot, equipFromInventory,
  };
}
