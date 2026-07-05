# NPC Quest-Blocker Engine (SJN.DAT) & Wander AI

## Goal

Replay MG2's quest-blocker rules: flag-conditional NPC mutation (gate
guards stepping aside, post-quest hides), the NPC visibility/position
helpers the rest of the engine consults, and the NPC wander AI. Serves
M1 — without it, quest-gated passages stay blocked forever.

## Wander AI (disasm 0x376C)

`wanderTick()` (called by the boot loop every ~417 ms — the original's
30-tick gate at 72 Hz):

- Only NPCs with **mobility flag 1** (POL.DAT record +0x0E) move;
  hidden / off-map (Y ≥ 160) NPCs skip; 50% act chance per tick.
- A coin picks the axis; the NPC wanders around its **(x2, y2) anchor**
  within **rangeY/rangeX** tiles (record +0x10/+0x12): at the limit
  the step is forced back toward the anchor, otherwise 50/50 either way.
- A step is blocked by map collision (both layers, both body columns),
  other NPCs, and the player — but the NPC **turns to face the
  attempted direction even when blocked** (0x3945 writes the facing
  unconditionally).

## Status

`done` — F0 (NPC-write) records AND F1 map-tile rewrite records are
both applied. F1 payloads are (mapY, mapX, tileRow, tileCol, w, h)
blocks fed to the same tile-stamp routine as script opcode FF80 (disasm
0x9726 → 0x97DE); `applySJN` stamps them via the `stampTiles` callback
whenever the rule's area is the currently loaded map.

## Code Structure

| File | Role |
| ---- | ---- |
| `src/npcState.js` | SJN rule replay + NPC hidden/position helpers |

## Key Types and Entry Points

- `src/npcState.js:29` - `createNpcState({state, areas, npcData, flags, sjnTable, MCOLS, MROWS, stampTiles})` - factory; returns `{applySJN, reapplySJN, npcPos, npcHidden}`. `stampTiles` comes from `main.js` (shared with the FF80 opcode).
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

- Tile stamps only apply to the currently loaded map; rules for other
  areas re-stamp on the next `applySJN(aid)` at area entry (matching
  the original, which re-runs the dispatcher on every area load).
