# ESC-Menu Actions

## Goal

The action logic behind the ESC menu: use item, cast field spell,
equip/unequip. Replicates the original equip engine (disasm
0x4eb1-0x4fe7): six gear slots, id-range slot routing, per-member
equip-permission masks, and full stat recompute instead of deltas.
Menu *navigation* state (cursor, focus, submenu index) deliberately
lives in [boot-loop.md](boot-loop.md); this module owns only the
actions.

## Status

`done` — driven by the real MG2.EXE item table
([parsers.md](parsers.md) `parseItemTable`); the shared slot/stat rules
live in `src/items.js`.

## Key Rules (disasm-verified)

- **Slots** (member record +0x44..+0x4E, `items.js EQUIP_SLOTS`):
  weapon / shield / helmet / armor / acc1 / acc2.
- **Slot routing by item-id range** (0x4f1b-0x4fc9): 100-239 weapon,
  240-309 armor, 310-339 shield, 340-369 helmet, 370-399 accessory,
  400-409 accessory 2; ids < 100 are consumables.
- **Equip permission**: item-table mask bit `1 << memberIdx` (0x4ebd).
- **Stats are recomputed, never delta'd** (0x6fbb): effective = base
  (+0x20..+0x2A) + Σ six stat words of every equipped item. Equip,
  unequip, level-up and stat boosters all end in `recomputeStats`.
- **Consumables** (0x534d): stats[0] = HP restored, stats[1] = MP
  restored (capped at max). **Boosters** ids 19-25 (0x56e8): permanent
  maxHp/maxMp/atk/def/spd/mgAtk/mgDef gains applied to base.
- Equipping swaps the old piece back into the inventory; unequip
  (0x515b) returns it and zeroes the slot. (The original's
  inventory-full equip quirk — new id written before the room check —
  can't trigger here because the JS inventory has no 82-slot cap.)

## Code Structure

| File | Role |
| ---- | ---- |
| `src/items.js` | slot ranges, mask check, `recomputeStats`, `applyConsumable` |
| `src/menu.js` | menu action factory (use/cast/equip) |

## Key Types and Entry Points

- `src/items.js:14` - `EQUIP_SLOTS`; `:26` `slotForItem(id)`; `:37` `canEquip(rec, memberIdx)`; `:46` `recomputeStats(member, itemTable)`; `:66` `applyConsumable(member, rec, id, itemTable)`.
- `src/menu.js:12` - `createMenuSystem({state, inventory, msg, itemTable})` - factory; returns `{useItemFromMenu, castSpellFromMenu, eligibleForSlot, unequipSlot, equipFromInventory}`.
- `src/menu.js:44` - `eligibleForSlot(slot, memberIdx)` - inventory indices passing both the id range and the mask.
- `src/menu.js:74` - `equipFromInventory(memberIdx, invIdx)` - slot derived from the item id; swap + recompute.

## Interactions

- Called by [boot-loop.md](boot-loop.md) `ST.MENU` input handling;
  navigation state and rendering stay there / in
  [render.md](render.md) `drawGameMenu` (slot labels = MG2.15 entries
  0xDC-0xE1, item names = P.15 glyphs).
- `items.js` is also consumed by [battle.md](battle.md) (consumable
  effects, level-up recompute) and [shop.md](shop.md) (compare arrows).
- Field spell casting uses `SPELL_LIB` semantics shared with
  [battle.md](battle.md).

## How to Test

Requires game data at `mg2/` and a static server.

- `?skip` → ESC → Equip - pass = six slots listed with the game's own
  labels; the fresh hero already wears weapon 100 / armor 240 / shoes
  370 (ATK 50, DEF 42, SPD 32 = base 45/38/29 + bonuses).
- Unequip the weapon (U) - pass = ATK drops to 45, item appears in the
  inventory; re-equip - pass = ATK 50 again, exact round-trip.
- Buy 小刀 (id 101) and equip - pass = ATK 53 (45+8); the shield slot
  refuses it.
- Use 藥草 at low HP - pass = heals up to 50, capped at maxHp.

## Open Gaps / Roadmap

- Status-cure consumables (ids 4, 6, 13-18 — zero stat words) report
  "no effect"; poison/status conditions aren't modeled yet.
- The six member stat words include a sixth stat (`x6`, never shown on
  the original status screen); tracked in `base.x6` but unused pending
  a battle-formula audit (ATT.LOD dodge reads word 4).
