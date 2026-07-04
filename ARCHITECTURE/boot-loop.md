# Boot, State Machine & Tick Loop

## Goal

Own process start through "ready" and every frame after: fetch and
parse all game data, wire the subsystem factories together, then run
the 30 Hz fixed-timestep state machine that dispatches input and
rendering per game state. Serves M1 (core gameplay) and M2
(robustness — the tick loop is now exception-proof).

## Status

`done` — boots the full game against original data; M2 hang guards in
place (try/catch RAF wrapper, `.catch` recovery on all async
`ST.TRANS` transitions).

## Code Structure

| File | Role |
| ---- | ---- |
| `src/main.js` | boot orchestrator, game-state owner, state machine, tick loop |
| `src/input.js` | held-keys set + edge-triggered pressed set per tick |
| `src/constants.js` | screen/map/tile geometry, `FPS=30`/`DT`, `loadBin()` fetch helper |
| `index.html` | boot shell: loading bar + `<script type="module" src="./src/main.js">` |

## Key Types and Entry Points

- `src/main.js:27` - `boot()` - single async entry point; runs at module load.
- `src/main.js:132` - `ST` - state enum `{TITLE:0, PLAY:3, OVER:4, TRANS:5, MENU:6, NPC_TALK:7, BATTLE:8, SLOT_PICKER:9, SHOP:10}`.
- `src/main.js:134` - `state` - the shared god-object; `party[]` is source of truth, legacy `state.hp/.atk/…` getters alias `party[0]`.
- `src/main.js:446` - `handleTransition(trig)` - area warp; sets `ST.TRANS`, loads, restores `ST.PLAY`. Callers attach `.catch` recovery (M2).
- `src/main.js:490` - `fireScriptTrigger(sTrig)` - freezes to `ST.TRANS` *before* the async gap so multiple `tickLogic()` calls in one RAF can't walk past the trigger.
- `src/main.js:576` - `tickLogic()` - one 33 ms logic step; per-state input dispatch at `:580` (TITLE), `:617` (PLAY), `:690` (NPC_TALK), `:695` (MENU), `:790` (SLOT_PICKER), `:811` (BATTLE), `:823` (SHOP), `:833` (OVER). `ST.TRANS` deliberately has no branch — input is frozen during transitions.
- `src/main.js:1070` - `tick(now)` - RAF wrapper: try/catch around `tickFrame` with the reschedule *outside* the try, so a data-dependent throw costs one frame, never the game (M2).
- `src/main.js:1082` - `tickFrame(now)` - fixed-timestep accumulator (dt clamped to 200 ms → max 6 logic steps/frame) + per-state render dispatch (`:1094-1158`).
- `src/input.js:1` - `createInput()` - `{keys, pressed, updateKeys}`; `updateKeys()` computes newly-down keys, called first in `tickLogic`.
- `src/constants.js:18` - `loadBin(p)` - fetches `mg2/<path>` as ArrayBuffer; the single I/O primitive.

**Boot order** (`boot()`, order matters): palette → player/NPC/enemy
sprites → enemy stats → ATT.LOD tables + ATS biome maps → areas
(INOUT.DAT) → NPCs (POL.DAT) → treasures (GEM.DAT) → SJN blockers →
four `.15` string tables → door tiles + title/gameover PBMs →
`createCaches` → canvas setup → factories (renderer, battle, shop,
input, npcState) → initial `load(5)` (area D02) → dialog + menu
factories → debug URL params → first `requestAnimationFrame(tick)`
(`src/main.js:1163`).

## Interactions

- Imports every other module; sole composition root (only thing
  `index.html` loads).
- Wires [npc-state.md](npc-state.md) `npcHidden`/`npcPos` into
  [area.md](area.md) `blocked()` and [render.md](render.md) `drawNPCs()`.
- Dispatches per-state input to [battle.md](battle.md) `battleTick`,
  [shop.md](shop.md) `tick`, [dialog.md](dialog.md) `advance/close`,
  [menu.md](menu.md) actions.
- Owns save snapshot/restore, delegating persistence to [save.md](save.md).
- Calls [render.md](render.md) draw functions in the per-state render
  dispatch.

## How to Test

```sh
node --check src/main.js        # pass = exit code 0
python3 -m http.server 8080     # then open the URLs below in a browser
```

- `http://localhost:8080/?skip` - pass = overworld renders, arrows move
  the player, ESC opens the menu.
- `http://localhost:8080/` - pass = title screen; New Game runs the
  TS001 intro cutscene, then hands control to PLAY.
- Walk through a door / area trigger - pass = "Entering …" flash, then
  play resumes in the target area (never a stuck black screen).

## Open Gaps / Roadmap

- `ST.TRANS` recovery paths log to console only; no user-visible error
  toast.
- Legacy `state.hp/.atk` getter aliases remain for older call sites;
  new code should read `state.party[0]` directly.
