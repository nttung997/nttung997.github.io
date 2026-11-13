# Skyhold — Development Roadmap

Working plan for the endless survival shooter in `game/`. Priorities are ordered by
**player impact per unit of risk**, not by what is most fun to build.

---

## 1. Where the game stands

Verified against the current source, not from memory.

| Area | Current state |
| --- | --- |
| Core loop | Endless continuous spawns; no waves, no win state. `update()` in `game.js` |
| Difficulty | Threat +1 every 30 s; health/speed/damage scale `1 + (threat-1)*0.22` |
| Pressure valve | `MAX_ALIVE = 40`, spawn floor `0.3 s` (`spawnDelay`) |
| Boss | One siege carrier type, re-spawned every 4th threat |
| Player growth | 5 passives — damage, pierce, blast, frost, repair (repair is repeatable but conditional) — plus the locked weapon's rank track (bullet weapons 1→5, Orbital drone/Mines 1→3) |
| Weapons | **Six run-locked weapons shipped**: blaster, gravity, cryo, rad, orbital drone, mines. One weapon per run, one rank track each, and one evolution each |
| Rendering | Native Canvas 2D; backing store sized to CSS width × DPR, drawn in a 480×680 logical space |
| Audio | WebAudio oscillator synth only; sound and auto-fire persist locally |
| Persistence | Best score plus settings (`skyhold-survivor-best`, `skyhold-survivor-settings`) |
| Install | Web manifest + SVG icons + service worker (offline shell) |
| Tests | 51 passing, `node --test game/game.test.cjs` |
| Size | ~1170 lines JS, ~69 KB, zero dependencies, no build step |

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
- ~~**Weapon system is split.**~~ Fixed: a run locks one of six weapons, each with its own
  rank track and one evolution. Nova is retired; Mines is built.
- **Weapon balance is approximate.** All six clear the seeded 300 s window on all 10 seeds,
  but the bot is greedy and the curves are not individually tuned across other seed
  families.
- **Passive pool is deliberately small.** Five passives ship; `aura`, `armor`, and `speed`
  were removed. Phase and Volatile rounds are mutually exclusive, and Cryo runs are never
  offered Cryo rounds. If the pool is expanded later, re-measure rather than assuming.
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

One unified weapon system, replacing the old three-layer split (locked bullet class →
always-on blaster → slot weapons). **A run picks exactly one weapon and locks it.** That
weapon is the run's identity, the only weapon that can rank up, and the only one that can
evolve. Passives still drop from level-ups and modify it the same way for every weapon.

This section supersedes the earlier "core weapon class + base weapon" design. The split is
gone; the unified model is what ships:

| Old split (removed) | Shipped model |
| --- | --- |
| `state.classId` locked a bullet behaviour (physical / poison / gravity) on an always-on blaster | `state.weaponId` locks one of **six** weapons for the run |
| Blaster always fired; Nova / Orbital drone / Cryo stacked as extra cooldowns | No stacking: the locked weapon is the only weapon instance |
| Nova, Orbital drone, and Cryo were upgrade cards in the passive pool | All six are run weapons chosen before combat, not pool cards |
| Gravity was a blaster bullet modifier | Gravity is its own weapon |
| `poison` was a class name | `rad` is the weapon; the stack/DoT implementation was reused |
| Evolutions existed for the blaster only | Every weapon has exactly one evolution |

### The one rule

> **One weapon per run. Locked at the start. Ranked up with level-ups. Evolved at max
> rank plus its paired passive.**

Consequences that follow from it:

- The pre-run picker is a **weapon picker** with six cards, not a class picker.
- The level-up pool offers: the locked weapon's next rank (until maxed), any available
  passive, the evolution card once its gate is met, and repair when the base is hurt.
  There is no weapon-discovery problem to solve because only one weapon can appear.
- `state.weapons` stays as the per-weapon loop's array but holds exactly one entry.
  `state.pilot` is pure movement, not the blaster's instance.
- A weapon card is a rank decision, not a slot decision. Fully ranked weapons stop
  appearing, and the evolution replaces the base exactly once.

### Implemented model

Every weapon is data plus a small `fire` function, driven by the existing per-weapon
loop:

```js
state.weaponId = 'blaster';                          // locked in the pre-run picker
state.weapons = [{ id: 'blaster', cooldown: 0, pendingBursts: [], phase: 0 }];
state.build = { blaster: 3, pierce: 1, damage: 2 };  // flat: locked rank + passives
```

Each tick the loop decrements the instance's cooldown and calls `fire` when ready, before
bullet integration. The player's `angle` becomes a per-weapon concern.

**Rank lives in `state.build[state.weaponId]`**, so the flat-map contract holds and the
loadout can render one "Blaster rank 5 / 5" row. Bullet weapons' shot-pattern ranks
collapse into that track: rank 1 = 1×1, rank 2 = 1×2, rank 3 = 2×2, rank 4 = 2×3,
rank 5 = 3×3. Retiring `multishot` and `burst` as separate passives frees two pool slots
and makes the evolution gate uniform (`rank(weaponId) === max`). Gravity and Rad share the
same pattern while their per-hit charge/stack scaling stays capped at the rank-3 value.
Orbit and Mines keep three ranks and spend them on contact/blast stats.

Registry shape, kept as plain objects so it stays dependency-free:

| Field | Purpose |
| --- | --- |
| `id`, `name`, `icon`, `tag` | Picker, card, and loadout display |
| `max` | Rank cap (5 for bullet weapons, 3 for Orbit/Mines, 1 for evolutions) |
| `interval` | Seconds between activations — this is what creates weapon identity |
| `fire(state, weapon)` | Mutates the world: pushes bullets, effects, or applies damage |
| `evolutions` registry | One entry per evolved form, with `from`, `requires`, `ready()`, and `fire` |

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

**Deliberate divergence:** the reference game runs six active weapons at once. We lock to
one because the mobile control scheme assumes the player never aims, and because one
weapon plus passives is the balance surface we can measure with the seeded bot. What we
copy is the *progression*: maxed items stop appearing, taking a rank resets the cooldown
and fires immediately, and evolution replaces the base weapon.

### Weapon roster — exactly six, all shipped

Each is a full weapon with its own `fire`, cooldown, rank track, and one evolution.

| # | Weapon | Archetype | Behaviour | Status |
| --- | --- | --- | --- | --- |
| W1 | **Blaster** | aimed projectile | 1 Hz aimed bursts; ranks 1→5 widen 1×1, 1×2, 2×2, 2×3, 3×3 | shipped |
| W2 | **Gravity** | projectile → magnet | Five ranks widen the volley; rounds charge enemies, who pull each other together and crush | shipped |
| W3 | **Cryo** | area control | Aimed frost volleys (five-rank pattern) stack a diminishing slow; speed 10 crawls, then 10–30 more stacks execute | shipped |
| W4 | **Rad** | stacking DoT | Permanent radiation stacks; five ranks widen the volley; leak-prediction aim | shipped |
| W5 | **Orbital drone** | orbiting area | Wide contact zone around the pilot; no aiming | shipped |
| W6 | **Mines** | ground hazard | Drops armed charges across a rear arc; contact blasts | shipped |

Nova pulse is deliberately **not** on the list: it was an area-burst slot weapon, and its
role is covered by Rad's stacks and Mines' detonation. Retiring it keeps the roster at
exactly six instead of inventing a seventh.

**Evolutions** pair each weapon with one existing passive, so no new passive system is
needed. Every weapon has exactly one, and the gate is always the same: base rank maxed
plus the paired passive at rank ≥ 1. All six are shipped.

| Weapon | Evolution | Requires | Effect |
| --- | --- | --- | --- |
| W1 Blaster | **Arc laser** | `pierce` | Continuous 5 Hz beam along the aim line |
| W2 Gravity | **Singularity** | `blast` | 1.6× pull force and 1.35× range |
| W3 Cryo | **Absolute zero** | `blast` | Starting a crawl spills a slow stack onto nearby enemies |
| W4 Rad | **Meltdown** | `damage` | Faster tick value; half the stacks spread to nearby enemies on death |
| W5 Orbital drone | **Twin orbit** | `damage` | Doubles contact damage |
| W6 Mines | **Cluster mines** | `blast` | Each detonation scatters three sub-charges |

The implementation is the same for all six: taking an evolution deletes the base rank,
swaps the single weapon instance for the evolved one with a fresh cooldown, and applies
the evolution-specific modifier in the shared mechanics.

> Passive pairings above are design proposals, not copied from the reference game. The
> reference pairings (e.g. Whip + Hollow Heart → Bloody Tear) are illustrative only.

### Refactor contract — what must not change

This is the load-bearing section. The exploration passes found specific constraints that a
naive registry refactor breaks silently. Line numbers drift; match on the symbols named
here, not on coordinates.

**1. The test anchor.** The test harness asserts the literal string
`reset(); requestAnimationFrame(frame);` exists in `game.js` and replaces it to expose
internals. It must stay the final statement of the IIFE. Moving bootstrap into `init()` or
adding a statement after it fails every test.

**2. The export contract.** The harness exposes internals by name. `firePilot` and
`shotPattern` must keep their names and observable semantics, because tests reach firing
only through them.

**3. Weapon ticks run before bullet integration.** Tests identify fresh bullets by
`life === 2 - 1/60`, so firing after integration moves a newborn bullet by `vx*dt` and
breaks shot-pattern assertions. The per-weapon loop stays ahead of the bullet loop.

**4. Preserve cooldown epsilon symmetry.** The fire gates use `> 1e-9` and the ready gates
use `<= 1e-9`; keep them equal and keep `Math.max(0, …)` on decrement. Asymmetric epsilons
create a frame where a weapon can neither fire nor be ready, and the 1 Hz test asserts
exact one-second spacing.

**5. `state.build` stays a flat id→rank map.** Tests wholesale-replace it and the loadout
indexes it directly. Keep the locked weapon's rank and passives in the same flat map; do
not nest weapon state under `build`.

**6. The seeded bot's `priority` array must list every id it can be offered.** The 300 s
tests call `priority.find(...)`; an unlisted id returns `undefined`, `chooseUpgrade`
bails, the phase stays `'upgrade'`, and the loop hangs. Any new weapon, rank, or evolution
id must be added to both arrays in the same commit.

**7. RNG order is a determinism contract.** `burst()`, `spawnType`, `spawn`, and the
upgrade shuffle share one `Math.random()` stream. A weapon that kills at a different point
in the frame reshuffles every downstream roll. The seeded 300 s test exercises that
ordering, so weapon damage timing is not a free variable.

**8. All damage must go through `hit()`.** It owns the `enemy.hp <= 0` guard that prevents
double XP and kill credit, plus score, particles, the XP popup, and `updateUI`. Rad and
Gravity legitimately deal no direct damage and use `applyPoison` / `applyGravity`, but any
weapon that *does* damage must call `hit()`; a beam or mine that decrements `hp` directly
silently loses all bookkeeping.

**9. Keep one shared `state.bullets` array.** Hostile bullets live in it too and tests read
it directly. Give bullets a `weaponId` field instead of per-weapon arrays.

**10. `enemySpeedFactor` must stay enemy-pure.** `chillFactor` is read by both blaster lead
prediction and all enemy movement. Making frost weapon-scoped would make aim prediction
diverge from actual movement.

**11. The effect union is tagged.** The draw path branches on `effect.xp` / `effect.beam`
first; the fallback reads `effect.radius` and `effect.life/.4` unconditionally. Every new
effect must use the ring shape `{x, y, radius, life}` or add its own tag before the
fallback.

**12. Some UI strings are frozen in tests.** `#shot-total`, `#shot-stat`, and `#rate-stat`
are asserted verbatim in the shot-pattern tests. Keep them pinned to the locked weapon's
display, or update the tests together.

**13. One weapon instance, one cooldown path.** Under the unified model `syncWeapons()`
instantiates exactly `state.weaponId`; it must never resurrect the other five from stale
build ranks. Taking an evolution removes the base rank and starts the evolved cooldown at
zero, exactly like the shipped Arc laser.

**14. Keep the picker and the pre-run flow.** The picker writes `state.weaponId` and only
accepts an id from `WEAPON_IDS` while the phase is `ready`. The run may not switch weapons
mid-run, and `reset()` must clear both the id and the instance list.

### Six run-locked weapons — the unified model, **shipped**

The per-run lock is the right idea; the class/weapon split is not. The unified model is
now shipped: one weapon per run, one instance, one rank track, one evolution. The
mechanics below record what each weapon does.

**Constraint discovered in analysis:** `enemy.x` is not free. It is recomputed every
frame as `originX + sin(time) * sway`. Horizontal force (gravity) is therefore applied as
a decaying `driftX` offset folded into the position update, never as a direct `x` write.
`driftX` is a positional offset rather than a velocity, so the pull constant is tuned as
an equilibrium offset — too large and enemies teleport into a pile.

**Constraint 2:** `hit()` sets `enemy.flash = .09`. Damage-over-time routed through
`hit()` every frame leaves enemies permanently white. `damageOverTime()` is a separate
path that skips flash and slow but shares the death bookkeeping via `killEnemy()`.

**Bug found in live testing:** the first Cryo implementation froze enemies permanently,
so the field clogged with unkillable statues (observed: kills stalled at 19 for 6 s with
17 hostiles on screen). A 0.9 s self-break timer fixed that, then the crawl replaced the
timer: enemies that reach speed 10 stay on purpose, and they remain killable because the
shatter gap still executes them. Guarded by a regression test.

#### Blaster (`blaster`)

**Fantasy:** a reliable aimed projectile; the run's baseline for players who want the
straightforward build.

- Ranks are the shot pattern: **1×1, 1×2, 2×2, 2×3, 3×3** at ranks 1–5, fired at 1 Hz.
  Parallel rounds share 8 px muzzle spacing but fan out slightly along their travel.
- Always physical: the old separate bullet-class choice goes away with the unification.
- Evolution: **Arc laser** at max rank + `pierce`; already shipped — a 5 Hz line beam
  that damages every enemy it overlaps through the standard `hit()` path.

#### Rad (`rad`)

**Fantasy:** every round is a permanent radiation stack; damage ramps without bound until
the enemy dies. Satisfying against a boss that survives long enough to accumulate stacks.

- **2 + min(rank, 3) stacks per round** (3/4/5/5/5), so ranks 1–3 compound the burn and
  ranks 4–5 buy the wider volley instead. No direct damage.
- Stacks never expire and cap at 40. DPS is linear in stacks.
- **Auto-aim is weapon-aware.** Instead of the nearest enemy it targets the one most at
  risk of reaching the outpost, scored as `time-to-die − time-to-arrive`. When radiation is
  already on pace to kill before arrival the score goes negative and the aim moves on —
  the "just enough" behaviour that spreads stacks across the field instead of dumping them
  all into one enemy while its neighbours walk through.
- Deals no direct damage on contact: the round only adds stacks.

#### Gravity (`gravity`)

**Fantasy:** rounds charge enemies with gravity, turning them into magnets that drag each
other together and crush on contact.

- No direct damage. Each hit adds charges (`1 + min(rank, 3)` = 2/3/4/4/4, cap 6, decaying
  after 3 s); ranks 4–5 buy the wider volley instead of more charges.
- Every round also bursts, charging enemies near the impact so clusters magnetise together.
- Every charged enemy pulls nearby enemies toward itself with distance falloff, so a
  cluster collapses into a pile. Collision damage needs at least one charged participant;
  overlap between two uncharged enemies stays harmless.
- Crush damage over time scales with charge; a fully charged overlapping pair also lands
  periodic impact hits.
- A charged enemy also buckles under its own gravity, so a lone enemy still dies without
  ever touching a partner.

#### Cryo (`cryo`)

**Fantasy:** aimed frost volleys that bury a cluster in slow stacks until the pack is
crawling and harmless, then keep stacking until the shatter executes them.

- Fires an aimed frost volley every 0.9 s. Rank widens the pattern **1×1, 1×2, 2×2, 2×3,
  3×3** at ranks 1–5, exactly like the Blaster; each round carries two slow stacks and no
  damage.
- Each round bursts on impact, applying the same stacks to every enemy in a radius (64 at
  rank 1, +8 per rank). Volatile rounds widen that burst; Phase rounds let the round pass
  through targets.
- Each stack removes a fraction `p = min(0.5, 0.35 * sqrt(46 / maxHp))` of the speed the
  enemy still has, so later stacks cut less than earlier ones. High-HP bodies get a smaller
  fraction. After `n` stacks the speed factor is `(1 - p)^n`.
- Stacks persist; nothing decays. At cryo speed 10 the enemy is **frozen**: it keeps
  swaying and its forward speed floors at 10, so faster enemies catch the crawl and the
  field bunches up. Further stacks do not slow it more. There is no self-break timer, and
  a hit does not shatter it.
- Shatter waits for more stacks past the freeze: 10 for a drone or runner, about 16 for a
  tank, 30 for a siege carrier (`round(clamp(10 + 20 * log(maxHp / 46) / log(3200 / 46), 10, 30))`).
  Filling that gap **executes** the target (the hit returns the target's remaining HP as
  damage). That is Cryo's only kill path.
- Every enemy follows the same rule, bosses included. Their lower per-stack fraction and
  larger gap mean they crawl later and shatter later.

#### Orbital drone (`orbit`)

**Fantasy:** a satellite that keeps working while the pilot moves; the weapon for players
who never want to think about aim.

- The drone sweeps a wide contact zone around the pilot. Enemies inside take contact damage
  through `hit()`; the zone covers the pilot's own position, so a stationary build still
  works.
- Damage scales up with the enemy's body size, keeping tanks and siege carriers relevant
  without overkill on trash.
- Phase advances per frame. No bullets and no aiming, so it is the purest expression of
  the mobile control scheme.
- Evolution: **Twin orbit** doubles contact damage (two patrol lanes).

#### Mines (`mines`)

**Fantasy:** leave a trail of traps behind you and let the swarm walk into it.

- Drops armed charges across a rear arc (five alternating slots) every 0.6 s; each charge
  arms for 0.45 s so it cannot detonate on the frame it spawns.
- Detonation is a radius hit through `hit()`, sharing the death guard and score/XP path.
  Blast damage scales with the enemy's body size.
- A live-charge cap of 6 keeps the field readable; the oldest detonates when the cap is
  exceeded.
- Ranks add damage and blast radius; evolution **Cluster mines** scatters three
  sub-charges on every detonation.

#### Nova pulse and the retired split

The old split is retired. **Nova pulse is removed as a standalone weapon**: its radial
burst becomes the Mines detonation visual, and its area-damage role is covered by Rad's
stacks and Mines' blast. Keeping it would make a seventh type and dilute the roster.

Historical note: Rad lance and Singularity were separate upgrade weapons before they were
folded into the blaster's classes. Under the unified model they return as first-class
weapons — **Rad** (stacks, no direct damage) and **Gravity** (charges, enemy-to-enemy
pull) — but chosen as the run's weapon rather than as bullet modifiers.

#### Shared implementation rules

1. **One death path.** Extract kill bookkeeping into `killEnemy(enemy)`; `hit()`,
   `damageOverTime()`, and shatter all call it. Keeps XP/score/kills single-source.
2. **Status state lives on the enemy**: `cryoStacks` / `cryoFreezeStacks` / `chill`, `frozen`, `rad` stacks,
   `charge`, `chargeTimer`, `driftX`, `driftY`. Initialised in `spawn()` so every enemy has
   the same shape.
3. **Movement is computed in one place.** Fold drift and chill into the existing enemy
   loop rather than adding a second movement pass.
4. **Draw state is visible.** Frozen enemies tint cyan, keep a crystal outline, and show the stacks still owed; irradiated enemies
   tint green with a stack count; charged enemies draw a violet halo.
5. **One weapon, one contact path.** Each weapon owns what a hit means: Blaster calls
   `hit()` with direct damage, Rad calls `applyPoison` (renamed to radiation), Gravity
   calls `applyGravity`, Cryo calls `applyChill`, and Orbital drone / Mines call `hit()`.
   There is no separate bullet-class layer deciding it on the blaster's behalf.
6. **One evolution per weapon.** The gate is `rank(weaponId) === max` plus the paired
   passive at rank ≥ 1. Taking it removes the base rank, adds the evolved rank, and starts
   the evolved cooldown at zero.

#### Test plan

| Behaviour | Assertion |
| --- | --- |
| Weapon lock | choosing again mid-run does not switch the weapon |
| One weapon only | `state.weapons` holds exactly one instance, the locked weapon |
| Pierce vs blast | taking one removes the other from every later pool |
| Cryo hides frost | frost cards never appear while Cryo or Absolute zero is active |
| Repair | restores 35, capped at 100, and only appears when damaged |
| Six-weapon balance | each of the six clears the 300 s window on the seeded bot |
| Blaster pattern | ranks 1–5 produce 1×1, 1×2, 2×2, 2×3, 3×3; 1 Hz |
| Fan-out | parallel rounds keep 8 px muzzle spacing but diverge from the centre lane |
| Arc laser gate | evolution appears only at max rank + `pierce`, then never again |
| Arc laser replace | taking it removes the blaster and starts the beam ready |
| Arc laser line | every enemy on the aim line is hit; nothing beside it is |
| Rad is DoT only | contact leaves hp unchanged; hp falls over time |
| Rad stacks never expire | stacks survive 300+ frames |
| Rad ramps | ten stacks out-damage one stack by a wide margin |
| Rad kill credit | DoT kill awards XP and score exactly once |
| Rad aim picks the leaker | far-but-close-to-base enemy beats the nearest one |
| Rad aim spreads | a saturated enemy is less attractive than a fresh one |
| Gravity pulls | a charged enemy drags its neighbour inward |
| Gravity crush | overlapping enemies take damage while at least one is charged |
| Gravity solo | a lone charged enemy dies without a partner |
| Cryo slows | each new stack cuts less speed than the previous one |
| Cryo freezes | at speed 10 the enemy crawls at 10 instead of stopping |
| Cryo stacks | a fired frost round carries slow stacks and zero damage |
| Cryo pattern | rank 1 fires 1×1; rank 5 fires three bursts of three rounds |
| Cryo burst | impact applies stacks to nearby enemies but not distant ones; hp unchanged |
| Max-HP scaling | one stack slows a drone more than a tank, and a tank more than a boss |
| Crawl is not a kill | a frozen enemy survives time and ordinary hits |
| Shatter gap | filling the 10–30 stacks past the crawl executes the remaining HP |
| Boss stacks | a boss needs many stacks to crawl, then its larger gap to shatter |
| Drone orbits | contact damage while orbiting; no bullets, no aiming |
| Mines arm and trigger | a charge arms before detonating, hits inside its radius once |
| Evolution per weapon | all six use the same gate and replace path |
| Focus loss | blur does not pause or stop the simulation |
| No flash spam | DoT does not set `flash` every frame |

### Desktop vs mobile layout budget

- `#loadout` is `max-height:340px; overflow:auto` — about 6 rows, then scroll. On mobile
  the cap is removed, so every weapon row adds page length.
- `.upgrade-choices` is a hard 3-column grid matching the `Digit1-3` handler and the
  `slice(0, 3)` in `pickChoices`. A 4th card needs the grid, the key handler, and the
  slice changed together.
- `.upgrade-card` has `min-height:250px` (`style.css:4`); adding a weapon stat block
  will overflow it before it overflows width.
- The pre-run picker is a single-column grid (`.class-picker`). Six weapon cards instead of
  three will not fit above the fold on a phone; it needs a two-column or scrollable
  layout at the same breakpoint where the overlay currently centers.
- Every overlay/status string exists twice — static in `index.html` and rewritten by
  `game.js`. Multi-weapon copy must change both.

### Migration path (each step shippable, tests green)

1. ~~**Extract, do not add.**~~ **Shipped.** Blaster moved into the `weapons` registry and
   driven by a per-weapon loop. All 19 pre-existing tests passed unchanged.
2. ~~**Add a second weapon.**~~ **Shipped** (Nova pulse, then Orbital drone). The loop and
   the registry are proven; this step is done.
3. ~~**Split the upgrade pool** into weapon / passive / evolution categories.~~ **Rejected
   on measurement.** Three split policies were implemented and benchmarked over 100 seeded
   runs each; every one reduced survival while adding only ~1 level of discovery speed.
   The uniform pool stays for passives. If a future change does revisit this, measure with
   ≥50 seeds per family — an early 20-seed sample inverted the conclusion twice.
4. ~~**Add Cryo, Rad, Gravity**~~ **Shipped**, then Rad and Gravity were **reworked** into
   per-run core weapon classes (physical / poison / gravity) instead of slot weapons.
5. ~~**Add evolutions**, starting with the blaster's Arc laser.~~ **Shipped.** Evolution
   cards live in a separate `evolutions` registry, gated on max rank + paired passive.
   Taking one deletes the base rank, swaps in the evolved instance with a fresh cooldown,
   and routes its damage through the normal contact path. This is the reference
   implementation for the other five.
6. ~~**Unify into six run-locked weapons.**~~ **Shipped.** `state.weaponId` replaced
   `state.classId`; the picker lists six weapons; Gravity, Cryo, Rad, and Orbital drone are
   registry weapons; Nova is retired; `syncWeapons()` instantiates exactly one weapon; the
   locked weapon's next rank is a level-up card; every evolution gates on
   `rank(weaponId) === max` + its passive; `poison` was renamed to `rad` through state,
   copy, and tests. *Acceptance met:* one instance per run, six selectable weapons,
   existing mechanics intact, shared replace semantics.
7. ~~**Add Mines** as the sixth weapon.~~ **Shipped.** Rear-arc drop slots, arming delay,
   six-charge cap with oldest-detonates, radius detonation through `hit()`, and the same
   rank/evolution structure.
8. ~~**Fill the five missing evolutions**~~ **Shipped** (Singularity, Absolute zero,
   Meltdown, Twin orbit, Cluster mines). All six evolutions share the same gate and replace
   path; each weapon clears the seeded 300 s window in the balance test.

### Risks

| Risk | Mitigation |
| --- | --- |
| Unification silently changes blaster feel | Lock with the existing tests before moving anything; keep the ordering and cooldown rules above |
| One weapon feels thinner than the old three-stack builds | Ranking the locked weapon + one evolution + passives is the whole power curve; measure run variety and median length, and keep the old mechanics as the fallback if it measures worse |
| Removing the always-on blaster drops early DPS | The per-class balance test already proves a lone weapon can clear 300 s; run it for all six before shipping the picker |
| A weapon falls out of balance | Same seeded bot, same seed families, ≥50 seeds per family; an early 20-seed sample inverted the conclusion twice |
| Rad aim degenerates into single-target stacking | Risk scoring uses time-to-die minus time-to-arrive, and the spread test pins that a saturated enemy loses priority |
| Gravity pulls too hard and teleports the field | `driftX` is a positional offset with 6%/frame decay; tune the pull constant against a probe, not by eye |
| Mines clutter the field or double-dip kills | Live-charge cap, arming delay, and detonation through `hit()` so the death guard owns kill credit |

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
| 1.6 | ~~Weapon system refactor + first two weapons (see §2)~~ **shipped** — registry + per-weapon loop; the class/slot split was later unified by 1.11 | L | The real source of build variety; unlocks everything else |
| 1.7 | ~~Split upgrade pool into weapons / passives / evolutions~~ **rejected on measurement** — the uniform passive pool stays (§2 step 3) | M | Attempted, measured worse for survival |
| 1.8 | ~~Weapon evolutions~~ **shipped** — all six evolutions share one gate and replace path | M | Payoff loop that makes late runs feel powerful |
| 1.9 | Upgrade pool rebalance + 2–3 new capstone passives | M | Build identity is the core replay driver |
| 1.10 | Visible upgrade cap feedback in the loadout | S | Players currently discover caps by absence |
| 1.11 | ~~Unify into six run-locked weapons~~ **shipped** — blaster, gravity, cryo, rad, orbital drone, mines; one rank track and one evolution each; Nova retired | L | Removes the class/blaster/slot split that everything else would otherwise be retrofitted onto |

**Exit criteria:** Three distinct boss fights; ~~six run-locked weapons playable and
distinct, each with its evolution~~ **shipped**; at least five distinguishable build
archetypes reach threat 10 in automated runs; median run length rises in playtesting.

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
| 4.1 | Split `game.js` into modules (sim, render, input, ui) | M | ~1,100 lines is manageable now; 1,500 would not be |
| 4.2 | Fixed-timestep accumulator in the frame loop | M | Removes frame-rate-dependent behaviour |
| 4.3 | Headless balance harness (thousands of seeded runs) | L | Turns tuning into evidence |
| 4.4 | CI: run `node --test` on push | S | Tests only run when remembered today |
| 4.5 | `CHANGELOG.md` + contribution notes | S | The repo already documents conventions well |

---

## 4. Recommended order

1. **Phase 0.1–0.2 first.** Two small fixes that make the game look and read as finished.
2. ~~**Phase 1.11 (unify the weapon system).**~~ **Shipped** after Phase 0. Six run-locked
   weapons with one evolution each are implemented and green, so enemies, bosses, and
   retention work can build on the settled structure.
3. **Phase 1.1–1.5 next.** Enemy and boss variety plus the pacing curve are the highest
   impact remaining Phase 1 work now that the weapon system is done; 1.9–1.10 follow.
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
- `node --test game/game.test.cjs` green (currently 51/51).
- `node --check game/game.js` clean.
- `game/README.md` updated if play behaviour changed.
- No new runtime dependency.

## 7. Open questions

- Is the target a five-minute arcade run or a long build-crafting session? The answer
  changes Phase 1.3 and all of Phase 2.
- Should meta-progression be power (unlocks that help) or variety (unlocks that
  diversify)? Power risks trivialising the loop. Unlocking weapons leans variety.
- Does the game stay strictly auto-aim, or does a weapon need aim/placement input? The
  whole mobile control scheme assumes the player never aims; the Orbital drone remains the
  only weapon that ignores aim, while Cryo now fires aimed frost rounds. Mines is the first
  weapon that might want a "drop here" gesture.
- **Resolved:** one locked weapon per run from six (blaster, gravity, cryo, rad, orbital
  drone, mines), not several active slots. **Open:** are all six pickable from the first
  launch, or do some unlock through Phase 2 meta-progress? The latter makes the six a
  retention ladder but shrinks the picker on day one.
- Is the leaderboard worth a backend dependency, or does a local "personal best per
  seed" carry the same motivation?
