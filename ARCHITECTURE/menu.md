# ESC-Menu Actions

## Goal

The action logic behind the ESC menu: use item, cast field spell,
equip/unequip with stat deltas. Serves M1. Menu *navigation* state
(cursor, focus, submenu index) deliberately lives in
[boot-loop.md](boot-loop.md); this module owns only the actions.

## Status

`done`

## Code Structure

| File | Role |
| ---- | ---- |
| `src/menu.js` | menu action factory (use/cast/equip) |

## Key Types and Entry Points

- `src/menu.js:11` - `createMenuSystem({state, inventory, msg})` - factory; returns `{useItemFromMenu, castSpellFromMenu, itemSlot, itemStats, unequipSlot, equipFromInventory}`.
- `src/menu.js:15` - `useItemFromMenu(idx)` - potion→HP, magic→MP; returns `{consumed, empty}` so the caller can fix its cursor.
- `src/menu.js:57` - `itemSlot(it)` - routes shop kinds and `.15T` kind===2 pickups to weapon/armor slots.
- `src/menu.js:68` - `itemStats(it)` - stat bonuses from `SHOP_ITEMS`; token +3 for script pickups.
- `src/menu.js:105` - `equipFromInventory(memberIdx, slot, invIdx)` - moves items inventory↔equipment applying/reverting stat deltas.

## Interactions

- Called by [boot-loop.md](boot-loop.md) `ST.MENU` input handling;
  navigation state and rendering stay there / in
  [render.md](render.md) `drawGameMenu` (which receives `itemSlot`).
- Reads `SHOP_ITEMS` from [shop.md](shop.md) for equip stats.
- Field spell casting uses `SPELL_LIB` semantics shared with
  [battle.md](battle.md).

## How to Test

Requires game data at `mg2/` and a static server.

- `?skip` → ESC → Items → use a potion - pass = HP rises, item count
  drops, cursor stays valid when the list shrinks.
- ESC → Equip → equip a bought weapon - pass = ATK rises by the item's
  bonus; unequip reverts it exactly.
- ESC → Magic → cast the heal spell in the field - pass = MP cost
  deducted, HP restored.

## Open Gaps / Roadmap

- Script-pickup equipment uses a token +3 stat bonus
  (`src/menu.js:68`) until real item stats are decoded (relates to the
  M3 shop-opcode work in [shop.md](shop.md)).
