# Save System

## Goal

Replace the original password screen with a 5-slot localStorage JSON
save system, including export/import to file. Serves M1 (the password
screen is explicitly out of scope). Persistence primitives live in
`save.js`; *what* gets saved and the restore ordering live in
`main.js`.

## Status

`done`

## Code Structure

| File | Role |
| ---- | ---- |
| `src/save.js` | slot CRUD on localStorage + file export/import |
| `src/main.js` | `snapshotState()` / `doSave()` / `doLoad()` — content and restore order |

## Key Types and Entry Points

- `src/save.js:8` - `saveToSlot(slot, data)` - wraps `{meta, state, version:1}` under `mg2_save_N`.
- `src/save.js:31` - `loadFromSlot(slot)`; `:46` `listSlots()` (meta summaries for the picker); `:128` `hasSave()`.
- `src/save.js:68` - `exportSlotToFile(slot)` - browser download of the raw blob.
- `src/save.js:89` - `importFileToSlot(slot)` - file-picker import with shape validation.
- `src/save.js:123` - `SAVE_SLOTS = 5`.
- `src/main.js:838` - `snapshotState()` - party, inventory, flags, NPC deltas, collected treasures, position.
- `src/main.js:924` - `doLoad(slot)` - the load-order contract: reset NPCs to `_orig*` → restore flags → load map → `applySJN` → overlay saved NPC deltas. Reordering this corrupts quest-blocker state.

## Interactions

- Driven by [boot-loop.md](boot-loop.md): slot picker (`ST.SLOT_PICKER`),
  ESC-menu Save/Load, E/I export-import keys.
- `doLoad` replays [npc-state.md](npc-state.md) `applySJN` and
  rehydrates inventory names via [dialog.md](dialog.md)'s item-name
  resolver and spells via [battle.md](battle.md) `SPELL_LIB`.
- NPC `_orig*` snapshot fields come from [parsers.md](parsers.md)
  `parseNPCs`.
- A `doLoad` rejection is caught by the slot-picker path (M2 guard in
  [boot-loop.md](boot-loop.md)) so a corrupt import can't soft-lock the
  game.

## How to Test

Requires game data at `mg2/` and a static server.

- ESC → Save → slot 1, reload the page, title → Continue → slot 1 -
  pass = same area, position, gold, inventory, and quest-blocker state.
- In the slot picker: E on a filled slot - pass = `.json` downloads;
  I with `power_saved.json` - pass = "Imported to slot N", loading it
  yields the 999-stat debug hero in area 7.
- Import a truncated/garbage `.json` - pass = "Import failed" message,
  game stays responsive (no black-screen lock).

## Open Gaps / Roadmap

- Legacy slot-0 helpers `saveGame`/`loadGameState`
  (`src/save.js:126-127`) are unused by `main.js`; kept for
  compatibility, candidates for removal.
- No save-format migration beyond the `version: 1` tag.
