# Renderer & UI Chrome

## Goal

All Canvas 2D drawing: the layered overworld scene (disasm-faithful
foreground pass order), sprites, glyph-bitmap dialog window, ESC-menu
screens, shop, and slot picker. Since 2026-07 the UI chrome is
reproduced from the original's actual drawing primitives rather than
invented Canvas art — `src/ui.js` holds the window/glyph/digit/cursor
toolkit, and every screen is drawn with real MG2.15/P.15 glyphs, the
N15.T15 digit font, and palette-index colors resolved through VGAM.DAC.

## Status

`done` — overworld + all menu/dialog/shop/battle screens redrawn to the
disasm spec. The overworld has NO persistent HUD (the original draws
none); HP/gold/stats live in the ESC menu.

## Code Structure

| File | Role |
| ---- | ---- |
| `src/ui.js` | window/glyph/digit/cursor primitives (0xB503, 0x989, 0x12CD, M_IP hand) |
| `src/render.js` | scene + all menu/dialog draw functions |

## UI primitives (`src/ui.js`, disasm-anchored)

- `drawWindow(x,y,w,h)` — 0xB503: translucent darken (COLORM LUT 2,
  approximated by an alpha overlay whose ratio `parseColorLUTs` measures
  from the real table) + 3 nested 1-px borders (black, palette 0x4A
  yellow, 0x54 brown).
- `drawString(entryId,x,y,base)` / `drawGlyphs(bytes,…)` — 0x989/0xABB:
  16-px glyph advance, 4-direction outline + 5-band vertical gradient
  (colors base..base+4). Base 0xEF is the "fire" gradient the original
  palette-cycles; we rotate the bands on the same ~194 ms period.
  Rendered glyphs are cached per (bitmap, base, phase).
- `drawNum(value,x,y,base,opts)` — 0xC26 (8×8 N15.T15, outline + 3-band)
  and 0xF64/0x1040 (16-px MG2.15 digit glyphs 0x3D4+d); `cells:N`
  fixed-slot (leading zeros blank) or `leftPack:true`.
- `drawHand(x,y)` — M_IP.DAT 20×15 hand cursor with the 32-tick wiggle.
- `drawSelBar(x,y)` — 102×20 darken bar + palette 0xBD red border.

## Key colors (VGAM.DAC index → role)

`1` white text · `0x2B` pale-yellow label · `0x48` stat value · `0x64`
"max" pale blue · `0x71` usable item · `0x78` grey item · `0xBA` red
message · `0xBD` selection-frame red · `0xEF` selected (fire gradient).

## Screen geometry (all disasm-verified)

- **Dialog window** — (0,140) 320×60, 3 text lines at y=145/162/179,
  16-px advance, next-page marker MG2.15 0x0F in fire color.
- **Pickup message** — same window; 得到了 (0x2C8) + P.15 item name /
  gold amount + 元 (0x3BB).
- **ESC menu** — the original's small (12,8) 100×70 window with six
  category labels (MG2.15 0-5: 物品 魔法 裝備 狀態 進度 系統) in a 2×3
  column-major grid; selection is a fire-gradient color swap. Each
  category opens its own screen: item/spell browser (0,0) 306×150 with
  the 7×2 grid + selection bar + hand; full status screen (0,10)
  320×185 with the PBIG portrait; equip 3-panel screen (stats/slots/
  inventory, eligibility colors 0x71/0xAC/0x78); **進度** opens the
  save/load chooser (options 0x190 儲存目前進度 / 0x191 讀取以前進度,
  disasm 0xa0b4); **系統** the quit confirm (0x19A + 是/否).
- **Shop** ([shop.md](shop.md)) — (5,3) 310×112 window, gold box
  (10,110), 2-col grid, quantity picker (150,120), 是/否 & 買/賣 widgets.
- **Battle** ([battle.md](battle.md)) — dedicated screen: AM.TOS
  backdrop + SSLLP01 panel + ATTP hero poses + ENEMY.TOS formation,
  drawn by `battle.drawScreen` on the ATT.LOD palette (VGA.DAC).

## Foreground tiles (unchanged)

The per-tile `.HEI` byte controls render order (disasm 0x356E):

| `.HEI` | Pass | Meaning |
|---|---|---|
| 0 | ground | drawn before sprites |
| 1 | A | foreground at natural row |
| 2 | B | top of 2-tile-tall object (from row+1) |
| 3 | C | top of 3-tile-tall object (from row+2) |
| 4 | D | background overlay, drawn BEFORE sprites |

## Interactions

- Called from [boot-loop.md](boot-loop.md)'s per-state render dispatch.
- `src/ui.js` shared by `render.js`, [shop.md](shop.md), and
  [battle.md](battle.md) (the last uses a second UI instance on the
  VGA.DAC palette + ATT.15 strings).
- Consumes atlases/sprites/PBMs from [parsers.md](parsers.md) and the
  new UI assets (COLORM, N15.T15, M_IP, DUO, PBIG portraits).

## How to Test

Requires game data at `mg2/` and a static server.

- `?skip` — pass = overworld has no HUD bar/minimap; ESC opens the
  windowed menu with real glyph labels and digit fonts.
- `?skip&talk=N` — pass = dialog window is (0,140) with the translucent
  darken + yellow/brown border, 3 lines, crisp gradient glyphs.
- `?skip&encounter=2` — pass = a full battle screen (backdrop + panel +
  formation), not the overworld map.
- `?triggers` — the only debug overlay (trigger tiles, minimap, chest
  outlines).

## Open Gaps / Roadmap

- COLORM/COLOR remap tables are approximated as a uniform alpha darken
  (canvas is RGBA, not indexed) — the per-index tint of window fills is
  not pixel-exact.
- MODE1/MODE2.DAT textured window styles (0xB503 style 0xA/0xB) are not
  loaded; only the default translucent style is reproduced.
- Battle spell/hit animations (ME*/MP*/KILL* frames) are not played.
