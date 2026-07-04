# .15T Script Interpreter

## Goal

Replicate MG2.EXE's dialog-script bytecode engine (disasm 0x8840
dispatcher): parse `.15T` files, run entries into glyph pages plus
side-effect op lists, and apply the state-mutating opcodes (flags, NPC
teleports, gold, walks). Serves M1 — every dialog, cutscene, notice
board, and quest-flag write flows through here.

## Status

`done` for the implemented opcode set (22 opcodes with disasm-verified
strides). Opcodes FF80 / FFB0 / FFD0 are captured but not acted on
(M3); sound ops are captured no-ops (audio is out of scope).

## Code Structure

| File | Role |
| ---- | ---- |
| `src/script.js` | opcode table, parser, interpreter, side-effect applier |

## Key Types and Entry Points

- `src/script.js:10` - `OP_STRIDES` - opcode → param stride, each verified from the disasm handler's trailing `add si, N`; terminators end with `ret` instead and the interpreter page-flushes and breaks on them.
- `src/script.js:38` - `parseScript15T(buf)` - stride-6 entry header parser (≤200 entries).
- `src/script.js:78` - `lookupStride60(script, id, flags)` - stride-60 conditional dispatch; sub-entry 0 is a flag-check table; returns null = "skip".
- `src/script.js:125` - `runScript15T(script, idx)` - interpreter core → `{pages, effects, ops}`; the walk loop (`:133`) has a 20 000-iteration guard and unknown `0xFFxx` opcodes advance by `OP_STRIDES[w] || 2`, so the PC always moves.
- `src/script.js:120` - `runScript15Tat(script, off, size)` - run an arbitrary body (stride-60 dispatch target).
- `src/script.js:305` - `applyScriptOps(ops, pageIdx, ctx)` - per-page side effects: FF60 NPC teleport/spawn, FF65 field write, FF20 flag set, FF30 gold, FF70 NPC/player walk, FF10 conditional flag.
- `src/script.js:384` - `parseCutscene15T(buf)` - headerless fallback for TS001-style files.

Stride discipline: `FFE0` (scene refresh) is the most common opcode
(283 uses); a wrong stride there historically garbled cutscene glyphs —
if a cutscene ever prints garbage, check opcode strides first.

## Interactions

- Called by [dialog.md](dialog.md) (`runScript15T`, `applyScriptOps`),
  [area.md](area.md) (parse functions in the script cache),
  [boot-loop.md](boot-loop.md) (`lookupStride60`/`runScript15Tat` in
  `fireScriptTrigger`), and [dialog.md](dialog.md)'s item-name fallback.
- FF20 flag writes trigger [npc-state.md](npc-state.md) `reapplySJN`
  via the dialog page callback.

## How to Test

```sh
python3 mg2tools.py smoke-15t   # pass = "Parsed 60 files, hardFail=0, softFail=0"
python3 mg2tools.py scan-ops    # pass = opcode/flag usage report, no traceback
```

- Browser: New Game from the title - pass = TS001 intro cutscene plays
  with readable glyphs (garbled glyphs = stride bug).
- `?skip&talk=N` - pass = NPC dialog pages render and advance.

## Open Gaps / Roadmap

- **M3**: FF80 function undecoded (`src/script.js:225`); FFB0
  sub-script loading captured only (`:246`); FFD0 effect undecoded
  (`:256`).
- **M3**: FF10's enemy-trigger side effect deferred to a future combat
  rewrite (`src/script.js:375`).
