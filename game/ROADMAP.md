# Skyhold — Development Roadmap

Working plan for the endless survival shooter in `game/`. Priorities are ordered by
**player impact per unit of risk**, not by what is most fun to build.

---

## 1. Where the game stands

Verified against the current source, not from memory.

| Area | Current state |
| --- | --- |
| Core loop | Endless continuous spawns; no waves, no win state. `game.js:240` |
| Difficulty | Threat +1 every 30 s; health/speed/damage scale `1 + (threat-1)*0.22` |
| Pressure valve | `MAX_ALIVE = 40`, spawn floor `0.3 s` (`spawnDelay`) |
| Boss | One siege carrier type, re-spawned every 4th threat |
| Player growth | 15 upgrades, each with a cap (repair is repeatable but conditional); five are weapons |
| Weapons | **Six**: blaster, Nova pulse, Orbital drone, Cryo lance, Rad lance, Singularity |
| Rendering | Native Canvas 2D; backing store sized to CSS width × DPR, drawn in a 480×680 logical space |
| Audio | WebAudio oscillator synth only; sound and auto-fire persist locally |
| Persistence | Best score plus settings (`skyhold-survivor-best`, `skyhold-survivor-settings`) |
| Install | Web manifest + SVG icons + service worker (offline shell) |
| Tests | 33 passing, `node --test game/game.test.cjs` |
| Size | ~560 lines JS, ~35 KB, zero dependencies, no build step |

### Constraints to protect

- **No build step.** Open `index.html` and it runs. This is the project's main asset.
- **Zero runtime dependencies.** No engine, no framework, no bundler.
- **Static hosting.** GitHub Pages, no server, no accounts, no backend.
- **`node --test` stays the gate.** Every behaviour change ships with a test.

### Known gaps (measured, not guessed)

- ~~**Not retina-crisp.**~~ Fixed: backing store now tracks CSS width × `devicePixelRatio`.
- ~~**Not discoverable.**~~ Fixed: `/game/` is in `sitemap.xml`.
- ~~**Not installable.**~~ Fixed: manifest, SVG icons, and an offline service worker ship.
- **No retention hook.** Runs are ephemeral; nothing unlocks, no daily seed, no history.
- **Thin enemy vocabulary.** One movement pattern (sine sway), one boss behaviour.
- **Two of five planned weapons.** Nova, orbit, cryo, rad, and gravity exist; mines, homing, and evolutions do not.
- **Upgrade pool is not categorised — investigated and rejected.** Splitting the pool was
  tried three ways (hard weapon guarantee, guarantee-until-3-weapons, weighted weapons).
  All measured worse or equal for survival: 44/100 for the plain pool versus 29/100 and
  26/100 for the guaranteed and weighted variants across two independent 50-seed families.
  A plain pool already offers every weapon by level 3–5 in ~95% of runs, so the premise
  that weapons were undiscoverable was wrong. The uniform pool is kept deliberately; see
  the comment above `pickChoices` in `game.js`.
- **Balance unproven.** Tests stop at 300 s; no data on where real runs end.
- ~~**Legacy naming.**~~ Fixed: threat lives in `#threat` / `#hostiles`.
- ~~**Small hot-path waste.**~~ Fixed: `aliveCount()` replaces repeated `filter().length`.

---

## 2. Weapon system (the Vampire Survivors model)

The biggest single gap against the reference genre. This section is a design, not a
wish list — it is the prerequisite for Phase 1.6 and Phase 2.1 to mean anything.

### What the current code does, and why it blocks us

`firePilot` and `fireVolley` (`game.js:173–197`) are a single hard-coded pipeline:
one cooldown (`pilot.cooldown`), one angle, one bullet constructor. Upgrades mutate
that pipeline in place (`multishot` and `burst` change the loop count, `damage` scales
the number, `frost`/`blast`/`pierce` set flags on the bullet). Adding a second weapon
means `if (weapon === 'laser')` branches inside a function that already owns the
blaster's timing.

### Target model

Treat every weapon as data plus a small `fire` function, and let the loop drive them
independently:

```
state.weapons = [
  { id: 'blaster', level: 1, cooldown: 0, ... },
  { id: 'orbit',   level: 1, cooldown: 0, ... },
]
```

Each tick, for every weapon: decrement its cooldown, and if ready call its `fire`.
The player's `angle` becomes a per-weapon concern. `firePilot` collapses into the
blaster's own `fire`.

Proposed registry shape, kept as plain objects so it stays dependency-free:

| Field | Purpose |
| --- | --- |
| `id`, `name`, `icon` | Card and loadout display |
| `max` | Rank cap |
| `cooldown(level)` | Seconds between activations — this is what creates build variety |
| `fire(state, weapon)` | Mutates the world: pushes bullets, effects, or applies damage |
| `evolve` | Optional id of the evolved form, unlocked at max rank |

### What the reference genre actually does (verified)

Checked against the Vampire Survivors wiki, so the spec copies real mechanics rather
than vibes:

- **6 active weapon slots and 6 passive slots.** The cap is what makes picks exclusionary.
- **Fully leveled weapons stop appearing** in level-up options.
- **Taking a weapon rank resets its cooldown and fires it immediately** — worth copying,
  it makes upgrades feel instant.
- **Rarity weights** decide how often an item appears in the pool.
- **Evolution = max-level base weapon + its paired passive + a chest reward.** The base
  weapon is removed and the evolved weapon added; the passive stays. Evolutions are
  typically single-level, and their cooldown restarts from zero.
- The game distinguishes **Evolution** (weapon+passive → stronger weapon), **Union**
  (two or more weapons merge, freeing a slot), **Gift** (bonus item, base kept), and
  **Morph** (character-specific). Only Evolution is worth copying at our size.
- Weapon archetypes in the base roster map cleanly onto small-game primitives:
  aimed projectile (Magic Wand, Knife, Fire Wand), orbiting/area (King Bible, Garlic),
  ground hazard (Santa Water), boomerang/bounce (Cross, Runetracer), random strike
  (Lightning Ring), screen wipe (Pentagram).

Source: [Weapons](https://vampire.survivors.wiki/w/Weapons),
[Evolution](https://vampire.survivors.wiki/w/Evolution),
[Passive items](https://vampire.survivors.wiki/w/Passive_items).

### Proposed weapon roster

Five base weapons mapped onto archetypes we can actually build with Canvas primitives
and the existing `hit()` path.

| # | Base weapon | Archetype | Behaviour | Cost |
| --- | --- | --- | --- | --- |
| W1 | **Blaster** (existing) | aimed projectile | 1 Hz aimed burst, 1×1 → 3×3 | refactor only |
| W2 | **Orbital drone** | orbiting/area | Circles the pilot, damages on contact, ignores aiming | S |
| W3 | **Nova pulse** | area burst | Radial ring with no aiming, short cooldown | S |
| W4 | **Mines** | ground hazard | Drops stationary charges behind the player | M |
| W5 | **Homing missiles** | tracking projectile | Slow tracking shots; rewards not aiming | M |

**Evolutions** pair each base weapon with one existing passive, so no new passive
system is needed:

| Base | Evolution | Requires | Effect |
| --- | --- | --- | --- |
| W1 Blaster | **Arc laser** | `pierce` | Continuous beam along the aim line |
| W2 Orbital drone | **Twin orbit** | `speed` | Second drone, opposite phase |
| W3 Nova pulse | **Supernova** | `aura` | Larger ring leaving a burning ground patch |
| W4 Mines | **Cluster mines** | `blast` | Each trigger scatters sub-charges |
| W5 Homing missiles | **Swarm missiles** | `multishot` | Launches a volley |

W2 and W3 are the cheapest firsts: both reuse the existing aura/effect drawing path
(`game.js:284`, `game.js:391`) and need no new aim logic. W1's evolution is cheapest to
prototype because the blaster's firing path already exists.

> Passive pairings above are design proposals, not copied from the reference game. The
> reference pairings (e.g. Whip + Hollow Heart → Bloody Tear) are illustrative only.

### Refactor contract — what must not change

This is the load-bearing section. The two exploration passes found specific
constraints that a naive registry refactor breaks silently.

**1. The test anchor.** `game.test.cjs:26` asserts the literal string
`reset(); requestAnimationFrame(frame);` exists in `game.js`. It is `game.js:461`, the
final statement of the IIFE. Moving bootstrap into an `init()` or adding a statement
after it fails all 19 tests at `game.test.cjs:27`.

**2. The export contract.** `game.test.cjs:29-31` exposes internals by name. `firePilot`
and `shotPattern` must keep their names and observable semantics, because tests reach
firing only through them (`game.test.cjs:88`, `184`, `232`, `243`, `259`) and assert
`shotPattern()` (`game.test.cjs:234`).

**3. Weapon ticks must run before the bullet loop.** `fireVolley` is called at
`game.js:177` and `game.js:270`, both before bullet integration at `game.js:308-309`.
`game.test.cjs:214` identifies fresh bullets by `life === 2 - 1/60`, so firing after
integration moves new bullets by `vx*dt` and breaks the assertion. Insert the
per-weapon loop at `game.js:266-278`, never later.

**4. Preserve cooldown epsilon symmetry.** `game.js:173` uses `> 1e-9` and `game.js:275`
uses `<= 1e-9`. Keep both, keep them equal, and keep `Math.max(0, …)` at `game.js:266`.
Asymmetric epsilons create a frame where a weapon can neither fire nor be ready, and
`game.test.cjs:174` asserts exact 1-second spacing.

**5. `state.build` stays a flat id→rank map.** Tests wholesale-replace it
(`game.test.cjs:182`, `208`, `230`, `241`, `258`) and `renderLoadout` indexes
`upgrades[id]` (`game.js:88-99`). Do not nest weapon state under `build`.

**6. The 300-second survival test will hang on an unknown upgrade id.**
`game.test.cjs:270-273` uses a hard-coded `priority` array and calls
`priority.find(...)`, which returns `undefined` for an unlisted id. `chooseUpgrade(undefined)`
bails at `game.js:135`, the phase stays `'upgrade'`, the loop never finishes. Adding a
weapon id requires adding it to that array in the same commit.

**7. RNG order is a determinism contract.** `burst()` (3 calls per particle), `spawnType`,
`spawn`, and the upgrade shuffle share one `Math.random()` stream. A weapon that kills
an enemy at a different point in the frame reshuffles every downstream spawn roll.
`game.test.cjs:267-281` is a seeded 300-second determinism test over that ordering.

**8. All damage must go through `hit()`.** It owns the `enemy.hp <= 0` guard
(`game.js:206`) that prevents double XP and kill credit, plus score, particles, XP
popup, and `updateUI`. A beam or drone that decrements `hp` directly silently loses all
of it — `game.test.cjs:43-47` locks that guard.

**9. Keep one shared `state.bullets` array.** Hostile bullets live in it too
(`game.js:296-297`) and `game.test.cjs:88`, `171`, `185` read it directly. Give bullets
a `weaponId` field instead of per-weapon arrays.

**10. `enemySpeedFactor` must stay enemy-pure.** `chillFactor` is read by both the
blaster's lead prediction (`game.js:184`) and all enemy movement (`game.js:290`). Making
frost weapon-scoped would make aim prediction diverge from actual movement.

**11. The effect union is untagged.** `game.js:390` branches on `effect.xp`; the `else`
reads `effect.radius` and `effect.life/.4` unconditionally. A new effect without either
field draws NaN arcs. Reuse the `{x, y, radius, life: .4}` shape or tag the union.

**12. Two strings are frozen in tests.** `#shot-total` is asserted verbatim at
`game.test.cjs:224` and produced at `game.js:80`; `#rate-stat` is the literal `'1 Hz'`
at `game.js:81`, asserted at `game.test.cjs:175` and `225`. Keep both pinned to the
primary weapon, or update the tests together.

### Status effects: Cryo, Rad, Gravity — **shipped**

Three weapons that needed **new damage and movement primitives**, not just new bullet
colours. All three are implemented; this section records the design and the two
constraints that shaped it.

**Constraint discovered in analysis:** `enemy.x` is not free. It is recomputed every
frame as `originX + sin(time) * sway`. Horizontal force (gravity) is therefore applied as
a decaying `driftX` offset folded into the position update, never as a direct `x` write.

**Constraint 2:** `hit()` sets `enemy.flash = .09`. Damage-over-time routed through
`hit()` every frame leaves enemies permanently white. `damageOverTime()` is a separate
path that skips flash and slow but shares the death bookkeeping via `killEnemy()`.

**Bug found in live testing:** the first Cryo implementation froze enemies permanently,
so the field clogged with unkillable statues (observed: kills stalled at 19 for 6 s with
17 hostiles on screen). Fixed by arming a `freezeTimer` on freeze so a statue breaks on
its own after 0.9 s as well as on any hit. Guarded by a regression test.

#### Cryo lance (`cryo`)

**Fantasy:** slows enemies progressively; at full freeze they become immobile ice
statues; the next hit *shatters* them for burst damage that scales with missing HP.

- Applies `enemy.chill` (0→1). Each tick of contact adds chill; chill decays slowly.
- Speed factor scales `1 → 0` as chill rises, so movement slows smoothly to a stop.
- At `chill >= 1` the enemy is **frozen**: forward motion stops entirely, and it is
  marked so the next damage of any source shatters it.
- Shatter deals `base + (maxHp - hp) * factor` — finishing blows are worth much more.
- **Only the shatter kills.** Chip damage from Cryo itself is zero; it is a setup weapon.
  Bosses resist: chill caps at 0.6 and they never freeze, only slow.

#### Rad lance (`rad`)

**Fantasy:** applies stacking radiation; damage over time only, never direct hits.

- Applies `enemy.rad` stacks. Damage per second is `stacks * perStack`.
- **Stackable and capped**, with each stack expiring after a duration, so the weapon
  rewards sustained fire rather than burst.
- Deals no direct damage on contact: the beam tick only adds stacks.
- Routed through a `damageOverTime()` helper that skips the flash and the slow, and
  reuses the death bookkeeping from `hit()` to keep XP, score, and kill credit correct.

#### Singularity (`gravity`)

**Fantasy:** creates a gravity well that pulls enemies toward a point AND toward each
other; collisions deal impact damage, sustained overlap deals crush damage.

- Creates a well at the aim point with a radius and lifetime.
- Each enemy inside receives an inward force. Because `x` is recomputed, force is
  applied as `enemy.driftX`/`enemy.driftY` offsets folded into the position update.
- Enemies within `impactRadius` of each other take impact damage proportional to
  closing speed, with a per-pair cooldown so it does not fire every frame.
- **Crush:** enemies overlapping heavily take damage over time, same non-flashing path.
- No bullet; the well is an effect with a lifetime.

#### Shared implementation rules

1. **One death path.** Extract kill bookkeeping into `killEnemy(enemy)`; `hit()`,
   `damageOverTime()`, and shatter all call it. Keeps XP/score/kills single-source.
2. **Status state lives on the enemy**: `chill`, `rad`, `radTimer`, `freezeAt`,
   `driftX`, `driftY`. Initialised in `spawn()` so every enemy has the same shape.
3. **Movement is computed in one place.** Fold drift and chill into the existing enemy
   loop rather than adding a second movement pass.
4. **Draw state is visible.** Frozen enemies tint cyan and stop swaying; radiating
   enemies tint green; gravity wells draw as a pulsing ring.
5. **All three are weapons in the registry** with `fire()` and their own cooldowns, and
   all three are added to the pool with `weapon: true` so the loadout marks them.

#### Test plan

| Behaviour | Assertion |
| --- | --- |
| Cryo slows | speed factor falls as chill rises |
| Cryo freezes | at full chill the enemy's `y` stops advancing |
| Shatter only kills | zero-damage contact, then a hit kills and awards XP once |
| Boss chill cap | boss never freezes, caps at 0.6 |
| Rad is DoT only | contact leaves hp unchanged; hp falls over time |
| Rad stacks | two applications out-damage one |
| Rad kill credit | DoT kill awards XP and score exactly once |
| Gravity pulls | enemies inside the well move toward its centre |
| Gravity impact | two enemies colliding take damage |
| Gravity crush | overlapping enemies take damage over time |
| No flash spam | DoT does not set `flash` every frame |

### Desktop vs mobile layout budget

- `#loadout` is `max-height:340px; overflow:auto` (`style.css:3`) — about 6 rows, then
  scroll. On mobile the cap is removed (`style.css:6`), so every weapon row adds page length.
- `.upgrade-choices` is a hard 3-column grid (`style.css:4`) matching `Digit1-3`
  (`game.js:429`) and `slice(0, 3)` (`game.js:113`). A 4th card needs the grid, the key
  handler, and the slice changed together.
- `.upgrade-card` has `min-height:250px` (`style.css:4`); adding a weapon stat block
  will overflow it before it overflows width.
- Every overlay/status string exists twice — static in `index.html:25`, `31`, `32`, `33`
  and re-written by `game.js:42-45`, `80`, `91`. Multi-weapon copy must change both.

### Migration path (each step shippable, tests green)

1. ~~**Extract, do not add.**~~ **Shipped.** Blaster moved into the `weapons` registry and
   driven by a per-weapon loop. All 19 pre-existing tests passed unchanged.
2. ~~**Add W3 Nova pulse**~~ **Shipped.** Own 1.6 s cooldown, damages through `hit()`,
   no bullets. Two new tests cover independence and damage routing.
3. ~~**Split the upgrade pool** into weapon / passive / evolution categories.~~ **Rejected
   on measurement.** Three split policies were implemented and benchmarked over 100 seeded
   runs each; every one reduced survival while adding only ~1 level of discovery speed.
   The uniform pool stays. If a future change does revisit this, measure with ≥50 seeds
   per family — an early 20-seed sample inverted the conclusion twice.
4. ~~**Add W2 orbital drone**~~ **Shipped.** First non-aiming weapon; orbit phase advances
   per frame and damage routes through `hit()`.
5. **Add evolutions**, starting with the blaster's Arc laser. *Not done.*
   *Acceptance:* evolution fires only at max rank + passive; base weapon is removed and
   the evolved one added, matching the reference game's replace semantics.
6. **Fill out W4 and W5** (mines, homing) once the card flow and evolutions are proven.

### Risks

| Risk | Mitigation |
| --- | --- |
| Refactor silently changes blaster feel | Lock with the existing 19 tests before adding anything; keep the four ordering rules above |
| Seeded determinism test diverges | Land the extract step with zero behaviour change, then add weapons one per commit |
| Pool bloat makes level-ups feel random | Cap active weapons; weight cards toward owned weapons early |
| Balance sprawl (5 weapons × evolutions × passives) | Ship two weapons first; tune with the headless harness (4.3) |
| Loadout panel unreadable on mobile | Group weapon vs passive; keep the mobile scroll behaviour deliberate |
| New id hangs the integration test | Add to `priority` in `game.test.cjs` in the same commit as the id |

---

## 3. Roadmap

Size is complexity, not duration: **S** = one sitting, **M** = multi-session,
**L** = needs design first.

### Phase 0 — Ship-quality foundation

Fix the things that make the current build look unfinished, so later work is judged
on gameplay rather than roughness.

| # | Item | Size | Why |
| --- | --- | --- | --- |
| 0.1 | ~~Hi-DPI canvas scaling (`devicePixelRatio`, resize observer)~~ **shipped** | S | Removes the blur that affects every retina phone |
| 0.2 | ~~Add `/game/` to `sitemap.xml`, refresh `<lastmod>`~~ **shipped** | S | The game is currently invisible to search |
| 0.3 | ~~Web manifest + icons + install prompt~~ **shipped** | M | Mobile players get a real app entry point |
| 0.4 | ~~Service worker for offline play~~ **shipped** | M | The game is fully static; offline is nearly free |
| 0.5 | ~~Persist settings (sound, auto-fire) alongside best score~~ **shipped** | S | Mute resets every reload today |
| 0.6 | Master volume slider + explicit mute state | S | Audio is all-or-nothing now |
| 0.7 | ~~Rename `wave`/`wave-progress` ids to `threat`/`hostiles`~~ **shipped** | S | Stops the endless mode reading like leftover code |
| 0.8 | ~~Trim hot-path allocations (`spawnOne`, cached `aimTarget`)~~ **shipped** | S | Keeps 40-enemy late waves smooth |

**Exit criteria:** Lighthouse ≥ 95 for performance and accessibility on mobile;
installable on Android and iOS; tests still green.

### Phase 1 — Make the endless loop worth repeating

The loop is functional but flat. Variety is what makes players start run #4.

| # | Item | Size | Why |
| --- | --- | --- | --- |
| 1.1 | Second and third boss archetypes (ranged, charger, splitter) | M | One boss repeated every 2 min gets old fast |
| 1.2 | Two or three new enemy behaviours (formation, flanking, shielded) | M | Positions and movement start to matter |
| 1.3 | Threat curve tuning from recorded runs | M | Current 30 s step is a guess |
| 1.4 | Spawn director with pacing breaths | M | Constant pressure = exhaustion, not tension |
| 1.5 | Elite variants (modifiers, not new art) | S | Cheap variety multiplier |
| 1.6 | ~~Weapon system refactor + first two weapons (see §2)~~ **shipped** — registry + Nova pulse + Orbital drone | L | The real source of build variety; unlocks everything else |
| 1.7 | Split upgrade pool into weapons / passives / evolutions | M | Level-ups currently only ever offer passives |
| 1.8 | Weapon evolutions on the blaster path only | M | Payoff loop that makes late runs feel powerful |
| 1.9 | Upgrade pool rebalance + 2–3 new capstone passives | M | Build identity is the core replay driver |
| 1.10 | Visible upgrade cap feedback in the loadout | S | Players currently discover caps by absence |

**Exit criteria:** Three distinct boss fights; five base weapons plus their evolutions
playable; at least five distinguishable build archetypes reach threat 10 in automated
runs; median run length rises in playtesting.

### Phase 2 — Retention

Everything here exists to answer "why start again?".

| # | Item | Size | Why |
| --- | --- | --- | --- |
| 2.1 | Meta-progression: unlock currency spent between runs | L | The single biggest retention lever for this genre |
| 2.2 | Seeded runs + seed display/share string | S | Reproducible, shareable, testable |
| 2.3 | Daily seed mode with a per-day best | M | Reason to return tomorrow |
| 2.4 | Run history and personal stat page | S | Progress feels real when it is visible |
| 2.5 | Achievement set tied to real milestones | S | Cheap goals for the mid-game |
| 2.6 | Optional leaderboard (static-host friendly, e.g. external store) | L | Only worth it after retention is proven |

**Exit criteria:** A new player can point at something they unlocked, something they
are chasing, and a reason to come back tomorrow.

### Phase 3 — Feel and accessibility

| # | Item | Size | Why |
| --- | --- | --- | --- |
| 3.1 | Hit-stop, screen shake, muzzle flash, damage numbers | M | The main gap between "works" and "feels good" |
| 3.2 | Layered music + hit/kill sound design beyond bare synth | M | Current audio is functional but thin |
| 3.3 | Reduced-motion mode for gameplay effects | S | CSS-only support exists; gameplay is unaffected |
| 3.4 | Colorblind-safe enemy and damage telegraphing | S | Enemy types currently read by hue |
| 3.5 | Screen-reader summary of run state | S | `aria-live` exists but says little |
| 3.6 | Full settings panel replacing the reused pause overlay | S | Pause currently hijacks the end-of-run card |

**Exit criteria:** Reduced-motion and colorblind passes are playable, not just tolerated.

### Phase 4 — Make it maintainable

Only worth doing once the game is large enough to hurt. Do not do this early.

| # | Item | Size | Why |
| --- | --- | --- | --- |
| 4.1 | Split `game.js` into modules (sim, render, input, ui) | M | 460 lines is fine; 1500 is not |
| 4.2 | Fixed-timestep accumulator in the frame loop | M | Removes frame-rate-dependent behaviour |
| 4.3 | Headless balance harness (thousands of seeded runs) | L | Turns tuning into evidence |
| 4.4 | CI: run `node --test` on push | S | Tests only run when remembered today |
| 4.5 | `CHANGELOG.md` + contribution notes | S | The repo already documents conventions well |

---

## 4. Recommended order

1. **Phase 0.1–0.2 first.** Two small fixes that make the game look and read as finished.
2. **Phase 1.6 immediately after Phase 0.** The weapon refactor is the load-bearing
   change for every other variety item; doing it early means enemies, bosses, and
   evolutions are all built against the right structure instead of retrofitted.
3. **Phase 1.1–1.5 alongside it.** Enemy variety and the pacing curve are independent
   of the weapon work and can proceed in parallel.
4. **Phase 2 only after Phase 1 exit criteria are met.** Meta-progression layered onto
   a flat loop just adds grind — and unlockable *weapons* are a far better meta-reward
   than stat bumps.
5. **Phase 3 interleaved**, because feel is cheaper to add alongside new enemies than
   to retrofit.
6. **Phase 4 last**, with 4.4 promoted earlier if more than one person touches the code.

---

## 5. Explicit non-goals

- Multiplayer or netcode.
- Accounts, cloud saves, or any backend.
- A game engine or bundler — it stays one file of native Canvas for as long as it can.
- Monetisation, ads, or tracking beyond opt-in local stats.

---

## 6. Definition of done

Every roadmap item ships with:

- A test in `game/game.test.cjs` covering the new behaviour.
- `node --test game/game.test.cjs` green (currently 19/19).
- `node --check game/game.js` clean.
- `game/README.md` updated if play behaviour changed.
- No new runtime dependency.

## 7. Open questions

- Is the target a five-minute arcade run or a long build-crafting session? The answer
  changes Phase 1.3 and all of Phase 2.
- Should meta-progression be power (unlocks that help) or variety (unlocks that
  diversify)? Power risks trivialising the loop. Unlocking weapons leans variety.
- Does the game stay strictly auto-aim, or do some weapons need aim input? The whole
  mobile control scheme assumes the player never aims; W2 (orbit) and W3 (nova) were
  chosen partly to protect that.
- Five base weapons, or five *active* slots drawn from a larger pool? The latter is
  closer to the reference genre but multiplies balance work.
- Is the leaderboard worth a backend dependency, or does a local "personal best per
  seed" carry the same motivation?
