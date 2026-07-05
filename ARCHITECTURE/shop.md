# Shops & Inns

## Goal

The buy/sell/inn trade UI, opened by the `.15T` shop opcodes exactly
like the original: a shopkeeper NPC's dialog terminates in FF01 (inn),
FF02 (item shop) or FF03 (equipment shop), and the trade screen opens
when the last dialog page is dismissed. Stock, prices, and sell values
all come from original game data — there is no hand-authored table
anymore.

## Status

`done` — data-driven from the disasm'd sources:

- **Stock**: the 10 inline u16 params of FF02/FF03 (handler 0x9B36 /
  0x9D47 copies them to cs:[0x102..0x115]; 0x3E7 = empty slot).
- **Prices**: item-table dword at `DS:[id*0x14 + 0x6C3]`
  ([parsers.md](parsers.md) `parseItemTable`), gold check at 0x9c04.
- **Sell price**: `price >> 1` (0x9f95); price-0 items are unsellable
  quest goods (0x9fb7).
- **Quantities**: 1..99 picker (0x998F), capped by `gold / price`
  (0x9c69) and the 99-per-stack limit (0x15db).
- **Inn**: FF01's param is the advertised price only — the original
  never deducts it (verified against every write to gold cs:0xb1d1).
  The 是/否 selector is the 0x13A0 widget: arrows toggle, the
  highlighted option uses the fire gradient, confirm acts on it, Esc =
  否. "Yes" fully heals the party with a sleep fade-to-black
  (0x98DD → 0x244 → 0x9941); the free-inn quirk is deliberate.

## Code Structure

| File | Role |
| ---- | ---- |
| `src/shop.js` | shop UI state machine (menu/buy/qty/sell/inn) + drawing |

## Key Types and Entry Points

- `src/shop.js:26` - `createShopSystem({state, itemTable, itemGlyphs, drawGlyph})` - factory; returns `{openShop, openInn, closeShop, tick, draw, getShop}`.
- `src/shop.js:29` - `openShop(stock, kind, ST)` - kind `'items' | 'equip'`; called by [dialog.md](dialog.md) with the FF02/FF03 params.
- `src/shop.js:42` - `openInn(price, ST)` - FF01 handoff.
- `src/shop.js:70` - `maxBuyQty(id)` - gold ÷ price, capped at 99 − held.
- `src/shop.js:106` - `tick(pressedKey, ST)` - input machine: `menu → buy → buy-qty` / `sell → sell-qty` / `inn-prompt`.
- `src/shop.js:214` - `compareGlyph(id)` - equip-shop ↑/↓/=/× vs the equipped piece (party panel, disasm 0x7e80-0x80cd): weapon compares stat[0], armor/shield/helmet stat[1], accessories stat[2].
- Item names render from P.15 glyphs at the raw item id (`itemGlyphs`).

## Interactions

- Opened only by [dialog.md](dialog.md) when a dialog's op list carries
  FF01/FF02/FF03 (`finish()` handoff). There is no NPC → shop mapping
  table — which NPCs are shopkeepers is entirely script data.
- Driven per-frame by [boot-loop.md](boot-loop.md) in `ST.SHOP`
  (input → `tick`, render → `draw`).
- Prices/stats come from the item table ([parsers.md](parsers.md)),
  names from P.15; inventory shared via `state._inventoryRef`.

## How to Test

Requires game data at `mg2/` and a static server.

- `?skip&area=107`: talk to the weapon shopkeeper at (20, 7) - pass =
  his dialog line shows, then the equip-shop UI opens stocked with items
  100/101/130/310/240/270/340/360 at 30/120/25/130/22/75/150/210 G.
- The pharmacist at (57, 10) - pass = item shop with 藥草 20G etc.
- The innkeeper at (30, 39) - pass = 6 G advertised; accepting heals
  HP/MP without charging gold (original behavior).
- Buy with quantity ±1/±10 - pass = total = price × qty, gold floor
  respected; sell back - pass = half price per unit.

## Open Gaps / Roadmap

- The equip-shop party panel is simplified: the original draws a
  per-member grid sized `0x24 + (partySize−1)*0x1A` (0x7985); we show a
  single compare glyph for the solo hero.
- Buy/sell quantity keys are engine-defined (↑↓ ±1, ←→ ±10); the
  original's exact key mapping in 0x998F wasn't traced.
