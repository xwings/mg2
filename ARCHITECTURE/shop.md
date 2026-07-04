# Shops & Inns

## Goal

The buy/sell/inn trade UI, keyed to specific POL.DAT shopkeeper NPCs.
Serves M1 gameplay, but the stock data is a stand-in: the original
game's shop dialog fires a special opcode that opens the trading
screen, and until that opcode is decoded the stock tables are
hand-authored.

## Status

`scaffolding` — the UI and transaction logic work today, but
`SHOP_ITEMS`/`SHOP_BY_NPC` will be replaced by decoded original data
once the shop opcode is reverse-engineered (M3).

## Code Structure

| File | Role |
| ---- | ---- |
| `src/shop.js` | item catalog, per-NPC shop definitions, shop UI state machine |

## Key Types and Entry Points

- `src/shop.js:22` - `SHOP_ITEMS` - item catalog; ids ≥ 200 to avoid GEM.DAT id collision. Also imported by [menu.md](menu.md) for equip stats.
- `src/shop.js:94` - `SHOP_BY_NPC` - `'area:rawIdx'` → shop definition (weapons/items/inn, tiered via `STOCK` at `:66`).
- `src/shop.js:137` - `createShopSystem(state, areas, stringTable, itemTables)` - factory; returns `{tryOpenShop, closeShop, tick, draw, getShop}`.
- `src/shop.js:142` - `tryOpenShop(areaId, npcRawIdx, ST)` - the hook [dialog.md](dialog.md) calls before falling back to plain dialog.
- `src/shop.js:181` - `confirmBuy()`; `:208` `confirmSell()` (mutates `state._inventoryRef`); `:223` `innRest()`.
- `src/shop.js:236` - `tick(pressedKey, ST)` - shop input machine; `:288` `draw(ctx, W, H)`.

## Interactions

- Opened by [dialog.md](dialog.md) `openNPCTalk` (shop check runs
  before dialog probing).
- Driven per-frame by [boot-loop.md](boot-loop.md) in `ST.SHOP`
  (input → `tick`, render → `draw`).
- `SHOP_ITEMS` consumed by [menu.md](menu.md) `itemStats`/`itemSlot`.
- Inventory shared with [boot-loop.md](boot-loop.md) via
  `state._inventoryRef`.

## How to Test

Requires game data at `mg2/` and a static server.

- Talk to the weapon-shop NPC in the starting town (`?skip`, walk in,
  SPACE) - pass = shop UI opens with stock and prices.
- Buy an item - pass = gold decreases, item lands in inventory (check
  ESC menu → Items).
- Sell it back - pass = gold increases, item removed.
- Inn - pass = gold deducted, HP/MP restored to max.

## Open Gaps / Roadmap

- **M3**: decode the original shop opcode and replace
  `SHOP_ITEMS`/`SHOP_BY_NPC` with data-driven stock; this whole module's
  data layer is the replacement target (`src/shop.js:4` header
  comment).
