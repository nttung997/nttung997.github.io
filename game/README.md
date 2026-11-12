# Skyhold Survivor

A portrait survival shooter built with native Canvas, CSS, and JavaScript. No installation, build step, or external assets are required. Open [index.html](./index.html) directly in a modern browser or visit `/game/` on the deployed site.

## Play

- Start a run and move with WASD or arrow keys. On mobile, drag inside the battlefield. You can move across the arena, above the base.
- Your defender automatically aims at the nearest live, visible enemy and fires. Disable auto-fire and hold Space for manual firing with automatic aim.
- Firing is fixed at one cycle per second (1 Hz), for both automatic and manual firing. Upgrades do not increase the cycle rate.
- Shot patterns start at **1×1** and grow to **3×3**: bursts × parallel bullets per burst. Each dimension has two upgrade ranks, taking its count from 1 to 3. Bursts start 300 ms apart; every burst fires its bullets together, 8 pixels apart with identical velocity. At 3×3, three bursts of three parallel bullets fire at 0, 300, and 600 ms within each one-second cycle (nine bullets per second). Every burst reacquires the nearest visible enemy.
- Base projectile damage is 40, balanced for the slower firing cycle. Damage upgrades add 25% per rank.
- Kills automatically award XP. Each level pauses combat and offers three distinct upgrades. Click a card, tap it, or press 1, 2, or 3 to choose. XP beyond a level threshold carries over; multiple earned levels each get a separate choice.
- Combine extra bursts, parallel barrels, damage, piercing, explosive rounds, frost, plasma pulses, armor, and movement speed. Ranks have caps; capped upgrades stop appearing. Emergency repair can appear when the base is damaged.
- Enemies are tougher than the original tuning: base health is 46 for drones, 30 for runners, 170 for tanks, and 3,200 for a siege carrier. Health, speed, and damage all scale with the threat level.
- Projectiles can aim in any direction. Your defender turns toward its target, which is marked with a gold reticle.
- Hostiles spawn continuously, with no waves or intermissions. Threat rises every 30 seconds, speeding up spawns and strengthening new enemies. A siege carrier joins the field every four threats. There is no win state; survive as long as you can.
- Enemies reaching the base, touching your defender, and boss projectiles damage base integrity. Armor reduces ordinary damage. A final boss breach destroys the base even with armor.
- Press P or Escape to pause. Leaving the tab pauses combat. Upgrade selection already freezes the simulation.
- Sound is optional. The survivor best score is stored locally when browser storage is available. Restart clears the current build and XP.

## Development

The game uses a fixed 480 × 680 coordinate system and scales to the available width. Upgrade definitions, XP progression, auto aim, input, simulation, and drawing live in [game.js](./game.js). The layout and level-up dialog live in [index.html](./index.html) and [style.css](./style.css).

Serve the repository with any static web server when testing over HTTP, for example `python -m http.server 8000`, then open `http://localhost:8000/game/`.

Run `node --test game/game.test.cjs` from the repository root. The dependency-free Node tests cover XP, distinct and capped choices, overflow levels, freezing during upgrade selection, automatic targeting, manual firing, movement bounds, piercing, splash and frost, armor, defeat/restart, 1 Hz timing, all nine shot patterns, the 3×3 cap, threat escalation, siege-carrier spawns, and survival across a long endless run with two seeded upgrade pools.

Planned work and known gaps are tracked in [ROADMAP.md](./ROADMAP.md).
