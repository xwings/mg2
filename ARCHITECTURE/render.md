# Renderer

## Goal

All Canvas 2D drawing: layered scene (with the disasm-faithful
foreground pass order), sprites, HUD, glyph-bitmap dialog boxes, title,
ESC menu, and slot picker. Serves M1.

## Status

`done`

## Code Structure

| File | Role |
| ---- | ---- |
| `src/render.js` | `createRenderer` factory exposing every draw function |

## Key Types and Entry Points

- `src/render.js:6` - `createRenderer(ctx, res)` - factory; returns the draw-function object (return block `:736-743`).
- `src/render.js:48` - `tileIsForeground(ti, state)` - `.HEI` attr semantics (disasm 0x356E/0x3643).
- `src/render.js:61` - `renderScene(state)` - background pass; `:85` `renderForeground(state)` - deferred over-sprite pass.
- `src/render.js:100` - `drawPlayer`; `:105` `drawNPCs(state, npcData, npcHidden, npcPos)`; `:126` `drawTreasures`.
- `src/render.js:171` - `drawHUD`; `:287` `drawScriptPage(page, speakerName, …)` - dialog box; `:274` `drawGlyph(bytes, dx, dy, color)` - 16×15 1-bit glyph blitter.
- `src/render.js:327` - `drawTitle`; `:425` `drawGameMenu`; `:691` `drawSlotPicker`.

**Foreground tiles.** The per-tile `.HEI` byte controls render order
(disasm 0x356E); getting this wrong renders the player *on top of*
towers, castle walls, and tree crowns:

| `.HEI` | Pass | Meaning |
|---|---|---|
| 0 | ground | drawn before sprites |
| 1 | A | foreground at natural row |
| 2 | B | top of 2-tile-tall object (drawn from row+1) |
| 3 | C | top of 3-tile-tall object (drawn from row+2) |
| 4 | D (0x340A) | background overlay, drawn BEFORE sprites |

The trailing bytes in `.SMP` are NOT the foreground attr — that's
`.HEI`.

Battle is the one layering exception: combatant sprites draw *after*
the foreground pass so tall monsters aren't clipped by tree crowns
(see the render dispatch in [boot-loop.md](boot-loop.md)).

Performance envelope: everything is O(viewport) `drawImage` calls — no
`getImageData` per frame; the rendering path was audited during the M2
hang investigation and cleared (heavy pages of glyph `fillRect`s are
jank-level at worst, never a hang).

## Interactions

- Called exclusively from [boot-loop.md](boot-loop.md)'s per-state
  render dispatch.
- Consumes atlases/sprites/PBMs produced by [parsers.md](parsers.md)
  and cached by [area.md](area.md).
- `drawNPCs` respects [npc-state.md](npc-state.md)
  `npcHidden`/`npcPos`; `drawGameMenu` receives
  [menu.md](menu.md) `itemSlot`.

## How to Test

Requires game data at `mg2/` and a static server.

- `?skip&area=1` - pass = walk behind a tree crown / tower: player is
  hidden by pass A-C tiles; walk in front: player draws on top.
- `?skip&talk=N` - pass = dialog glyphs are crisp and correctly
  colored (garbling points at script strides, not the blitter).
- `?skip&encounter=2` - pass = tall enemies draw over foreground tiles
  during battle, and normal layering returns after the fight.
- Visual fidelity: `compare.html` A/B against DOSBox (see
  [tooling.md](tooling.md)).

## Open Gaps / Roadmap

- Full-page dialog text costs ~17k 1-px `fillRect`s per frame
  (`src/render.js:274` blitter); cache rendered glyphs to offscreen
  canvases if dialog jank is ever reported on slow hardware.
