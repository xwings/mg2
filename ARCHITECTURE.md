# MG2 Browser Engine — Architecture

Control center for the doc set. Cross-cutting material lives here;
each subsystem is documented once in [`ARCHITECTURE/`](#index) — see
the Index at the bottom. `CLAUDE.md` and `AGENT.md` are symlinks to
this file.

## Mission

A browser engine for MG2 (Dec 1996 DOS RPG). The engine opens the
original binary game files directly — `MG2.EXE`, `ATT.LOD`, sprite
TOSes, `.15T` scripts, maps, palettes — and runs the game natively on
Canvas. No DOSBox, no emulation layer. Every file format is
reverse-engineered from the original disassembly (Capstone x86-16)
rather than guessed.

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

## Target Environment

- Vanilla-JS ES modules on Canvas 2D; no framework, no build step, no
  package manager. Runs in any modern browser.
- Served from a static HTTP server at the repo root
  (`python3 -m http.server 8080` → `http://localhost:8080/`).
- Requires a legally-obtained copy of the original game data under
  `mg2/` (gitignored): `mg2/MG2.EXE` (item table + new-game state are
  parsed out of the executable at boot), `mg2/ATT.LOD`, `mg2/D/`
  (palette, sprites, glyph tables, tilesets, PBMs), `mg2/S/`
  (area/NPC/treasure/quest tables + 60 `.15T` scripts), `mg2/M/`
  (56 `.MAP` files). The engine `fetch()`es these at boot and fails
  loudly if they are missing.
- Research tooling (`mg2tools.py`) is stdlib-only Python 3; only the
  `disasm*` subcommands need `pip install capstone`.

## Workspace Layout

```
index.html       → boot shell; loads src/main.js as an ES module
compare.html     → A/B harness: DOSBox (js-dos) original vs this engine
src/             → 17 ES modules (see Index for the module docs)
mg2tools.py      → Python research/verification CLI for every format
power_saved.json → importable debug save (level-1 hero, 999 everything)
mg2/             → original game data (gitignored, user-provided)
disasm/          → generated disassembly (gitignored)
dump/            → mg2tools.py image output (gitignored)
```

## Boot / Entry Flow

`index.html` loads `src/main.js`, whose `boot()` fetches every binary
with `loadBin()`, hands each to a parser, wires the resulting tables
into the factory constructors (`createBattleSystem`,
`createShopSystem`, …), then starts a 30 Hz fixed-timestep
`requestAnimationFrame` loop. State machine:
`TITLE → PLAY → NPC_TALK | MENU | TRANS | BATTLE | SLOT_PICKER | SHOP → PLAY → OVER`.
Details, exact load order, and per-state dispatch:
[boot-loop.md](ARCHITECTURE/boot-loop.md).

## Roadmap

- **M1 — Core gameplay (done).** Overworld, dialog/cutscenes, random
  encounters with the real monster pools, turn-based battle,
  shops/inns, equipment, 5-slot saves, SJN quest blockers.
- **M2 — Robustness (done, 2026-07).** Fixed the random browser hang:
  bounded the battle-formation de-overlap loop, guarded the RAF tick
  against exceptions killing the loop, added recovery to async
  `ST.TRANS` transitions. See [battle.md](ARCHITECTURE/battle.md) and
  [boot-loop.md](ARCHITECTURE/boot-loop.md).
- **M3 — Remaining decodes (done, 2026-07).** Decoded the real item
  system out of MG2.EXE and replaced every hand-authored stand-in:
  item table (stats/equip-mask/price) at file 0xDAE3, six-slot equip
  with recompute semantics, script-opcode shops (FF01 inn / FF02 item
  / FF03 equip with inline stock), FF80 tile stamps (+ SJN `rawTiles`),
  FFB0 cutscene images, FFD0 quest-item removal, FF50/FF55 party size,
  FFF0 full heal, P.15-only item names, EXP-threshold double-roll fix,
  new-game state parsed from the EXE. See [menu.md](ARCHITECTURE/menu.md),
  [shop.md](ARCHITECTURE/shop.md),
  [script-interpreter.md](ARCHITECTURE/script-interpreter.md).
- **M4 — Fidelity gaps (open).** Companion party members (initial data
  for members 1-3 already parsed; FF50/FF55 recorded but solo-only
  play); the real spell system (ids + MP-cost table at DS:0x4bf are
  known, effects live in ATT.LOD); status conditions / cure items
  (ids 4, 6, 13-18); battle-UI parity with ATT.LOD. Tracked in each
  module's Open Gaps section.

## Key MG2.EXE Variables

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
`cs:[0xb174..0xb24a]` (214 bytes) + `DS:[0x0004..0x04be]` (1210 bytes)
to the file, ATT.LOD reads back into `cs:[0xbe2f..0xbf05]` +
`DS:[0..0x4ba]`. Address delta is `0xCBB` for the cs block (e.g. MG2
`cs:[0xb1eb]` → ATT.LOD `cs:[0xbea6]`) and `−4` for the DS block.
MG2.EXE's DS = `cs:[0x64]` = paragraph 0xD23; DS:0 sits at file offset
0xD430. Key DS structures: party records at DS:0x0004 (4 × 0xA0 bytes,
stats/equipment layout in [menu.md](ARCHITECTURE/menu.md)), inventory
at DS:0x284 (82 × {u16 id, u16 count}), script flags at DS:0x3D8, item
table at DS:0x6B3 (410 × 20 bytes, file 0xDAE3), spell MP costs at
DS:0x4bf.

## Debug URL Parameters

Cross-cutting manual-test aid; most module How-to-Test sections lean on
these.

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

## Contributor Workflows

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
4. Add a one-liner to the format table in
   [parsers.md](ARCHITECTURE/parsers.md).

**Adding a new `.15T` opcode.**

1. Find the handler in `disasm/12_script.asm`.
2. Read `add si, N` at the end to get the stride.
3. Check whether the handler ends with `ret` (terminator) or falls
   through to the dispatcher.
4. Update `OP_STRIDES` + `TERMINATORS` in `src/script.js`; add a case
   in the parse loop if it carries meaningful params; add a case in
   `applyScriptOps` if it mutates game state.
5. Run `python3 mg2tools.py smoke-15t` — no file should hit the
   iteration guard or drift past a cell.

**Adding a new AREA_ENEMY entry.** The 28-entry table was extracted
from `0x1aa6-0x1e53`. If you spot an encounter happening in an area not
listed, the corresponding block in that disasm range is your source of
truth. `biomeX` is the field that matters; `enemy` is a cosmetic
carry-over.

**Disassembly.** `disasm/` — Capstone 16-bit x86, 100% byte coverage of
both executables, split by subsystem; `disasm/index.md` lists all files
with address ranges. Regenerate with `python3 mg2tools.py disasm`
(MG2.EXE) and `python3 mg2tools.py disasm-attlod` (ATT.LOD). See
[tooling.md](ARCHITECTURE/tooling.md).

**Docs.** New modules and changed module/function contracts must update
this file and the relevant `ARCHITECTURE/<module>.md` in the same
change when architecture, ownership, data flow, integration points, or
public behavior are affected.

## Coding Discipline

Behavioral guidelines to reduce common LLM coding mistakes. Merge with
project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For
trivial tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If
yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make
it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs,
fewer rewrites due to overcomplication, and clarifying questions come
before implementation rather than after mistakes.

## Index

- [boot-loop.md](ARCHITECTURE/boot-loop.md) — boot sequence, state machine, fixed-timestep RAF loop, input
- [parsers.md](ARCHITECTURE/parsers.md) — every binary-format decoder + format → disasm map
- [area.md](ARCHITECTURE/area.md) — map/tileset caches, collision, trigger matching
- [script-interpreter.md](ARCHITECTURE/script-interpreter.md) — `.15T` opcode interpreter and side-effect engine
- [dialog.md](ARCHITECTURE/dialog.md) — NPC talk / cutscene page runner + item-name resolution
- [npc-state.md](ARCHITECTURE/npc-state.md) — SJN.DAT quest-blocker engine, NPC visibility
- [battle.md](ARCHITECTURE/battle.md) — encounters, damage formula, level-up, battle UI
- [shop.md](ARCHITECTURE/shop.md) — shops and inns (hand-authored stock tables)
- [menu.md](ARCHITECTURE/menu.md) — ESC-menu actions: use item, cast spell, equip
- [save.md](ARCHITECTURE/save.md) — 5-slot localStorage saves, export/import, restore order
- [render.md](ARCHITECTURE/render.md) — scene/sprite/dialog/menu drawing, `src/ui.js` window+glyph+digit chrome, .HEI passes
- [tooling.md](ARCHITECTURE/tooling.md) — mg2tools.py CLI, compare.html A/B harness, debug save
