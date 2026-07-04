# NPC Quest-Blocker Engine (SJN.DAT)

## Goal

Replay MG2's quest-blocker rules: flag-conditional NPC mutation (gate
guards stepping aside, post-quest hides) plus the NPC
visibility/position helpers the rest of the engine consults. Serves M1
— without it, quest-gated passages stay blocked forever.

## Status

`done` for F0 (NPC-write) records — the complete SJN rule set is 46
areas / 139 conditions. Non-F0 `rawTiles` map-tile rewrites are parsed
but not applied (M3).

## Code Structure

| File | Role |
| ---- | ---- |
| `src/npcState.js` | SJN rule replay + NPC hidden/position helpers |

## Key Types and Entry Points

- `src/npcState.js:29` - `createNpcState({state, areas, npcData, flags, sjnTable, MCOLS, MROWS})` - factory; returns `{applySJN, reapplySJN, npcPos, npcHidden}`.
- `src/npcState.js:30` - `applySJN(aid)` - walks SJN conditions for an area, writing NPC fields through the `NPC_FIELD` map (`:13`).
- `src/npcState.js:49` - `reapplySJN()` - re-run for the current area; wired as dialog's `onPageOpsApplied` callback.
- `src/npcState.js:61` - `npcHidden(n)` - three hide reasons: script `hidden` flag, unspawned script-bound NPC on a `0xF000` trigger tile, off-map sentinel.
- `src/npcState.js:54` - `npcPos(n)` - currently identity; kept as the future chokepoint for position overrides.

**The core invariant (disasm-verified):** MG2.EXE NEVER reads quest
flags during NPC render — the flag array at `[bx+0x3D8]` is only read
by the script interpreter. Blockers disappear because `FF60`/`FF65`
write their coords past the map edge (Y ≥ 155 = off-screen), OR because
SJN.DAT's FF80 dispatcher rewrites their position when the flag flips.
`applySJN` replays the rules on area enter, after every
`applyScriptOps`, and on save load.

## Interactions

- Created by [boot-loop.md](boot-loop.md); `applySJN` runs on area
  load and inside `doLoad` (see [save.md](save.md) restore order).
- `reapplySJN` fired by [dialog.md](dialog.md) after each page's ops.
- `npcHidden`/`npcPos` consumed by [area.md](area.md) `blocked()` and
  [render.md](render.md) `drawNPCs()`.
- Rule table produced by [parsers.md](parsers.md) `parseSJN`.

## How to Test

```sh
python3 mg2tools.py sjn    # pass = decodes 46 areas / 139 conditions
```

- `http://localhost:8080/?skip&visited=6,106,107&area=6` - pass =
  quest-gated NPC blockers reflect the preloaded flags (guard moved
  aside where the quest state says so).
- Complete a flag-setting dialog, then walk at the blocker - pass =
  blocker repositioned immediately (reapplySJN after page ops), no
  area re-enter needed.

## Open Gaps / Roadmap

- **M3**: `rawTiles` map-tile rewrite records are carried through
  parsing (`src/npcState.js:44`) but not applied — some quest events
  that alter map tiles (not NPCs) won't visually change.
