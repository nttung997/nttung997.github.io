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
| Player growth | 10 upgrades, each with a cap (repair is repeatable but conditional) |
| Weapons | **One** blaster, fixed 1 Hz, 1×1 → 3×3. Every offensive upgrade modifies this single path (`firePilot` → `fireVolley`) |
| Rendering | Native Canvas 2D, fixed 480×680 backing store |
| Audio | WebAudio oscillator synth only; no volume, no persisted mute |
| Persistence | Best score only (`skyhold-survivor-best`) |
| Tests | 19 passing, `node --test game/game.test.cjs` |
| Size | ~460 lines JS, ~30 KB, zero dependencies, no build step |

### Constraints to protect

- **No build step.** Open `index.html` and it runs. This is the project's main asset.
- **Zero runtime dependencies.** No engine, no framework, no bundler.
- **Static hosting.** GitHub Pages, no server, no accounts, no backend.
- **`node --test` stays the gate.** Every behaviour change ships with a test.

### Known gaps (measured, not guessed)

- **Not retina-crisp.** `canvas` has a fixed 480×680 backing store and is CSS-scaled;
  `devicePixelRatio` is never handled → soft edges on high-DPI phones.
- **Not discoverable.** `/game/` is absent from `sitemap.xml` even though the root
  page links to it.
- **Not installable.** No web manifest, no service worker, no icons, no offline play.
- **No retention hook.** Runs are ephemeral; nothing unlocks, no daily seed, no history.
- **Thin enemy vocabulary.** One movement pattern (sine sway), one boss behaviour.
- **One weapon path.** There is no notion of independent weapons with their own
  cooldowns. `fireVolley` hard-codes a single bullet shape, so adding a second weapon
  today means branching inside the one function. This is the main structural limit on
  build variety — see [§2](#2-weapon-system-the-vampire-survivors-model).
- **Balance unproven.** Tests stop at 300 s; no data on where real runs end.
- **Legacy naming.** Threat lives in DOM ids called `wave` / `wave-progress`.
- **Small hot-path waste.** `spawnOne` allocates via `filter().length` per spawn;
  `aimTarget` re-scans the roster several times per frame.

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

### Proposed weapon roster

Five base weapons is the right launch size: enough for real combinations, few enough
to balance and to fit the loadout panel. Each has one evolved form, unlocked only when
the weapon is at max rank and its paired passive is held.

| # | Base weapon | Behaviour | Evolution (needs max rank + passive) | Cost |
| --- | --- | --- | --- | --- |
| W1 | **Blaster** (existing) | 1 Hz aimed burst, 1×1 → 3×3 | **Arc laser** — continuous beam along the aim line (`pierce`) | refactor only |
| W2 | **Orbital drone** | Circles the pilot, damages on contact, ignores aiming | **Twin orbit** — second drone, opposite phase (`speed`) | S |
| W3 | **Nova pulse** | Radial ring burst with no aiming, short cooldown | **Supernova** — larger ring that leaves a burning ground effect (`aura`) | S |
| W4 | **Mines** | Drops stationary charges behind the player | **Cluster mines** — each trigger spawns a scatter (`blast`) | M |
| W5 | **Homing missiles** | Slow tracking projectiles; rewards not aiming | **Swarm missiles** — launches a volley (`multishot`) | M |

W2 and W3 are the cheapest wins: both reuse the existing effect/aura drawing paths and
need no new aim logic. Recommended first pair after the refactor. W1's evolution is
also cheapest to prototype because the blaster's firing path already exists.

### Rules that make it feel like the genre

- **Independent cooldowns.** Each weapon ticks on its own; never gate the loop on one
  global `cooldown`, which is what the current code does.
- **Weapons occupy level-up slots.** A level-up offers a mix of new weapons, weapon
  ranks, and passives — not only passives. This is what makes early runs differ.
- **Cap the loadout.** With a five-weapon pool, cap active weapons at four so picking
  one genuinely excludes another. Weapon cards stop appearing once the cap is full.
- **Evolutions are earned, not rolled.** A weapon evolves only when it is at max rank
  *and* its paired passive is held (W1 needs `pierce`, W4 needs `blast`). Evolutions
  are the payoff that makes late runs feel powerful.
- **Passives stay as they are.** `damage`, `armor`, `speed`, `frost`, `repair` remain
  global modifiers; only offensive output moves to the weapon registry.

### Migration path (in order, each step shippable)

1. **Extract, do not add.** Move the blaster into a `weapons` registry and drive it
   from a per-weapon loop. Blaster behaviour must be byte-identical; the existing 19
   tests are the proof. No new gameplay yet.
2. **Add one weapon** (W3 Nova pulse, reusing `aura`). Verify two weapons fire
   independently and that the loadout panel renders both.
3. **Split the upgrade pool** into weapon / passive / evolution categories and teach
   `requestUpgrade` to offer from all three.
4. **Add W2 orbital drone**, the first weapon with no aiming.
5. **Add evolutions**, starting with the blaster's Arc laser, and confirm the pattern
   before scaling it to the full roster.
6. **Fill out W4 and W5** once the registry, card flow, and evolution pattern are
   proven.

### Fit with the existing constraints

- **Testable without a browser.** `fire` functions take `state` and mutate it, exactly
  as `fireVolley` does today, so the current `vm`-sandbox harness keeps working.
- **No new dependency.** Data-driven registry is plain JS objects.
- **Cold-path cost only.** Per-weapon cooldown decrement is a handful of arithmetic
  ops per frame; the existing `MAX_ALIVE` cap still bounds the entity count.
- **UI grows deliberately.** The loadout panel already lists owned upgrades; it needs
  a weapon section with rank and cooldown, and the "Your build" panel will get crowded
  — budget a layout pass alongside step 3.

### Risks

| Risk | Mitigation |
| --- | --- |
| Refactor silently changes blaster feel | Freeze behaviour with the existing tests before adding anything |
| Pool bloat makes level-ups feel random | Cap active weapons; weight cards toward owned weapons early |
| Balance sprawl (5 weapons × evolutions × passives) | Ship two weapons first; tune with the eventual headless harness (4.3) |
| Loadout panel becomes unreadable on mobile | Group by weapon vs passive; collapse ranks |

---

## 3. Roadmap

Size is complexity, not duration: **S** = one sitting, **M** = multi-session,
**L** = needs design first.

### Phase 0 — Ship-quality foundation

Fix the things that make the current build look unfinished, so later work is judged
on gameplay rather than roughness.

| # | Item | Size | Why |
| --- | --- | --- | --- |
| 0.1 | Hi-DPI canvas scaling (`devicePixelRatio`, resize observer) | S | Removes the blur that affects every retina phone |
| 0.2 | Add `/game/` to `sitemap.xml`, refresh `<lastmod>` | S | The game is currently invisible to search |
| 0.3 | Web manifest + icons + install prompt | M | Mobile players get a real app entry point |
| 0.4 | Service worker for offline play | M | The game is fully static; offline is nearly free |
| 0.5 | Persist settings (sound, auto-fire) alongside best score | S | Mute resets every reload today |
| 0.6 | Master volume slider + explicit mute state | S | Audio is all-or-nothing now |
| 0.7 | Rename `wave`/`wave-progress` ids to `threat`/`hostiles` | S | Stops the endless mode reading like leftover code |
| 0.8 | Trim hot-path allocations (`spawnOne`, cached `aimTarget`) | S | Keeps 40-enemy late waves smooth |

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
| 1.6 | Weapon system refactor + first two weapons (see §2) | L | The real source of build variety; unlocks everything else |
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
