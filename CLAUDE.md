# CLAUDE.md — contributor guide

Claude-oriented companion to [README.md](./README.md). The README tells
users how to run the engine; this file tells contributors how it's
wired and what invariants to preserve.

## What this project is

A browser engine for MG2 (Dec 1996 DOS RPG). The engine opens the
original binary game files directly — `MG2.EXE`, `ATT.LOD`, sprite TOSes,
`.15T` scripts, maps, palettes — and runs the game natively on Canvas.
No DOSBox, no emulation layer. Every file format is reverse-engineered
from the original disassembly (Capstone x86-16) rather than guessed.

## Scope

**In scope.** Everything needed to reach the authentic MG2 gameplay:
overworld, dialog/cutscene interpreter, random encounters with the real
monster pools, turn-based battle with the disasm'd damage formula,
shops/inns, equipment, saves, quest-flag-driven NPC blockers.

**Out of scope.**
- **Audio** (`MUSIC.TOS` FM synth, `VOICE.TOS` PCM). Days of WebAudio
  work for zero gameplay impact. References at MG2.EXE `0x110EE` /
  `0x110FC` are treated as no-ops.
- **Password entry screen**. Uses `VGA.DAC` + a separate render path.
  Replaced by our 5-slot JSON save system.

## Architecture

```
index.html     → src/main.js     (boot, tick loop, input dispatch)
                 ├─ parsers.js   (every binary-format decoder)
                 ├─ area.js      (map + tileset cache, collision)
                 ├─ script.js    (.15T interpreter)
                 ├─ npcState.js  (SJN.DAT quest-blocker engine)
                 ├─ dialog.js    (NPC talk + cutscene runner)
                 ├─ menu.js      (ESC-menu actions)
                 ├─ itemName.js  (4-table .15 cascade)
                 ├─ battle.js    (encounter picker + turn loop)
                 ├─ shop.js      (shops + inns)
                 ├─ save.js      (localStorage + JSON I/O)
                 └─ render.js    (scene, HUD, dialog, menus)
```

**State machine.** `TITLE → PLAY → NPC_TALK | MENU | TRANS | BATTLE |
SLOT_PICKER | SHOP → PLAY → OVER`.

**Boot order.** `main.js` fetches each binary with `loadBin()`, hands it
to a parser, then wires the resulting tables into the factory
constructors (`createBattleSystem`, `createShopSystem`, etc). The tick
loop runs at 30 Hz off `requestAnimationFrame`.

## Binary formats (quick reference)

Details live in `src/parsers.js` comments. This table is a map from
format → disasm anchor.

| File | Parser | Disasm | One-liner |
|---|---|---|---|
| `D/VGAM.DAC` | `parsePal` | — | 256 × (R,G,B) 6-bit VGA palette |
| `D/PLAYER.TOS` | `parseSprites24` | — | 4 chars × 8 frames × 24×24 raw |
| `D/POL001.TOS` | `parseSprites24` | — | 80 chars × 8 frames × 24×24 raw |
| `D/ENEMY.TOS` | `parseEnemyTOS` | ATT.LOD 0xbc2a | 300 header slots, variable-size monster sprites. Header word order is BIG-endian (`offset = (w0<<16)\|w1`) |
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
| `ATT.LOD` (segment) | `parseATTEncounterPool` | 0xb471 | Encounter pool baked into ATT.LOD data seg at `0x30de` (file 0x111CE): 2 groups × 25 biomes × 10 enemy ids |
| `ATT.LOD` (segment) | `parseATTLevelTable` | 0x1c69 | 70 × u16 EXP thresholds at DS:0x34C6 (file 0x115B6). High byte of each entry = RNG jitter cap |

## Mechanics (the non-obvious bits)

**NPC visibility & quest blockers.** MG2.EXE NEVER reads quest flags
during NPC render — the flag array at `[bx+0x3D8]` is only read by the
script interpreter. Blockers disappear because `FF60` / `FF65` writes
their coords past the map edge (Y ≥ 155 puts them off-screen), OR
because SJN.DAT's FF80 dispatcher rewrites their position when the flag
flips. The complete SJN rule set (46 areas, 139 conditions) lives
inline in `S/SJN.DAT`; `npcState.js` replays it on area enter, after
every `applyScriptOps`, and on save load.

**Encounter pool.** `MG2.EXE` writes `(group, biome)` to
`cs:[0xb1e9]` / `cs:[0xb1eb]`, then chains into `ATT.LOD`. ATT.LOD picks
`encounterPool[group][biome][RNG(0..9)]` and that's the final
`ENEMY.DAT` record id. The enemy_id written to `cs:[0xb1ed]` is *never
read* by ATT.LOD for random encounters — biome is what matters.

- Outdoor areas 1-4: group 0, biome from `SMAPNN.ATS` byte at the
  player's current tile. Varies per step.
- AREA_ENEMY table (in `battle.js`, 28 entries, extracted from
  `0x1aa6-0x1e53`): group 1, biome from the table's `biomeX` field.
- Unmapped areas: no random encounters.

**Damage formula** (ATT.LOD CS:0x2782 enemy→party, CS:0x3411
party→enemy):

```
if ATK > DEF:  damage = (ATK - DEF) + random(0..5)
else:          damage = random(0..1)        ; "miss"
if defender defending: damage /= 2
if attacker is party + weapon equipped: damage += damage/4
```

Struct offsets: party record `+0x10` = ATK, `+0x12` = DEF, `+0x30` =
weapon flag. Enemy record (ENEMY.DAT, 80-byte stride) `+8` = ATK,
`+10` = DEF. `mg2Damage()` in `battle.js` mirrors this.

**Level-up** (ATT.LOD 0x1c32 / 0x1d50-0x2091). Runs per party member
after the victory screen is dismissed:

1. Check `member.exp >= member.next_threshold`.
2. `exp -= threshold`; `level++`.
3. Re-roll next_threshold: `EXP_TABLE[level-1] + RNG(0..(table_value >> 8))`
   — the high byte of the u16 table entry IS the per-level jitter cap.
   Beyond level 70 the code hard-codes `0x84D0 + RNG(0..132)`.
4. Grow 7 stats with a fixed base + capped RNG (values shown for the
   hero, member 0; other slots use slightly different RNG ceilings):

   | Stat | +0x?? | Growth |
   |---|---|---|
   | maxHp | +0x02 | `6 + RNG(0..3)` — current HP snapped to new max |
   | maxMp | +0x06 | `4 + RNG(0..2)` — current MP snapped to new max |
   | atk   | +0x1C | `2 + RNG(0..3)` |
   | def   | +0x1E | `2 + RNG(0..3)` |
   | spd   | +0x20 | `2 + RNG(0..2)` |
   | mgAtk | +0x22 | `2 + RNG(0..2)` |
   | mgDef | +0x24 | `2 + RNG(0..2)` |

The 70-entry EXP table lives in ATT.LOD's data segment at file offset
`0x115B6` (DS:0x34C6); `parseATTLevelTable()` in `parsers.js` extracts it.
Only the party-member-0 (hero) branch is implemented in our engine since
MG2 is solo by design.

**.15T script opcodes.** 22 opcodes total (see `src/script.js`
`OP_STRIDES`). Each has a verified stride from the disasm handler's
`add si, N` at the end. Terminators end the handler with `ret` instead;
the interpreter page-flushes and breaks on those. `FFE0` (scene
refresh) is the most common (283 uses across all scripts) and earlier
versions of this engine had it at the wrong stride — if a cutscene ever
prints garbled glyphs, check opcode strides first.

**Foreground tiles.** The per-tile `.HEI` byte controls render order:

| `.HEI` | Pass (disasm 0x356E) | Meaning |
|---|---|---|
| 0 | ground | drawn before sprites |
| 1 | A | foreground at natural row |
| 2 | B | top of 2-tile-tall object (drawn from row+1) |
| 3 | C | top of 3-tile-tall object (drawn from row+2) |
| 4 | D (0x340A) | background overlay, drawn BEFORE sprites |

The trailing bytes in `.SMP` are NOT the foreground attr — that's `.HEI`.
Getting this wrong causes the player to render *on top* of towers,
castle walls, and tree crowns.

## Key MG2.EXE variables

| Offset | Purpose |
|---|---|
| `cs:0x9d` | Encounter step counter (1-40 buckets into 5 tiers) |
| `cs:0x3a2a` | Battle-enabled flag (INOUT.DAT byte [10]) |
| `cs:0xb1a3` | Player X (tile) |
| `cs:0xb1b3` | Player Y (tile) |
| `cs:0xb1cd` | Current area ID |
| `cs:0xb1d1` | Gold (u32) |
| `cs:0xb1e9` | Encounter group (0 outdoor, 1 dungeon) |
| `cs:0xb1eb` | Encounter biome (0-24) |
| `cs:0xb1ed` | Encounter enemy id (written, not read by ATT.LOD) |

MG2.EXE ↔ ATT.LOD handoff goes through `S/BACK.DAT`: MG2.EXE writes
`cs:[0xb174..0xb24a]` (214 bytes) + `cs:[0x0004..0x04be]` (1210 bytes)
to the file, ATT.LOD reads back into `cs:[0xbe2f..0xbf05]` + `DS:[0..0x4ba]`.
Address delta is `0xCBB`, e.g. MG2 `cs:[0xb1eb]` → ATT.LOD
`cs:[0xbea6]`.

## Contributor notes

**Comment style.** Comments explain *why*, not *what*. If you're about
to write a comment that narrates what the code is doing, the code
probably needs a better name instead. Keep disasm references terse
(`disasm 0x8840`) and put them where the non-obvious invariant lives.

**Adding a new binary format.**
1. Add a `parseFoo(buf)` to `src/parsers.js` with a disasm reference in
   the header comment.
2. Load it in `main.js` during boot.
3. Pass it to whichever factory constructor (`createBattleSystem` etc.)
   needs it, or expose via a new factory in its own module.
4. Add a one-liner to the format table above.

**Adding a new `.15T` opcode.**
1. Find the handler in `disasm/12_script.asm`.
2. Read `add si, N` at the end to get the stride.
3. Check whether the handler ends with `ret` (terminator) or falls
   through to the dispatcher.
4. Update `OP_STRIDES` + `TERMINATORS` in `src/script.js`; add a case in
   the parse loop if it carries meaningful params; add a case in
   `applyScriptOps` if it mutates game state.
5. Run `python3 mg2tools.py smoke-15t` — no file should hit the
   iteration guard or drift past a cell.

**Adding a new AREA_ENEMY entry.** The 28-entry table was extracted from
`0x1aa6-0x1e53`. If you spot an encounter happening in an area not
listed, the corresponding block in that disasm range is your source of
truth. `biomeX` is the field that matters; `enemy` is a cosmetic
carry-over.

## Disassembly

`disasm/` — Capstone 16-bit x86, 100% byte coverage of both
executables, split by subsystem. `index.md` lists all files with
address ranges.

Regenerate:
```bash
python3 mg2tools.py disasm         # MG2.EXE
python3 mg2tools.py disasm-attlod  # ATT.LOD
```

## Research tooling

`mg2tools.py` at the project root is one Python CLI for every binary
format and both disassemblies. Use it to poke at any format without
writing new code:

```bash
python3 mg2tools.py --help         # list subcommands
python3 mg2tools.py sjn            # decode quest-blocker table
python3 mg2tools.py scan-ops       # which .15T writes which flag
python3 mg2tools.py enemy-single 122 --scale 5  # zoom a sprite
```

Image dumps → `./dump/*.ppm`. Text reports → stdout.
See [README.md](./README.md#reverse-engineering-notes) for the full
subcommand table.

## Debug URL parameters

| Param | Effect |
|---|---|
| `?skip` | Skip title, jump to PLAY |
| `?area=N` | Load area ID N |
| `?x=N&y=N` | Warp player to tile |
| `?triggers` | Overlay trigger tiles (pink = area, cyan = script) |
| `?talk=N` | Force-open NPC N's dialog |
| `?action=enter` | Simulate SPACE at current position |
| `?pickup=N` | Force-pick treasure #N in current area |
| `?encounter=N` | Force a battle at tier N (0-4) |
| `?visited=6,106,107` | Preload visited-areas set (for quest-gated NPCs) |
