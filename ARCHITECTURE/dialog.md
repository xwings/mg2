# Dialog Runner & Item Names

## Goal

Drive NPC conversations and cutscenes: own the dialog pages/cursor,
apply each page's script ops, hand shopkeeper NPCs off to the shop UI,
and resolve item names through the four `.15` glyph-table cascade.
Serves M1.

## Status

`done` — the NPC entry `+0` FF10-conditional dispatch is approximated
by probing default-then-alternate entries (see Open Gaps).

## Code Structure

| File | Role |
| ---- | ---- |
| `src/dialog.js` | dialog/cutscene page runner factory |
| `src/itemName.js` | item-name resolution cascade across the `.15` tables |

## Key Types and Entry Points

- `src/dialog.js:15` - `createDialogSystem({state, npcData, getScript, shop, ST, scriptCtx, onPageOpsApplied})` - factory; returns `{openNPCTalk, runScript, openResult, advance, close, applyPageOps, getState}`.
- `src/dialog.js:31` - `applyPageOps()` - runs `applyScriptOps` once per page, then fires `onPageOpsApplied` (wired to `reapplySJN`).
- `src/dialog.js:54` - `runScript(scriptName, entryIdx, …)` - cutscene entry point (TS001 intro).
- `src/dialog.js:62` - `openResult(r, …)` - open a pre-run script result (stride-60 notice boards / fountains).
- `src/dialog.js:78` - `openNPCTalk(npc)` - shop check first, then probes `.15T` entries `rawIdx*10 + 1..4` (disasm 0x2D86 → 0x8840).
- `src/itemName.js:15` - `createItemNameResolver({tryByType, tables, getScript, getCurrentAreaScript})` - factory.
- `src/itemName.js:31` - `lookupItemTable(itemId, kind)` - priority-order probe of the 4 tables; first ≥2-glyph hit wins.
- `src/itemName.js:43` - `resolveItemName(itemId, kind)` - async; falls back to running the area script entry and extracting glyphs.

## Interactions

- Called by [boot-loop.md](boot-loop.md): SPACE-on-NPC opens talk,
  `ST.NPC_TALK` input advances/closes, render dispatch reads
  `dialog.pages`.
- Runs entries via [script-interpreter.md](script-interpreter.md); page
  ops flow back through `applyScriptOps`.
- `onPageOpsApplied` notifies [npc-state.md](npc-state.md) to re-run
  SJN rules after flag writes.
- Shopkeeper NPCs hand off to [shop.md](shop.md) `tryOpenShop`.
- Item-name resolution used by [boot-loop.md](boot-loop.md) pickups and
  [save.md](save.md) load-time inventory rehydration.

## How to Test

Requires game data at `mg2/` and a static server.

- `http://localhost:8080/?skip&talk=N` - pass = NPC N's dialog opens;
  SPACE advances pages, ESC closes, play resumes.
- Talk to a shopkeeper (e.g. weapon shop in the starting town) - pass =
  shop UI opens instead of plain dialog.
- Pick up a treasure (`?pickup=0`) - pass = pickup message shows a real
  item name, not a raw id.

## Open Gaps / Roadmap

- **M3**: entry `+0` FF10-conditional dispatch is approximated by
  "try default then a few alternates" (`src/dialog.js:4`); exact
  semantics need the FF10 decode in
  [script-interpreter.md](script-interpreter.md).
