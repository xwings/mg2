# Research Tooling & Verification Harnesses

## Goal

Infrastructure: one Python CLI (`mg2tools.py`) for poking at every
binary format and regenerating both disassemblies, plus the browser
A/B harness and a debug save. This is the provenance pipeline behind
every `disasm 0x…` reference in the JS sources.

## Status

`done`

## Code Structure

| File | Role |
| ---- | ---- |
| `mg2tools.py` | stdlib-only CLI: dumpers, decoders, smoke test, Capstone disasm |
| `compare.html` | side-by-side: original game in DOSBox (js-dos v8, `mg2.jsdos`) vs this engine in an iframe |
| `power_saved.json` | importable debug save: level-1 hero, 999 gold/HP/MP/atk/def/exp, area 7 |

## Key Types and Entry Points

- `mg2tools.py:1062` - `build_parser()` - argparse dispatcher; `main()` at `:1114` runs `args.func(args)`.
- `mg2tools.py:753` - `cmd_smoke_15t` - **the** parse-all sanity test: parses + interprets every `.15T`, prints per-file `FAIL` lines and `hardFail/softFail` totals. Note: reports on stdout; exit code is always 0.
- `mg2tools.py:422` - `cmd_sjn` - decode the S/SJN.DAT quest-blocker table.
- `mg2tools.py:673` - `cmd_scan_ops` - which `.15T` writes which flag (FF10/FF20/FF60/FF65/FF70).
- `mg2tools.py:929` - `cmd_disasm` - Capstone disasm of MG2.EXE → `disasm/`; `:1004` `cmd_disasm_attlod` → `disasm/att_lod.asm`. Only these two need `pip install capstone`.
- Sprite/table dumpers: `enemy-sheet` (`:131`), `enemy-indexed` (`:178`), `enemy-single ID --scale N` (`:218`), `pol001-sheet` (`:250`), `pol-patrols` (`:288`), `mg215` (`:341`), `name-tables` (`:372`).

All subcommands read from `mg2/` (hardcoded at `mg2tools.py:33`);
image dumps go to `./dump/*.ppm`, text reports to stdout.

## Interactions

- `smoke-15t` is the gate for
  [script-interpreter.md](script-interpreter.md) changes (mirrors its
  parser/interpreter in Python).
- `sjn` validates the table [npc-state.md](npc-state.md) replays;
  `enemy-*`/`pol001-sheet`/`mg215` validate
  [parsers.md](parsers.md) decoders visually.
- `disasm`/`disasm-attlod` regenerate the ground truth every module's
  disasm anchors point into.
- `compare.html` A/B-checks [render.md](render.md) and gameplay
  fidelity against the real executable (needs the gitignored
  `mg2.jsdos` bundle).

## How to Test

```sh
python3 mg2tools.py --help      # pass = subcommand list, exit 0 (no game data needed)
python3 mg2tools.py smoke-15t   # pass = "Parsed 60 files, hardFail=0, softFail=0"
python3 mg2tools.py enemy-single 122 --scale 5   # pass = dump/*.ppm written
```

- `http://localhost:8080/compare.html` - pass = DOSBox original (left)
  and engine (right) boot side by side (requires `mg2.jsdos`).

## Open Gaps / Roadmap

- `smoke-15t` always exits 0 — CI-style use would need the fail counts
  wired to the exit code.
- No automated test suite; verification is smoke-15t + debug URL
  params + visual A/B by design (documented per module).
