# Dialog Runner & Item Names

## Goal

Drive NPC conversations and cutscenes: own the dialog pages/cursor,
apply each page's script ops, hand shopkeeper NPCs off to the shop UI,
and resolve item names through the four `.15` glyph-table cascade.
Serves M1.

## Status

`done` — NPC dialog now goes through the real stride-60 flag dispatcher
(`lookupStride60`, sub-entry 0 flag table), with the old
probe-alternates loop kept only as a fallback. Shop handoff is
opcode-driven: a dialog whose op list ends in FF01/FF02/FF03 opens the
inn / item shop / equip shop when dismissed. FFB0 cutscene images are
surfaced via the host's `showImage` hook and drawn behind the dialog
box.

## Code Structure

| File | Role |
| ---- | ---- |
| `src/dialog.js` | dialog/cutscene page runner factory |
| `src/itemName.js` | item-name resolution cascade across the `.15` tables |

## Key Types and Entry Points

- `src/dialog.js` - `createDialogSystem({state, npcData, getScript, shop, ST, scriptCtx, onPageOpsApplied, onClose})` - factory; returns `{openNPCTalk, runScript, openResult, advance, close, applyPageOps, getState}`.
- `src/dialog.js` - `applyPageOps()` - runs `applyScriptOps` once per page, then fires `onPageOpsApplied` (wired to `reapplySJN`).
- `src/dialog.js` - `finish()` - dismissal path: applies trailing ops (pageIdx past the last page, e.g. end-of-script FF80 stamps), then either opens the shop from a pending FF01/FF02/FF03 op or returns to `ST.PLAY` and fires `onClose` (clears the FFB0 image).
- `src/dialog.js` - `openNPCTalk(npc)` - stride-60 flag dispatch at id = rawIdx (disasm 0x2D86 → 0x8840), fallback to probing entries `rawIdx*10 + 1..4`.
- `src/itemName.js` - `createItemNameResolver(…)`; `lookupItemTable` is now P.15-first — the original renders every item name from P.15 at the raw item id (renderer 0xA21) — with the old kind cascade and the area-script run as fallbacks only.

## Interactions

- Called by [boot-loop.md](boot-loop.md): SPACE-on-NPC opens talk,
  `ST.NPC_TALK` input advances/closes, render dispatch reads
  `dialog.pages`.
- Runs entries via [script-interpreter.md](script-interpreter.md); page
  ops flow back through `applyScriptOps`.
- `onPageOpsApplied` notifies [npc-state.md](npc-state.md) to re-run
  SJN rules after flag writes.
- Shopkeeper NPCs hand off to [shop.md](shop.md) via the FF01/FF02/FF03
  ops (`shop.openInn` / `shop.openShop`) — no NPC→shop table exists.
- Item-name resolution used by [boot-loop.md](boot-loop.md) pickups and
  [save.md](save.md) load-time inventory rehydration.

## How to Test

Requires game data at `mg2/` and a static server.

- `http://localhost:8080/?skip&talk=N` - pass = NPC N's dialog opens;
  SPACE advances pages, ESC closes, play resumes.
- Talk to a shopkeeper (e.g. weapon shop in the starting town) - pass =
  the shopkeeper's dialog line shows first, then the shop UI opens on
  dismissal (matching the original flow).
- Pick up a treasure (`?pickup=0`) - pass = pickup message shows a real
  item name, not a raw id.

## Open Gaps / Roadmap

- FFB0 fade sequences (rapidly alternating images) show as one held
  image per page — per-op timing inside a page isn't modeled.
