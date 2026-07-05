// Item-system logic on top of the MG2.EXE item table (parseItemTable).
//
// Equip slots and id→slot routing are hardcoded ranges in the original
// (equip action 0x4f1b-0x4fc9; same ranges in the shop compare drawer
// 0x7f2f-0x8042). Stats are never delta'd: the recompute at 0x6fbb
// copies base → effective then adds every equipped item's six stat
// words. We mirror that exactly so equip/unequip can't drift.

// Display order matches the member record: +0x44 weapon, +0x46 shield,
// +0x48 helmet, +0x4a armor, +0x4c/+0x4e accessories (name draw
// 0x75d9-0x7648; slot labels = MG2.15 entries 0xdc-0xe1).
export const EQUIP_SLOTS = ['weapon', 'shield', 'helmet', 'armor', 'acc1', 'acc2'];

// id-range → slot (disasm 0x4f1b-0x4fc9). Ranges are [lo, hi).
const SLOT_RANGES = [
  ['weapon', 100, 240],
  ['armor',  240, 310],
  ['shield', 310, 340],
  ['helmet', 340, 370],
  ['acc1',   370, 400],
  ['acc2',   400, 410],
];

export function slotForItem(id){
  for(const [slot, lo, hi] of SLOT_RANGES){
    if(id >= lo && id < hi) return slot;
  }
  return null;                 // < 100 = consumable / quest item
}

export function isConsumable(id){ return id < 100; }

// Equip-permission bitmask test (disasm 0x4ebd: `test dx, 1 << member`).
export function canEquip(rec, memberIdx){
  if(!rec) return false;
  return (rec.mask & (1 << memberIdx)) !== 0;
}

// Effective stats = base + Σ equipped item stat words (disasm 0x6fbb).
// Item stat word order matches the member stat words: atk, def, spd,
// mgAtk, mgDef, x6 (anchored by the booster messages MG2.15 130-136 and
// the shop key-stat compares: weapon→[0], armor→[1], shoes→[2]).
export function recomputeStats(member, itemTable){
  const b = member.base;
  let atk = b.atk, def = b.def, spd = b.spd, mgAtk = b.mgAtk, mgDef = b.mgDef;
  for(const slot of EQUIP_SLOTS){
    const id = member.equipment[slot];
    if(!id) continue;
    const rec = itemTable[id];
    if(!rec) continue;
    atk   += rec.stats[0];
    def   += rec.stats[1];
    spd   += rec.stats[2];
    mgAtk += rec.stats[3];
    mgDef += rec.stats[4];
  }
  member.atk = atk; member.def = def; member.spd = spd;
  member.mgAtk = mgAtk; member.mgDef = mgDef;
}

// Consumable use (menu 0x534d heal path, 0x56e8 booster path).
// Returns {used, msg} — msg is a short UI string; used=false means the
// item is not consumed (full HP/MP, or an undecoded status-cure item).
export function applyConsumable(member, rec, id, itemTable){
  if(!rec) return {used: false, msg: '使用不能'};
  // Boosters 19-25: permanent gains, field k → maxHp/maxMp/five stats.
  if(id >= 19 && id <= 25){
    const [dHp, dMp, dAtk, dDef, dSpd, dMgA, dMgD] = rec.stats;
    if(dHp){ member.maxHp += dHp; member.hp += dHp; }
    if(dMp){ member.maxMp += dMp; member.mp += dMp; }
    member.base.atk += dAtk; member.base.def += dDef;
    member.base.spd += dSpd; member.base.mgAtk += dMgA;
    member.base.mgDef += dMgD;
    recomputeStats(member, itemTable);
    return {used: true, msg: '能力上升!'};
  }
  const healHp = rec.stats[0], healMp = rec.stats[1];
  if(healHp <= 0 && healMp <= 0) return {used: false, msg: '使用不能'};
  if((healHp <= 0 || member.hp >= member.maxHp) &&
     (healMp <= 0 || member.mp >= member.maxMp)){
    return {used: false, msg: 'HP/MP 已滿'};
  }
  const parts = [];
  if(healHp > 0 && member.hp < member.maxHp){
    const h = Math.min(member.maxHp - member.hp, healHp);
    member.hp += h;
    parts.push('+' + h + ' HP');
  }
  if(healMp > 0 && member.mp < member.maxMp){
    const r = Math.min(member.maxMp - member.mp, healMp);
    member.mp += r;
    parts.push('+' + r + ' MP');
  }
  return {used: true, msg: parts.join(' ')};
}
