# Battle System

## Goal

Random encounters and turn-based combat on a DEDICATED battle screen
(matching ATT.LOD): encounter pool selection, formation placement, the
disasm'd damage formula, EXP/level-up, and the battle UI. Serves M1.

## Status

`done` — the battle now renders on its own screen (AM.TOS backdrop +
SSLLP01 command panel + ATTP hero poses + ENEMY.TOS formation), as
ATT.LOD does, instead of the old "battle in place on the overworld
map" approximation. Combat logic is unchanged.

## Rendering (disasm ATT.LOD 0x185e)

`drawScreen(ctx)` composes, in order:

1. **Backdrop** rows 0-149 — AM.TOS record, id = `AREA_ENEMY[area].enemy`
   (the cs:0xb1ed write, previously thought cosmetic — every value is a
   valid AM.TOS id). `parseAMTOS` in [parsers.md](parsers.md).
2. **Enemies** at fixed screen anchors (formation table ATT.LOD 0xb524,
   bottom-center anchored), left-shifted so nothing clips off-screen.
3. **ATTP hero poses** on the right (party-position table 0x12d), frame
   0 idle / 2 fallen / 11 defend.
4. **SSLLP01 panel** rows 150-199 (buttons baked in) + ATT.15 command
   labels 1-6 (物品/攻撃/魔法/防禦/自動/逃跑) at the baked positions,
   selected in the fire gradient. The magic/item submenus do NOT draw
   into the panel — they open the separate list window at (0,0)
   306×150 (ATT.LOD 0x51d5): 2 cols × 7 rows at (30,8), stride 140/20,
   selection bar + hand, M.15/P.15 names + MP-cost/count digits; grid
   navigation is ↑↓ rows / ←→ columns.
5. **Party status** (name, HP/MP labels ATT.15 10/11, digits, bars) and
   the target hand cursor — M_IP.DAT frame 1, the LEFT-pointing mirror
   of the menu hand, drawn at the enemy's right edge so it points at
   the target (frame 0 points right and is menu-only; MG2.EXE never
   draws frame 1 — it's ATT.LOD's).

Battle assets decode against **VGA.DAC** (+ COLOR.DAT tints), not the
overworld VGAM.DAC — ATT.LOD loads its own palette, so the battle UI
uses a second `createUI` instance ([render.md](render.md)).

## Code Structure

| File | Role |
| ---- | ---- |
| `src/battle.js` | encounter tables, battle state machine, damage/level-up, battle drawing |

## Key Types and Entry Points

- `src/battle.js` - `AREA_ENEMY` - 28-entry dungeon-area table (disasm 0x1aa6-0x1e53); `biomeX` picks the enemy pool row, `enemy` is the AM.TOS **battle backdrop id**.
- `src/battle.js` - `pickEnemy(state, pool, atsMap)` - mirrors ATT.LOD CS:0xb471; final enemy = `encounterPool[group][biome][RNG(0..9)]`.
- `src/battle.js` - `SPELL_LIB` - spell id → effect; also used by save-load rehydration.
- `src/battle.js` - `createBattleSystem(..., itemTable, chrome)` - factory; `chrome` carries the battle UI toolkit + AM.TOS/SSLLP01/ATTP assets. Returns `{tryEncounter, startBattle, battleTick, drawScreen, setInventory, getBattle, reset}`.
- `src/battle.js` - `tryEncounter()` - encounter step-counter model (disasm 0x1893/0x1965/0x1ED3).
- `src/battle.js` - `startBattle(tier, pick)` - picks the backdrop, places 1-N enemies at the formation anchors; no map teleport (the battle is a separate screen).
- `src/battle.js` - `drawScreen(ctx)` - the full dedicated-screen composition (see Rendering above).
- `src/battle.js:421` - `mg2Damage(atk, def, defending)` - the authentic formula (ATT.LOD CS:0x2782 / CS:0x3411).
- `src/battle.js:540` - `checkVictory()` - EXP/gold awards; level-up loop at `:552`.
- `src/battle.js:623` - `battleTick(pressedKey)` - battle mode machine (`intro → select → target/magic/item → execute → anim → done`).
- `src/battle.js:612` - `endBattle()` - restores the overworld snapshot.

**Encounter pool.** MG2.EXE writes `(group, biome)` to
`cs:[0xb1e9]`/`cs:[0xb1eb]`, then chains into ATT.LOD, which picks
`encounterPool[group][biome][RNG(0..9)]`. The enemy id at `cs:[0xb1ed]`
is *never read* for random encounters — biome is what matters. Outdoor
areas 1-4: group 0, biome from the `SMAPNN.ATS` byte at the player's
tile (varies per step). `AREA_ENEMY` areas: group 1, biome from
`biomeX`. Unmapped areas: no random encounters.

**Damage formula** (ATT.LOD CS:0x2782 enemy→party, CS:0x3411
party→enemy):

```
if ATK > DEF:  damage = (ATK - DEF) + random(0..5)
else:          damage = random(0..1)        ; "miss"
if defender defending: damage /= 2
if attacker has ATK-up buff turns: damage += damage/4
```

Struct offsets (ATT.LOD record = MG2.EXE member − 4): `+0x10` = ATK,
`+0x12` = DEF. **Correction (2026-07):** the `+0x30` word previously
documented as a "weapon equipped" flag is the ATK-up *spell buff*
counter (spell 0x3e sets it to rnd 5-7 at ATT 0x2f3a, decremented per
turn at 0x2a50; `dmg += dmg>>2` while nonzero at 0x3486-0x3494).
Weapons contribute damage only through the recomputed ATK stat
(base + item table, [menu.md](menu.md)). Enemy record (ENEMY.DAT,
80-byte stride) `+8` = ATK, `+10` = DEF.

**Level-up** (ATT.LOD 0x1c32 / 0x1d50-0x2091), per member after the
victory screen:

1. Check `exp >= next_threshold`; subtract, `level++`.
2. Re-roll next threshold: `EXP_TABLE[level-1] + RNG(0..(entry >> 8))`
   — the u16 high byte IS the per-level jitter cap. Beyond level 70:
   `0x84D0 + RNG(0..132)`.
3. Grow 7 stats with fixed base + capped RNG (hero values; other slots
   differ slightly):

   | Stat | +0x?? | Growth |
   |---|---|---|
   | maxHp | +0x02 | `6 + RNG(0..3)` — current HP snapped to new max |
   | maxMp | +0x06 | `4 + RNG(0..2)` — current MP snapped to new max |
   | atk   | +0x1C | `2 + RNG(0..3)` |
   | def   | +0x1E | `2 + RNG(0..3)` |
   | spd   | +0x20 | `2 + RNG(0..2)` |
   | mgAtk | +0x22 | `2 + RNG(0..2)` |
   | mgDef | +0x24 | `2 + RNG(0..2)` |

Only the hero (member 0) branch is implemented — MG2 is solo by design.
The 70-entry EXP table comes from [parsers.md](parsers.md)
`parseATTLevelTable`. Combat-stat growth lands on the member's BASE
stats and effective stats are recomputed from base + equipment
(`items.js recomputeStats`, mirroring MG2.EXE 0x6fbb) — so a level-up
never erases or double-counts equip bonuses. Battle consumables read
the real item table: stats[0] = HP restored, stats[1] = MP restored.

## Interactions

- Driven by [boot-loop.md](boot-loop.md): `tryEncounter()` on each PLAY
  step, `battleTick(k)` in `ST.BATTLE`, draw calls in the render
  dispatch (enemies drawn after foreground — see [render.md](render.md)).
- Consumes tables from [parsers.md](parsers.md): encounter pool, level
  table, ENEMY.DAT stats, ENEMY.TOS sprites, ATS biome maps.
- `SPELL_LIB` consumed by [save.md](save.md) rehydration and
  [menu.md](menu.md) field casting.

## How to Test

Requires game data at `mg2/` and a static server.

- `http://localhost:8080/?skip&encounter=2` - pass = battle opens with
  1-3 enemies, commands work, victory/defeat exits cleanly.
- Repeat `?encounter=3` and `?encounter=4` ~10× - pass = **no tab
  freeze** even when multi-enemy groups of large sprites spawn (the M2
  regression check; enemies may visually overlap — that matches the
  original game).
- Walk ~40 steps outdoors (areas 1-4) - pass = a random encounter
  fires; monster matches the local biome pool.

## Open Gaps / Roadmap

- **M3**: level-up re-rolls the random threshold between compare and
  subtract (`src/battle.js:552-553` both call `expForLevel`, which
  rolls fresh RNG) — bounded, but thresholds are inconsistent and can
  cause off-by-a-few EXP carryover.
- Spell effects are engine-defined (`src/battle.js:133` — spell stats
  not yet decoded from MG2.EXE); `ENEMY_NAMES` (`:52`) is a
  hand-labelled partial list.
- Residual sprite overlap after the 60-nudge cap is accepted, not
  resolved horizontally.
