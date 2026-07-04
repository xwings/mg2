# Battle System

## Goal

Random encounters and turn-based combat, played "in place" on the
overworld map: encounter pool selection, formation placement, the
disasm'd damage formula, EXP/level-up, and the battle UI. Serves M1;
the M2 hang fix (bounded de-overlap) lives here.

## Status

`done` — M2 fix applied: the enemy de-overlap pass is capped at 60
nudges per enemy (`src/battle.js:321`), eliminating the random
full-tab freeze on multi-enemy encounters with large sprites.

## Code Structure

| File | Role |
| ---- | ---- |
| `src/battle.js` | encounter tables, battle state machine, damage/level-up, battle drawing |

## Key Types and Entry Points

- `src/battle.js:10` - `AREA_ENEMY` - 28-entry dungeon-area table (extracted from disasm 0x1aa6-0x1e53); `biomeX` is the field that matters, `enemy` is cosmetic.
- `src/battle.js:96` - `pickEnemy(state, pool, atsMap)` - mirrors ATT.LOD CS:0xb471; final enemy = `encounterPool[group][biome][RNG(0..9)]`.
- `src/battle.js:135` - `SPELL_LIB` - spell id → effect; also used by save-load rehydration.
- `src/battle.js:198` - `createBattleSystem(...)` - factory; returns `{tryEncounter, startBattle, battleTick, drawBattle, drawBattleEnemies, setInventory, getBattle, reset}`.
- `src/battle.js:212` - `tryEncounter()` - encounter step-counter model (disasm 0x1893/0x1965/0x1ED3).
- `src/battle.js:242` - `startBattle(tier, pick)` - "battle in the air": snapshots the overworld position, teleports the hero to a fixed stance, spawns 1-3 enemies; de-overlap pass at `:312-336`.
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
if attacker is party + weapon equipped: damage += damage/4
```

Struct offsets: party record `+0x10` = ATK, `+0x12` = DEF, `+0x30` =
weapon flag. Enemy record (ENEMY.DAT, 80-byte stride) `+8` = ATK,
`+10` = DEF.

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
`parseATTLevelTable`.

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
