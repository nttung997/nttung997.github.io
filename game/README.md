# Skyhold Survivor

A portrait survival shooter built with native Canvas, CSS, and JavaScript. No installation, build step, or external assets are required. Open [index.html](./index.html) directly in a modern browser or visit `/game/` on the deployed site.

## Play

- Start a run and move with WASD or arrow keys. On mobile, drag inside the battlefield. You can move across the arena, above the base.
- Your defender automatically aims at the nearest live, visible enemy and fires. Disable auto-fire and hold Space for manual firing with automatic aim.
- Firing is fixed at one cycle per second (1 Hz), for both automatic and manual firing. Upgrades do not increase the cycle rate.
- Shot patterns start at **1×1** and grow to **3×3**: bursts × parallel bullets per burst. Each dimension has two upgrade ranks, taking its count from 1 to 3. Bursts start 200 ms apart; every burst fires its bullets together, 8 pixels apart with identical velocity. At 3×3, three bursts of three parallel bullets fire at 0, 200, and 400 ms within each one-second cycle (nine bullets per second). Every burst reacquires the nearest visible enemy.
- Base projectile damage is 40, balanced for the slower firing cycle. Damage upgrades add 25% per rank.
- Kills automatically award XP. Each level pauses combat and offers three distinct upgrades. Click a card, tap it, or press 1, 2, or 3 to choose. XP beyond a level threshold carries over; multiple earned levels each get a separate choice.
- Combine extra bursts, parallel barrels, damage, piercing, explosive rounds, frost, plasma pulses, armor, and movement speed. Ranks have caps; capped upgrades stop appearing. Emergency repair can appear when the base is damaged.
- Weapons are separate from passives. The blaster is always active; **Nova pulse** (a close-range ring every 1.6 s) and **Orbital drone** (a drone circling your defender, damaging on contact) are added from level-up choices and run on their own cooldowns alongside it. Every weapon fires through the same damage path, so kills, score, and XP stay consistent.
- **Weapon class is chosen once per run.** Before combat begins, pick one of three locked round types. It cannot be changed until the next run, so each run has an identity from the first shot:
  - **Physical** — standard rounds. Every hit deals direct damage immediately.
  - **Poison** — every bullet adds exactly one permanent poison stack (no direct damage). Damage per second scales linearly with stacks, so sustained fire on a boss ramps into serious damage. Stacks never expire and cap at 40. The auto-aim is class-aware: instead of the nearest enemy it targets the one most likely to reach the outpost (estimated time-to-die minus time-to-arrive), which spreads stacks across the field — just enough to kill each enemy before it arrives. Multishot and burst multiply stacks, so the class scales without ever hitting directly. Damage over time does not strobe enemies with hit flashes.
  - **Gravity** — no direct damage. Every hit charges the enemy (up to 6 charges, decaying after 3 seconds). Charged enemies act as magnets, pulling nearby enemies toward themselves so a cluster collapses into a pile; overlapping charged enemies crush, and a fully charged pair deals heavy impact damage. A charged enemy also buckles under its own gravity, so a lone enemy still dies.
- **Cryo lance** chills enemies progressively to a standstill. At full freeze they become ice statues that cannot advance; the freeze breaks on its own after a short hold, or instantly when anything hits them, for shatter damage scaled to health already lost. Cryo itself never deals direct damage. Bosses cap at 60% chill and never freeze.
- Enemies are tougher than the original tuning: base health is 46 for drones, 30 for runners, 170 for tanks, and 3,200 for a siege carrier. Health, speed, and damage all scale with the threat level.
- Projectiles can aim in any direction. Your defender turns toward its target, which is marked with a gold reticle.
- Hostiles spawn continuously, with no waves or intermissions. Threat rises every 30 seconds, speeding up spawns and strengthening new enemies. A siege carrier joins the field every four threats. There is no win state; survive as long as you can.
- Enemies reaching the base, touching your defender, and boss projectiles damage base integrity. Armor reduces ordinary damage. A final boss breach destroys the base even with armor.
- Press P or Escape to pause. Losing window focus or switching tabs does **not** pause combat: only held movement input is released, so the run keeps going and time away costs you. Upgrade selection freezes the simulation.
- Sound and auto-fire are optional and persisted locally. The survivor best score is stored locally when browser storage is available. Restart clears the current build and XP.

## Install and offline

The game ships a web manifest (`manifest.webmanifest`) with SVG icons, so it can be installed to a home screen or desktop. `sw.js` caches the shell for offline play: game code and documents are network-first so edits are never trapped behind a stale cache, while styles, icons, and the manifest are cache-first.

## Development

The game uses a fixed 480 × 680 logical coordinate system and scales to the available width. The canvas backing store is sized from the element's real CSS width times `devicePixelRatio` and drawn through a matching `setTransform`, so vector art stays crisp on high-DPI screens while drawing code keeps using logical coordinates. Upgrade and weapon definitions, XP progression, auto aim, input, simulation, and drawing live in [game.js](./game.js). Weapons are data plus a `fire` function in the `weapons` registry, each driven by its own cooldown in `update()`. The layout and level-up dialog live in [index.html](./index.html) and [style.css](./style.css).

Serve the repository with any static web server when testing over HTTP, for example `python -m http.server 8000`, then open `http://localhost:8000/game/`.

Run `node --test game/game.test.cjs` from the repository root. The dependency-free Node tests cover XP, distinct and capped choices, overflow levels, freezing during upgrade selection, automatic targeting, manual firing, movement bounds, piercing, splash and frost, armor, defeat/restart, 1 Hz timing, all nine shot patterns, the 3×3 cap, independent weapon cooldowns, non-aiming weapon damage, threat escalation, siege-carrier spawns, the locked weapon-class system (physical/poison/gravity), poison stacking and its leak-prediction aim, gravity magnetising and crushing, focus-loss not pausing, and survival across a long endless run for every class with two seeded upgrade pools.

Planned work and known gaps are tracked in [ROADMAP.md](./ROADMAP.md).
