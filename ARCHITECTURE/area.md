# Area Loading, Collision & Triggers

## Goal

Load maps and tilesets on area entry (with session-lifetime caches),
answer "can the player stand here", and match the player's tile
against INOUT.DAT warp/script triggers. Serves M1.

## Status

`done`

## Code Structure

| File | Role |
| ---- | ---- |
| `src/area.js` | caches, map loading, collision, trigger matching |

## Key Types and Entry Points

- `src/area.js:6` - `createCaches(pal)` - returns `{getTileset, getScript}`; `getTileset` (`:10`) loads SMAP `.SMP/.BIT/.HEI` triples, `getScript` (`:28`) loads `S/<name>.15T` with a cutscene-format fallback.
- `src/area.js:45` - `loadArea(areaId, state, areas, getTileset)` - sets `state.curAtlas/curCol/mapL1/mapL2/curArea`; map is 208×155 u16 × 2 layers, tile `0x07FF` = void.
- `src/area.js:69` - `blocked(c, r, state, npcData, doorCol, isNpcHidden, npcPos)` - 2-tile-wide player collision vs both layers + door tiles + visible NPCs.
- `src/area.js:105` - `checkTrigger(state, areas)` - auto-fire warp trigger match (disasm 0x2055; `sx/sy` 0 = wildcard).
- `src/area.js:118` - `findNearbyTrigger(state, areas)` - SPACE-to-enter triggers within 3 tiles.
- `src/area.js:130` - `checkScriptTrigger(state, areas, firedScripts)` - `ta=0xF000` script triggers, gated by `firedScripts`.

Non-obvious invariant: INOUT.DAT trigger target coords are **(Y, X)**,
not (X, Y) — see [parsers.md](parsers.md) `parseAreas`.

## Interactions

- Called by [boot-loop.md](boot-loop.md) on every area load, movement
  step (collision), and SPACE press (trigger probing).
- Uses [parsers.md](parsers.md) `buildAtlas` and
  [script-interpreter.md](script-interpreter.md) parse functions inside
  its caches.
- Receives `npcHidden`/`npcPos` from [npc-state.md](npc-state.md) so
  hidden quest-blockers don't block movement.

## How to Test

Requires game data at `mg2/` and a static server.

- `http://localhost:8080/?skip&area=6` - pass = area 6 renders and the
  player can move; repeat with a few area IDs (1-4 outdoor, dungeons).
- `http://localhost:8080/?skip&triggers` - pass = pink (warp) and cyan
  (script) overlays sit on doors/stairs; walking onto pink warps.
- Walk against walls/water - pass = movement blocked, no clipping
  through layer-2 tiles.

## Open Gaps / Roadmap

- Tileset/script caches are unbounded for the session; fine at MG2's
  scale (56 maps), revisit only if memory ever matters.
