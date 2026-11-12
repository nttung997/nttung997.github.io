# Skyhold

A portrait shooter mixed with tower defense, built with native Canvas, CSS, and JavaScript. No build step, downloads, or external assets are required. Open [index.html](./index.html) directly in a modern browser or visit `/game/` on the deployed site.

## Play

- Enter the battlefield, select a tower, and click or tap a glowing pad to build. Start with 180 credits.
- Launch each wave when ready. Move with WASD or arrow keys; on touch, drag inside the battlefield. Movement is limited to the lower part of the central lane.
- The defender fires automatically. Turn auto-fire off and hold Space for manual fire. Towers always fire automatically.
- Pulse turrets fire quickly, heavy cannons deal splash damage, and frost relays slow enemies. Click a tower to see its range, upgrade it (up to level 3), or sell it for 65% of the total spent.
- Build, sell, and upgrade between waves. Upgrade the defender's twin blasters up to level 4.
- Earn credits from kills and wave bonuses. Each cleared wave repairs 5 base integrity, up to 100.
- Enemies reaching the base and collisions with the defender damage base integrity. The final boss also fires projectiles. Clear all 10 waves to win.
- Press P or Escape to pause. Leaving the tab during combat pauses the game automatically. Restart is available below the game.
- Sound is optional. The best score is stored locally when browser storage is available.

## Development

The game uses a fixed 480 × 680 coordinate system and scales to the available width. Tower statistics, enemy progression, input, simulation, and drawing live in [game.js](./game.js); the responsive layout lives in [style.css](./style.css).

Serve the repository with any static web server when testing over HTTP, for example `python -m http.server 8000`, then open `http://localhost:8000/game/`.

Run `node --test game/game.test.cjs` from the repository root to verify the credit economy, combat restrictions, pause, movement, manual fire, splash and slow effects, wave rewards, defeat/restart, and a simulated ten-wave victory. The tests use Node's built-in test runner without dependencies.
