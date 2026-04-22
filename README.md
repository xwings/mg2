# mg2 — a browser engine for the 1996 DOS game

A native HTML5 Canvas port of **MG2** (Dec 1996), a Traditional Chinese
DOS 6.22 RPG. No DOSBox. The engine opens the original binary game files
directly in the browser at load time and runs the game as the
reverse-engineered EXE + ATT.LOD + SJN.DAT + friends would on real
hardware — at 320×200 VGA Mode 13h, 256-color palette, CJK text rendered
from embedded 16×15 glyph bitmaps.

```
python3 -m http.server 8080
open http://localhost:8080/
```

## What works

- VGA palette + all image formats: player & NPC sprites, enemy sprites
  (variable-size from `ENEMY.TOS`), tile atlases, PackBits PBM fullscreens
- Two-layer map rendering with foreground-pass tiles (towers, eaves,
  trees cover the player correctly)
- Random encounters using MG2's real (group, biome) pool from `ATT.LOD`
  data + `SMAP0N.ATS` per-tile biome bytes — no hand-tuning
- Battle system with the authentic damage formula cracked out of
  `ATT.LOD` at CS:0x2782 / 0x3411
- `.15T` script interpreter: opcodes `FF01-FF03` (terminators),
  `FF08/FF09`, `FF10` (conditional), `FF20` (flag), `FF30` (gold),
  `FF50/FF55/FF60/FF65/FF70/FF80-FFE0` — every script in `mg2/S/`
  parses without drift
- Quest blockers: `SJN.DAT` (MG2's FF80 dispatcher) gives every gate
  guard's step-aside / hide rules. Flag changes (FF20 in any dialog)
  re-apply blocker state immediately
- Shops, inns, inventory, equipment, save/load (5 slots in localStorage
  plus JSON export/import), menus

## Not implemented (by design)

- **Audio**. `MUSIC.TOS` (Adlib/SoundBlaster FM) and `VOICE.TOS` (PCM)
  drive the original DSP code. Emulating them in WebAudio is a
  multi-day project on its own; the engine treats audio calls as no-ops.
- **Password entry screen**. The DOS original used this for load/save;
  we provide a slot-based JSON save system instead.

## Project layout

```
index.html              24-line shell — loads src/main.js as a module
src/                    Engine source
  constants.js          Tile sizes, map dims, direction codes, loadBin()
  parsers.js            All binary-format parsers (palette, sprites,
                        maps, INOUT, POL, GEM, ENEMY.DAT, SJN, ATS, …)
  script.js             .15T script parser + interpreter
  area.js               Area loading, tileset/script caches, collision
  render.js             Scene, foreground, HUD, dialog box, menus
  battle.js             Encounter picker + turn-based battle system
  shop.js               Shops + inns
  save.js               5-slot localStorage save + JSON export/import
  menu.js               ESC-menu (items / magic / equip)
  dialog.js             NPC talk + cutscene runner
  itemName.js           Item-name cascade across the four .15 tables
  npcState.js           SJN.DAT-driven quest-blocker engine
  input.js              Keyboard
  main.js               State machine + boot + tick loop
mg2/                    Original DOS game files (NOT included — provide
                        your own legally-obtained copy)
disasm/                 Capstone disassembly of MG2.EXE + ATT.LOD
mg2tools.py             One-stop Python CLI — disasm, format dumpers,
                        .15T smoke test. Image outputs land in ./dump/.
```

## Running

You need a legal copy of the original 1996 MG2 game. The engine fetches
specific binary files directly at load time and crashes if any are
missing. Lay them out under `mg2/` exactly as the DOS original shipped:

### Required files

**At the root** (`mg2/`):

| File | Size | Purpose |
|---|---|---|
| `ATT.LOD` | 74 KB | Battle-overlay executable (MZ). Contains the encounter pool table + damage routines. |

**In `mg2/D/`** (graphics + shared data):

| File | Purpose |
|---|---|
| `VGAM.DAC` | 256-colour VGA palette |
| `PLAYER.TOS` | Hero sprite sheet (4 chars × 8 frames) |
| `POL001.TOS` | NPC sprite catalog (80 chars × 8 frames) |
| `ENEMY.TOS` | Battle-monster sprites (variable size) |
| `MG2.15`, `M.15`, `ATT.15`, `P.15` | 16×15 glyph string tables (UI / spells / weapons / items) |
| `SMAP01.ATS`, `SMAP02.ATS`, `SMAP03.ATS` | Per-tile biome maps for overworld encounters |
| `SMAPDOOR.SMP`, `SMAPDOOR.BIT`, `SMAPDOOR.HEI` | Door tileset (pixels + collision + height attr) |
| `SMAPNN.SMP`, `SMAPNN.BIT`, `SMAPNN.HEI` | 28 area tilesets, loaded on demand as you walk. `NN` = 00..39 (not all numbers used) |
| `STAR01.PBM` | Title screen |
| `GAMEOVER.PBM` | Game-over screen |
| `PBIG01.PBM` | Portrait backdrop |

**In `mg2/S/`** (scenario):

| File | Purpose |
|---|---|
| `INOUT.DAT` | Area definitions, triggers, teleport map |
| `POL.DAT` | NPC placements per area |
| `GEM.DAT` | Treasure / script-trigger placements |
| `ENEMY.DAT` | 300 × 80-byte monster stat records |
| `SJN.DAT` | Quest-blocker rules (FF80 dispatcher) |
| `*.15T` | 60 dialog / cutscene scripts, loaded on demand per area |

**In `mg2/M/`** (maps):

| File | Purpose |
|---|---|
| `*.MAP` | 56 area maps (208 × 155 × u16 × 2 layers), loaded on demand |

Subtree sizes: `D/` ≈ 18 MB, `M/` ≈ 7 MB, `S/` ≈ 3.6 MB, `ATT.LOD`
≈ 76 KB. `MG2.EXE` itself is NOT loaded by the engine (we only reference
it through the pre-generated disasm under `disasm/`); you can omit
it to slim the directory.

### Not used by the engine

The following DOS files from the original release are referenced nowhere
in the engine and can be skipped if you're trimming: `MUSIC.TOS`,
`VOICE.TOS` (audio), `STA.LOD`, `STA1.LOD` (status/password overlays),
`PASSWORD.PBM`, `VGA.DAC` (password-screen palette), `JS3.EXE`,
`SETUP.EXE`, `PLAY.BAT`, all `.DBB` animation banks consumed by
`ATT.LOD` internally, `SAVE.DAT`, `BACK.DAT`, `SETUP.CNF`.

### Start the server

```
python3 -m http.server 8080
open http://localhost:8080/
```

### Debug URL parameters

| Param | Effect |
|---|---|
| `?skip` | Skip title, jump to PLAY |
| `?area=N` | Load area ID N |
| `?x=N&y=N` | Warp player to tile |
| `?triggers` | Overlay trigger tiles (pink = area, cyan = script) |
| `?talk=N` | Force-open NPC N's dialog |
| `?action=enter` | Simulate SPACE at current position |
| `?pickup=N` | Force-pick treasure #N in current area |
| `?encounter=N` | Force a battle at tier N (0–4) |
| `?visited=6,106,107` | Preload visited-areas set (for quest-gated NPCs) |

## Reverse-engineering notes

Every binary format is documented in
[CLAUDE.md](./CLAUDE.md) with the exact disasm addresses its layout was
derived from. All research tooling is unified under one Python CLI at
the project root:

```
python3 mg2tools.py --help         # list subcommands
python3 mg2tools.py disasm         # MG2.EXE → disasm/*.asm
python3 mg2tools.py disasm-attlod  # ATT.LOD → disasm/att_lod.asm
python3 mg2tools.py enemy-sheet    # ENEMY.TOS contact sheet
python3 mg2tools.py sjn            # quest-blocker rule table
python3 mg2tools.py smoke-15t      # parse every .15T
```

Image dumps land in `./dump/` as PPM (convert to PNG with
`magick dump/foo.ppm foo.png`). Text reports print to stdout.

| Subcommand | Output |
|---|---|
| `enemy-sheet` | Contact sheet of every `ENEMY.TOS` frame |
| `enemy-indexed` | Paginated labelled sheets — 50 frames each, pick IDs by eye |
| `enemy-single ID [--scale N]` | One frame at N× scale (default 3×) |
| `pol001-sheet` | 10×8 catalog of the 80 NPC character idle-down frames |
| `pol-patrols` | Survey `POL.DAT` for NPCs whose `(X2,Y2)` differs from `(X,Y)` |
| `mg215 [--file F] [RANGE]` | Render glyph entries from any `.15` table as ASCII |
| `name-tables` | Render probe-range entries of every `.15` as PPM strips |
| `sjn` | Decode `S/SJN.DAT` — the quest-blocker rule table (46 areas, 139 conds) |
| `scan-ops` | Summarise FF10/FF20/FF60/FF65/FF70 across every `.15T` |
| `smoke-15t` | Parse-all-scripts sanity test; fails loud on drift |
| `disasm` | Capstone-disassemble `MG2.EXE` → `disasm/` |
| `disasm-attlod` | Same for `ATT.LOD` (battle overlay) |

Dependencies: standard library only, except `disasm*` which need
`pip install capstone`.

## License

MIT — see [LICENSE](./LICENSE). The **engine code** is MIT-licensed;
the **game files under `mg2/`** are not covered and are not redistributed
with this project.
