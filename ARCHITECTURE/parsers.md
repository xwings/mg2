# Binary Format Parsers

## Goal

Pure, stateless decoders for every original DOS asset file — palette,
sprites, tilesets, maps, NPC/treasure/quest tables, glyph string
tables. Every format is reverse-engineered from the disassembly, never
guessed. Serves M1; this is the foundation every other subsystem sits
on.

## Status

`done` — all formats the engine needs decode correctly against
original data. `parseSJN` keeps F1 records as raw bytes; they are
tile-stamp payloads consumed by [npc-state.md](npc-state.md).

## Code Structure

| File | Role |
| ---- | ---- |
| `src/parsers.js` | all 14 decoder functions; no state, no I/O |

## Key Types and Entry Points

- `src/parsers.js:4` - `parsePal(buf)` - VGAM.DAC 6-bit VGA palette → Uint32 RGBA.
- `src/parsers.js:18` - `buildAtlas(buf, pal, tileCount)` - SMAP tilesheet → canvas atlas + attrs.
- `src/parsers.js:45` - `parseSprites24(buf, pal)` - 24×24 PLAYER.TOS / POL001.TOS frames.
- `src/parsers.js:79` - `parseEnemyTOS(buf, pal)` - variable-size monster sprites; header word order is BIG-endian (`offset = (w0<<16)|w1`).
- `src/parsers.js:128` - `parseEnemyDAT(buf)` - 300 × 80-byte monster stat records.
- `src/parsers.js:170` - `parseATTEncounterPool(buf)` - 2 groups × 25 biomes × 10 enemy ids at file 0x111CE.
- `src/parsers.js:207` - `parseATTLevelTable(buf)` - 70 u16 EXP thresholds at file 0x115B6; high byte = RNG jitter cap.
- `src/parsers.js:249` - `parseAreas(buf)` - INOUT.DAT per-area triggers + scripts; `ta=0xF000` marks a script trigger; target coords are **(Y, X), not (X, Y)**.
- `src/parsers.js:286` - `parseNPCs(buf)` - POL.DAT 20-byte NPC records with `rawIdx` + `_orig*` snapshot fields (required by save/load reset).
- `src/parsers.js:388` - `parseSJN(buf)` - quest-blocker condition table (46 areas, 139 conditions).
- `src/parsers.js` - `parseItemTable(buf)` - MG2.EXE item table: 410 × 20-byte records at file 0xDAE3 (DS:0x6B3) — 7 × i16 stat words, u16 equip mask, u32 price. Item name = P.15 entry at the raw id.
- `src/parsers.js` - `parseInitialState(buf)` - MG2.EXE compiled-in new-game image: gold/area/position from the cs:0xb174 save block, 4 member records (base stats, equipment ids, EXP thresholds) + starting inventory from the DS:0x0004 party block (file 0xD430).
- `src/parsers.js` - UI-asset decoders (2026-07 graphics pass): `parseColorLUTs` (COLORM/COLOR.DAT remap tables → measured alpha darken), `parseN15` (8×8 digit font), `parseRawSprite` (byte-per-pixel, 0xFF transparent / 0xFE shadow — M_IP hand, DUO skull, LIVE balloons), `parseRawImage` (SSLLP01 panel, MODE1/2 textures), `parseAMTOS` (battle backdrops, header words swapped `(w0<<16)|w1`), `parseATTP` (4×18 hero battle poses). `decodePBM(buf, pal, transparent)` gained a 0xFF-transparent mode for PBIG portraits.

**Format → disasm anchor map** (details live in `src/parsers.js`
header comments):

| File | Parser | Disasm | One-liner |
|---|---|---|---|
| `D/VGAM.DAC` | `parsePal` | — | 256 × (R,G,B) 6-bit VGA palette |
| `D/PLAYER.TOS` | `parseSprites24` | — | 4 chars × 8 frames × 24×24 raw |
| `D/POL001.TOS` | `parseSprites24` | — | 80 chars × 8 frames × 24×24 raw |
| `D/ENEMY.TOS` | `parseEnemyTOS` | ATT.LOD 0xbc2a | 300 header slots, variable-size monster sprites |
| `D/SMAPNN.SMP` + `.BIT` + `.HEI` | `buildAtlas` | 0x351B, 0x356E | 1500 tiles × 120 px, collision byte, height/foreground attr |
| `D/SMAPNN.ATS` | `parseATS` | MG2.EXE 0x19c1 | Per-tile biome byte for outdoor maps 1-4 |
| `D/*.PBM` | `decodePBM` | 0x2480 | PackBits full-screen image |
| `D/ME*.DBB` / `MP*.DBB` | — | — | PackBits multi-frame: 50-slot header + body |
| `D/MG2.15` / `M.15` / `ATT.15` / `P.15` | `parseMG215` | 0xA21 | 1000 entries × (u8 count, u16 offset) + 30-byte glyphs |
| `M/*.MAP` | `loadArea` | — | 208×155×u16×2 layers (ground + overlay). Tile `0x07FF` = void |
| `S/INOUT.DAT` | `parseAreas` | 0x2190, 0x22E6 | Per-area triggers + scripts. Target is (Y, X), not (X, Y) |
| `S/POL.DAT` | `parseNPCs` | 0x234E | Per-area NPC list, 20 bytes each |
| `S/GEM.DAT` | `parseTreasures` | 0x84B7 | Per-area pickup list, dispatched by `flag2` high byte |
| `S/SJN.DAT` | `parseSJN` | 0x9699 | Quest-blocker rules (FF80 dispatcher) |
| `S/*.15T` | `parseScript15T` | 0x8840 | Dialog scripts |
| `ATT.LOD` (segment) | `parseATTEncounterPool` | 0xb471 | Encounter pool at DS:0x30de (file 0x111CE) |
| `ATT.LOD` (segment) | `parseATTLevelTable` | 0x1c69 | 70 × u16 EXP thresholds at DS:0x34C6 (file 0x115B6) |
| `MG2.EXE` (segment) | `parseItemTable` | 0x6fbb, 0x4ebd, 0x9c04 | Item stats/mask/price, 410 × 20 B at file 0xDAE3 (ATT.LOD keeps its own copy at its DS:0x6AF) |
| `MG2.EXE` (segment) | `parseInitialState` | 0x1f40 (BACK.DAT writer) | New-game party/gold/inventory image at file 0xD430 + 0xB374 |

## Interactions

- Called by [boot-loop.md](boot-loop.md) during boot for every asset.
- `buildAtlas` also called by [area.md](area.md)'s tileset cache.
- Output tables feed [battle.md](battle.md) (encounter pool, level
  table, enemy stats/sprites), [npc-state.md](npc-state.md) (SJN
  table), [dialog.md](dialog.md) (string tables), and
  [render.md](render.md) (atlases, sprites, PBMs).

## How to Test

Requires game data at `mg2/`; image dumps land in `./dump/*.ppm`.

```sh
python3 mg2tools.py sjn                          # pass = 46 areas / 139 conditions, no traceback
python3 mg2tools.py enemy-sheet                  # pass = dump/enemy_sheet*.ppm written, sprites look sane
python3 mg2tools.py mg215 --file MG2.15 0-30     # pass = readable glyph ASCII art
python3 mg2tools.py pol-patrols                  # pass = per-area NPC list prints
```

- Browser boot (`?skip`) exercises every parser at once — pass = no
  boot error in the loading bar.

## Open Gaps / Roadmap

- `D/ME*.DBB` / `MP*.DBB` multi-frame PackBits format documented but
  not parsed (no gameplay consumer yet).
- `parseATTLevelTable` reads a fixed file offset blind; a corrupted
  ATT.LOD yields garbage thresholds rather than an error.
