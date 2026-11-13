// Run with: node --test game/game.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function createGame(initialSeed = 19) {
  const elements = new Map();
  // A draw-capable 2D context stub: every method is a no-op and every property is
  // assignable, so draw() can be exercised in tests without a browser.
  function makeContext() {
    return new Proxy({}, {
      get(target, key) {
        if (key in target) return target[key];
        if (key === 'canvas') return { width: 480, height: 680 };
        return (...args) => {
          if (key === 'createLinearGradient') return { addColorStop() {} };
          if (key === 'measureText') return { width: String(args[0] ?? '').length * 6 };
          return undefined;
        };
      },
      set(target, key, value) { target[key] = value; return true; }
    });
  }
  function makeElement() {
    const context = makeContext();
    return { checked: false, hidden: false, disabled: false, style: {}, dataset: {}, listeners: {}, children: [],
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(name, handler) { this.listeners[name] = handler; },
      append(...nodes) { this.children.push(...nodes); }, replaceChildren(...nodes) { this.children = nodes; },
      setAttribute() {}, focus() {}, getContext() { return context; },
      getBoundingClientRect() { return { width: 480, height: 680, left: 0, top: 0 }; } };
  }
  const element = id => { if (!elements.has(id)) elements.set(id, makeElement()); return elements.get(id); };
  let seed = initialSeed;
  const math = Object.create(Math);
  math.random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const sandbox = { Math: math,
    document: { getElementById: element, createElement: makeElement, body: makeElement(), addEventListener() {} },
    window: { addEventListener() {} }, localStorage: { getItem: () => null, setItem() {} },
    setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame() {} };
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(__dirname, 'game.js'), 'utf8'), anchor = 'reset(); requestAnimationFrame(frame);';
  assert.ok(source.includes(anchor), 'test instrumentation anchor exists');
  vm.runInContext(source.replace(anchor, `
    globalThis.game = { reset, beginRun, update, spawn, hit, damageBase, togglePause,
      aimTarget, firePilot, shotPattern, updateUI, gainXP, requestUpgrade, chooseUpgrade, nextLevelXP, upgrades,
      applyChill, applyRad, applyGravity, applyBulletHit, damageOverTime, chillSpeedFactor, cryoShatterGap,
      weapons, WEAPON_IDS, evolutions, EVOLUTION_IDS, upgradeData, chooseWeapon, activeWeaponId, weaponRank,
      fireVolley, fireRounds, radDps, radRisk, radAimTarget, radStacks, radDpsPerStack, blasterTarget, weaponTarget,
      weaponAims, dropMine, detonateMine, mineDamage, syncWeapons, pickChoices, draw,
      getState: () => state, move: (x, y) => { pointer = { x, y }; }, keys, isPaused: () => paused, releaseInputs };
    reset();
  `), sandbox);
  return { ...sandbox.game, element };
}
function visibleEnemy(game, type, x, y) {
  game.spawn(type);
  const enemy = game.getState().enemies.at(-1);
  enemy.x = enemy.originX = x; enemy.y = y;
  return enemy;
}

test('kills grant XP once and offer three distinct upgrades while combat freezes', () => {
  const game = createGame(); game.beginRun();
  const enemy = visibleEnemy(game, 'drone', 200, 250);
  game.hit(enemy, 1000, false); game.hit(enemy, 1000, false);
  assert.equal(game.getState().xp, 5); assert.equal(game.getState().kills, 1);
  game.gainXP(13); assert.equal(game.requestUpgrade(), true);
  const state = game.getState();
  assert.equal(state.level, 2); assert.equal(state.xp, 0); assert.equal(new Set(state.choices).size, 3);
  assert.equal(game.element('upgrade-modal').hidden, false);
  const before = JSON.stringify(state);
  for (let i = 0; i < 120; i++) game.update(1 / 60);
  assert.equal(JSON.stringify(state), before);
  const choice = state.choices[0]; game.chooseUpgrade(choice);
  assert.equal(state.phase, 'combat'); assert.equal(state.build[choice], 1);
  assert.equal(game.element('upgrade-modal').hidden, true);
});

test('overflow XP requires separate choices and ignores upgrades not offered', () => {
  const game = createGame(); game.beginRun(); game.gainXP(48); game.requestUpgrade();
  const state = game.getState(), invalid = Object.keys(game.upgrades).find(id => !state.choices.includes(id));
  game.chooseUpgrade(invalid); assert.equal(state.phase, 'upgrade'); assert.equal(state.build[invalid], undefined);
  game.chooseUpgrade(state.choices[0]); assert.equal(state.level, 3); assert.equal(state.phase, 'upgrade');
  game.chooseUpgrade(state.choices[0]); assert.equal(state.xp, 0); assert.equal(state.phase, 'combat');
  // The starting weapon already occupies rank 1, plus the two chosen ranks.
  assert.equal(Object.values(state.build).reduce((sum, count) => sum + count, 0), 3);
});

test('capped upgrades and full-health repairs are excluded from choices', () => {
  const game = createGame(); game.beginRun();
  const state = game.getState();
  // Max the weapon rank and both exclusive projectile passives so the pool below is the
  // remaining passives only; the evolution card is the one extra entry that may appear.
  state.build.damage = game.upgrades.damage.max; state.build.blaster = game.weapons.blaster.max;
  state.build.pierce = game.upgrades.pierce.max; state.build.blast = game.upgrades.blast.max;
  const remainingRanks = Object.entries(game.upgrades).reduce((sum, [id, upgrade]) => id === 'repair' ? sum : sum + upgrade.max - (state.build[id] || 0), 0);
  for (let i = 0; i < remainingRanks; i++) {
    game.gainXP(game.nextLevelXP(state.level)); game.requestUpgrade();
    assert.ok(!state.choices.includes('damage')); assert.ok(!state.choices.includes('repair'));
    for (const id of state.choices) assert.ok((state.build[id] || 0) < (game.upgrades[id] || game.weapons[id] || game.evolutions[id]).max);
    // Prefer the ordinary passive pool so this test measures caps, not the evolution path.
    game.chooseUpgrade(state.choices.find(id => !game.evolutions[id] && !game.weapons[id]) || state.choices[0]);
  }
  game.gainXP(game.nextLevelXP(state.level)); game.requestUpgrade();
  // Once every passive is capped, a healthy base sees only the ready evolution or repair.
  assert.equal(state.choices.length, 1); assert.ok(['repair', 'arc'].includes(state.choices[0]));
});

test('auto aim chooses the nearest live visible enemy and retargets after death', () => {
  const game = createGame(); game.beginRun(); const state = game.getState();
  const far = visibleEnemy(game, 'tank', 100, 120), near = visibleEnemy(game, 'tank', 340, 430);
  visibleEnemy(game, 'drone', 240, -10);
  assert.equal(game.aimTarget(), near);
  game.firePilot(near); const bullet = state.bullets[0];
  assert.ok(bullet.vx > 0); assert.ok(bullet.vy < 0);
  game.hit(near, 1000, false); assert.equal(game.aimTarget(), far);
  game.hit(far, 1000, false); assert.equal(game.aimTarget(), null);
});

test('manual fire uses auto aim and movement remains inside the battlefield', () => {
  const game = createGame(); game.beginRun(); game.element('auto-fire').checked = false;
  visibleEnemy(game, 'tank', 300, 300); game.move(-100, 1000);
  for (let i = 0; i < 150; i++) game.update(1 / 60);
  assert.equal(game.getState().pilot.x, 30); assert.equal(game.getState().pilot.y, 593);
  assert.equal(game.getState().bullets.length, 0);
  game.keys.add('Space'); game.update(1 / 60);
  assert.equal(game.getState().bullets.length, 1); assert.ok(game.getState().bullets[0].vx > 0);
});

test('piercing hits each enemy once; frost and explosions affect nearby enemies', () => {
  const game = createGame(); game.beginRun(); game.element('auto-fire').checked = false;
  const state = game.getState(); state.build.frost = 1;
  const first = visibleEnemy(game, 'tank', 230, 250), second = visibleEnemy(game, 'tank', 245, 250);
  state.bullets.push({ x: 230, y: 250, vx: 0, vy: 0, life: 2, damage: 10, splash: 0, slow: true,
    pierce: 1, hitEnemies: new Set(), radius: 3, color: '#a6baff' });
  game.update(1 / 60);
  assert.equal(first.hp, first.maxHp - 10); assert.equal(second.hp, second.maxHp - 10);
  assert.ok(first.slow > 0); const hp = first.hp, y = first.y;
  game.update(1 / 60);
  assert.equal(first.hp, hp); assert.ok(first.y - y < first.speed / 60 * .7);
  assert.equal(second.hp, second.maxHp - 10);
  state.bullets.push({ x: first.x, y: first.y, vx: 0, vy: 0, life: 2, damage: 15, splash: 40, slow: true,
    pierce: 0, hitEnemies: new Set(), radius: 3, color: '#a6baff' });
  game.update(1 / 60);
  assert.equal(first.hp, first.maxHp - 25); assert.equal(second.hp, second.maxHp - 25);
});

test('pause freezes combat and repair caps at full health', () => {
  const game = createGame(); game.beginRun(); game.togglePause();
  const before = JSON.stringify(game.getState()); game.update(1);
  assert.equal(JSON.stringify(game.getState()), before); game.togglePause();
  const state = game.getState(); game.damageBase(10);
  assert.equal(state.health, 90);
  game.gainXP(18); game.requestUpgrade(); state.choices = ['repair']; game.chooseUpgrade('repair');
  assert.equal(state.health, 100); assert.equal(state.build.repair, 1);
});

test('losing focus does not pause the run', () => {
  // The simulation must keep running when the tab or window loses focus; only held inputs
  // are released. The handler is wired on window blur and document visibilitychange.
  const game = createGame(); game.beginRun(); const state = game.getState();
  assert.equal(state.phase, 'combat');
  game.releaseInputs();
  game.update(1);
  assert.equal(state.phase, 'combat', 'blur must not stop combat');
  assert.equal(game.isPaused(), false, 'blur must not set the pause flag');
  assert.ok(state.runTime > 0, 'the simulation keeps advancing after losing focus');
});

test('upgrade choices freeze spawning, threat, and combat', () => {
  const game = createGame(); game.beginRun(); const state = game.getState();
  game.gainXP(18); game.requestUpgrade();
  const snapshot = () => JSON.stringify({ runTime: state.runTime, spawnClock: state.spawnClock, threat: state.threat, enemies: state.enemies.length });
  const before = snapshot(); game.update(10);
  assert.equal(snapshot(), before);
  game.chooseUpgrade(state.choices[0]);
  assert.equal(state.phase, 'combat'); game.update(1);
  assert.ok(state.runTime > 0);
});

test('clearing the field does not end the run or repair the base', () => {
  const game = createGame(); game.beginRun(); const state = game.getState();
  state.enemies = []; state.spawnClock = 1e9; state.health = 70;
  game.update(1 / 60);
  assert.equal(state.phase, 'combat'); assert.equal(state.health, 70);
  assert.ok(state.runTime > 0); assert.equal('spawnQueue' in state, false); assert.equal('wave' in state, false);
});

test('leaks award no XP; defeat and restart clear the run and upgrade dialog', () => {
  const game = createGame(); game.beginRun(); const state = game.getState();
  visibleEnemy(game, 'boss', 240, 624); game.update(1 / 60);
  assert.equal(state.phase, 'lost'); assert.equal(state.health, 0); assert.equal(state.xp, 0);
  game.reset(); game.beginRun(); game.gainXP(18); game.requestUpgrade(); game.reset();
  assert.equal(game.getState().phase, 'ready'); assert.equal(game.getState().level, 1);
  assert.equal(Object.keys(game.getState().build).length, 0); assert.equal(game.element('upgrade-modal').hidden, true);
});

test('automatic and manual firing stay at one cycle per second', () => {
  for (const manual of [false, true]) {
    const game = createGame(); game.beginRun(); const state = game.getState();
    const enemy = visibleEnemy(game, 'tank', 240, 100); enemy.hp = enemy.maxHp = 100000; enemy.speed = 0;
    game.element('auto-fire').checked = !manual;
    if (manual) game.keys.add('Space');
    const firedAt = [];
    for (let tick = 0; tick < 180; tick++) {
      game.update(1 / 60);
      if (state.bullets.length) firedAt.push(tick / 60);
      state.bullets = [];
    }
    assert.equal(firedAt.length, 3);
    assert.equal(firedAt[1] - firedAt[0], 1); assert.equal(firedAt[2] - firedAt[1], 1);
    assert.equal('rapid' in game.upgrades, false); assert.equal(game.element('rate-stat').textContent, '1 Hz');
  }
});

test('blaster ranks widen the volley through 1×1, 1×2, 2×2, 2×3, 3×3', () => {
  const expected = [[1, 1], [1, 2], [2, 2], [2, 3], [3, 3]];
  for (let rank = 1; rank <= 5; rank++) {
    const game = createGame(); game.beginRun(); const state = game.getState();
    game.element('auto-fire').checked = false;
    state.build.blaster = rank;
    const enemy = visibleEnemy(game, 'tank', 240, 100); enemy.hp = enemy.maxHp = 100000; enemy.speed = 0;
    game.firePilot(enemy);
    const [bursts, parallel] = expected[rank - 1];
    assert.equal(game.shotPattern().bursts, bursts);
    assert.equal(game.shotPattern().parallel, parallel);
    assert.equal(state.bullets.length, parallel);
    assert.equal(state.weapons[0].pendingBursts.length, bursts - 1);
    const volley = state.bullets;
    for (let index = 1; index < volley.length; index++) {
      const dx = volley[index].x - volley[index - 1].x, dy = volley[index].y - volley[index - 1].y;
      assert.ok(Math.abs(Math.hypot(dx, dy) - 8) < 1e-9);
    }
    // Parallel rounds fan out: the centre lane flies straight and the outer lanes diverge
    // in opposite directions.
    if (parallel > 1) {
      assert.ok(volley[0].vx < 0 && volley[volley.length - 1].vx > 0, 'outer lanes should fan out');
      if (parallel % 2 === 1) assert.ok(Math.abs(volley[(parallel - 1) / 2].vx) < 1e-9);
    }
    let emitted = parallel; state.bullets = [];
    for (let tick = 0; tick < 60; tick++) {
      game.update(1 / 60);
      if (state.bullets.length) assert.equal(state.bullets.length, parallel);
      emitted += state.bullets.length; state.bullets = [];
    }
    assert.equal(emitted, bursts * parallel);
    assert.equal(state.weapons[0].pendingBursts.length, 0);
  }
});

test('3×3 fires three bursts of three parallel bullets every second', () => {
  const game = createGame(); game.beginRun(); const state = game.getState();
  state.build.blaster = game.weapons.blaster.max;
  game.updateUI();
  const enemy = visibleEnemy(game, 'tank', 240, 100); enemy.hp = enemy.maxHp = 100000; enemy.speed = 0;
  const emittedAt = []; let total = 0;
  for (let tick = 0; tick < 180; tick++) {
    game.update(1 / 60);
    const count = state.bullets.filter(bullet => Math.abs(bullet.life - (2 - 1 / 60)) < 1e-9).length;
    if (count) { assert.equal(count, 3); total += count; emittedAt.push(tick / 60); }
  }
  assert.equal(total, 27); assert.equal(emittedAt.length, 9);
  const schedule = [0, .20, .40];
  emittedAt.forEach((time, index) => {
    const expected = Math.floor(index / 3) + schedule[index % 3];
    assert.ok(Math.abs(time - expected) <= 1 / 60 + 1e-9, time + ' vs ' + expected);
  });
  assert.equal(game.element('shot-stat').textContent, '3×3');
  assert.equal(game.element('shot-total').textContent, '9 bullets per cycle · bursts × parallel bullets');
  assert.equal(game.element('rate-stat').textContent, '1 Hz');
});

test('blaster rank is capped at five', () => {
  const game = createGame(); game.beginRun(); const state = game.getState();
  state.build.blaster = 10;
  const enemy = visibleEnemy(game, 'tank', 240, 100);
  game.firePilot(enemy); assert.equal(state.bullets.length, 3);
  assert.equal(state.weapons[0].pendingBursts.length, 2);
  assert.equal(game.shotPattern().bursts, 3); assert.equal(game.shotPattern().parallel, 3);
  assert.equal(game.weapons.blaster.max, 5);
  assert.equal('multishot' in game.upgrades, false);
  assert.equal('burst' in game.upgrades, false);
});

test('scheduled bursts freeze during pause and upgrade selection and retarget after a kill', () => {
  const game = createGame(); game.beginRun(); const state = game.getState();
  state.build.blaster = game.weapons.blaster.max;
  const weapon = state.weapons[0];
  const near = visibleEnemy(game, 'tank', 340, 430), far = visibleEnemy(game, 'tank', 100, 120);
  game.firePilot(near); assert.ok(state.bullets[0].vx > 0);
  const pending = JSON.stringify(weapon.pendingBursts), cooldown = weapon.cooldown;
  game.togglePause(); game.update(1);
  assert.equal(JSON.stringify(weapon.pendingBursts), pending); assert.equal(weapon.cooldown, cooldown);
  game.togglePause(); game.gainXP(18); game.requestUpgrade(); game.update(1);
  assert.equal(JSON.stringify(weapon.pendingBursts), pending); assert.equal(weapon.cooldown, cooldown);
  // Pick a passive, not a weapon rank: a rank would reset the burst queue by design.
  const passive = state.choices.find(id => game.upgrades[id] && id !== 'repair');
  assert.ok(passive, 'a passive card should be offered: ' + state.choices);
  game.chooseUpgrade(passive);
  game.hit(near, 1000, false); state.bullets = [];
  for (let tick = 0; tick < 18; tick++) game.update(1 / 60);
  assert.equal(state.bullets.length, 3); assert.ok(state.bullets.every(bullet => bullet.vx < 0));
  assert.equal(game.aimTarget(), far);
});

test('defeat and restart cancel scheduled bursts', () => {
  for (const action of ['defeat', 'restart']) {
    const game = createGame(); game.beginRun(); const state = game.getState();
    state.build.blaster = game.weapons.blaster.max;
    const enemy = visibleEnemy(game, 'tank', 240, 100); game.firePilot(enemy);
    assert.equal(state.weapons[0].pendingBursts.length, 2);
    if (action === 'defeat') game.damageBase(100);
    else game.reset();
    assert.equal((game.getState().weapons[0]?.pendingBursts || []).length, 0);
  }
});

test('auto aim and earned upgrades survive a long endless run', () => {
  // Greedy fixed-priority play is deliberately brittle: the bot cannot adapt when its
  // first choice is not offered, and measured survival is around 44% across two
  // independent 50-seed families. Assert a floor that catches real regressions without
  // encoding one lucky seed family as the expected outcome.
  const seeds = [19, 37, 3, 7, 11, 23, 41, 53, 67, 79, 83, 97, 101, 113, 127, 131, 149, 163, 179, 191];
  let survived = 0;
  const losses = [];
  for (const seed of seeds) {
    const game = createGame(seed); game.beginRun(); const state = game.getState();
    // A sensible player prioritises scaling damage and survivability, then widens the
    // blaster's shot pattern. The evolution id must be listed because the pool can offer it.
    const priority = ['damage', 'blaster', 'pierce', 'frost', 'arc', 'blast', 'repair'];
    for (let tick = 0; tick < 60 * 300 && state.phase !== 'lost'; tick++) {
      if (state.phase === 'upgrade') {
        const choice = state.health < 55 && state.choices.includes('repair') ? 'repair' : priority.find(id => state.choices.includes(id));
        assert.ok(choice, 'seed ' + seed + ' offered no pickable choice: ' + state.choices);
        game.chooseUpgrade(choice);
      } else { game.move(240, 550); game.update(1 / 60); }
    }
    // Every run must be a real run, whether or not it survived the full window.
    assert.ok(state.kills > 0 && state.level > 1, 'seed ' + seed + ' made no progress');
    if (state.phase === 'combat') {
      survived++;
      assert.ok(state.runTime > 240, 'surviving seed ' + seed + ' ran the full window');
      assert.ok(state.threat > 8, 'surviving seed ' + seed + ' reached real threat');
    } else losses.push(seed);
  }
  // Measured baseline is ~44%; 25% is a floor that still catches a broken upgrade pool.
  assert.ok(survived >= 5, 'at least 5/20 seeds should survive, lost: ' + losses.join(', '));
});

test('enemies have more health, speed, and damage and scale up with threat', () => {
  const game = createGame(); game.beginRun(); const state = game.getState();
  const originals = { drone: [35, 30, 6], runner: [23, 53.8, 4], tank: [130, 21, 13], boss: [2400, 14, 100] };
  for (const [type, original] of Object.entries(originals)) {
    const first = visibleEnemy(game, type, 240, 100);
    assert.ok(first.hp > original[0]); assert.ok(first.speed > original[1]); assert.ok(first.damage >= original[2]);
    state.threat = 10; const late = visibleEnemy(game, type, 240, 100);
    if (type !== 'boss') { assert.ok(late.hp > first.hp); assert.ok(late.speed > first.speed); }
    state.threat = 1;
  }
});

test('threat rises over time and siege carriers appear every four threats', () => {
  const game = createGame(); game.beginRun(); const state = game.getState();
  state.spawnClock = 1e9;
  let bosses = 0;
  for (const step of [31, 29, 30, 30, 30]) {
    game.update(step);
    bosses += state.enemies.filter(enemy => enemy.type === 'boss').length;
    state.enemies = [];
  }
  assert.equal(state.phase, 'combat');
  assert.equal(state.threat, 6);
  assert.equal(bosses, 1);
  assert.equal(game.element('threat').innerHTML, '∞<span> THREAT 6</span>');
});

test('a run locks exactly one weapon with its own cooldown', () => {
  for (const id of ['blaster', 'gravity', 'cryo', 'rad', 'orbit', 'mines']) {
    const game = createGame(); game.chooseWeapon(id); const state = game.getState(); state.spawnClock = 1e9;
    assert.equal(state.weaponId, id);
    assert.equal(state.weapons.length, 1, id + ' must have exactly one instance');
    assert.equal(state.weapons[0].id, id);
    assert.equal(state.weapons[0].cooldown, 0, id + ' starts ready');
    const data = game.upgradeData(id);
    const hz = 1 / data.interval;
    assert.equal(game.element('rate-stat').textContent, (Number.isInteger(hz) ? hz : hz.toFixed(1)) + ' Hz');
    assert.equal(game.element('weapon-count').textContent, '1 WEAPON · ' + data.tag);
  }
});

test('mines arm before detonating and damage enemies in range', () => {
  const game = createGame(); game.chooseWeapon('mines'); const state = game.getState(); state.spawnClock = 1e9;
  game.element('auto-fire').checked = false;
  state.enemies.length = 0;
  const enemy = visibleEnemy(game, 'tank', 240, 505); enemy.hp = enemy.maxHp = 100000; enemy.speed = 0; enemy.attackClock = 1e9;
  game.keys.add('Space'); game.update(1 / 60);
  assert.equal(state.mines.length, 1, 'a charge should be dropped');
  const mine = state.mines[0];
  assert.ok(mine.arm > 0, 'the charge must arm before it can detonate');
  const before = enemy.hp;
  for (let tick = 0; tick < 60 && state.mines.includes(mine); tick++) game.update(1 / 60);
  assert.equal(state.mines.includes(mine), false, 'the charge detonates on contact');
  assert.ok(enemy.hp < before, 'the blast damages the enemy');
});

test('orbital drone damages on contact and orbits without aiming', () => {
  const game = createGame(); game.chooseWeapon('orbit'); const state = game.getState(); state.spawnClock = 1e9;
  const orbit = state.weapons[0];
  const startPhase = orbit.phase;
  game.element('auto-fire').checked = true;
  const enemy = visibleEnemy(game, 'tank', 240, 480); enemy.hp = enemy.maxHp = 100000; enemy.speed = 0; enemy.attackClock = 1e9;
  game.update(1 / 60);
  assert.notEqual(orbit.phase, startPhase);
  assert.equal(state.bullets.length, 0);
  let damaged = false;
  for (let tick = 0; tick < 120 && !damaged; tick++) { game.update(1 / 60); if (enemy.hp < enemy.maxHp) damaged = true; }
  assert.ok(damaged, 'the drone should contact the enemy as it orbits');
  assert.equal(game.weaponAims('orbit'), false);
});

test('the locked weapon stops firing when auto-fire is off and Space is released', () => {
  const game = createGame(); game.chooseWeapon('orbit'); const state = game.getState(); state.spawnClock = 1e9;
  const weapon = state.weapons[0];
  game.element('auto-fire').checked = false;
  state.enemies.length = 0;
  game.update(1 / 60);
  assert.equal(weapon.cooldown, 0);
  game.keys.add('Space'); game.update(1 / 60);
  assert.ok(weapon.cooldown > 0);
});

test('arc laser evolution is gated on a maxed blaster plus its paired passive', () => {
  const game = createGame(); game.beginRun(); const state = game.getState();
  assert.equal(game.evolutions.arc.ready(), false, 'no prerequisite ranks yet');
  state.build = { pierce: 1 };
  assert.equal(game.evolutions.arc.ready(), false, 'the paired passive alone is not enough');
  state.build = { blaster: game.weapons.blaster.max };
  assert.equal(game.evolutions.arc.ready(), false, 'a maxed weapon alone is not enough');
  state.build = { blaster: game.weapons.blaster.max, pierce: 1 };
  assert.equal(game.evolutions.arc.ready(), true);
  // The card enters the pool only while the gate is met and leaves it once owned.
  assert.ok(Array.from({ length: 50 }, () => game.pickChoices()).some(choices => choices.includes('arc')));
  state.build.arc = 1;
  assert.equal(game.evolutions.arc.ready(), false);
  assert.ok(Array.from({ length: 50 }, () => game.pickChoices()).every(choices => !choices.includes('arc')));
});

test('taking the arc laser removes the blaster and the evolved weapon starts ready', () => {
  const game = createGame(); game.beginRun(); const state = game.getState();
  state.build = { blaster: game.weapons.blaster.max, pierce: 1 };
  assert.equal(state.weapons[0].id, 'blaster');
  game.gainXP(18); assert.equal(game.requestUpgrade(), true);
  state.choices = ['arc']; game.chooseUpgrade('arc');
  assert.equal(state.build.arc, 1);
  assert.equal(state.build.blaster, undefined, 'the base rank is removed');
  assert.equal(state.weapons.length, 1);
  const arc = state.weapons[0];
  assert.equal(arc.id, 'arc', 'the evolved weapon takes the slot');
  assert.equal(arc.cooldown, 0, 'the evolution fires immediately');
  // The retired blaster can no longer fire, even when asked directly.
  const enemy = visibleEnemy(game, 'tank', 240, 200); state.bullets = [];
  game.firePilot(enemy); assert.equal(state.bullets.length, 0);
});

test('arc laser damages every enemy along the aim line and nothing beside it', () => {
  const game = createGame(); game.beginRun(); const state = game.getState(); state.spawnClock = 1e9;
  state.build = { blaster: game.weapons.blaster.max, pierce: 1 };
  game.gainXP(18); game.requestUpgrade(); state.choices = ['arc']; game.chooseUpgrade('arc');
  game.element('auto-fire').checked = true;
  state.enemies.length = 0;
  const aligned = visibleEnemy(game, 'tank', 240, 200), beside = visibleEnemy(game, 'tank', 120, 200);
  aligned.hp = aligned.maxHp = 100000; beside.hp = beside.maxHp = 100000;
  aligned.speed = beside.speed = 0;
  const alignedHp = aligned.hp, besideHp = beside.hp;
  game.update(1 / 60);
  assert.ok(aligned.hp < alignedHp, 'the enemy in the beam takes damage');
  assert.equal(beside.hp, besideHp, 'an enemy beside the beam is untouched');
  assert.equal(state.bullets.length, 0, 'the beam is not a projectile');
  assert.ok(state.effects.some(effect => effect.beam));
  assert.equal(game.element('rate-stat').textContent, '5 Hz');
  // Auto-fire still gates the evolution, exactly like every other weapon.
  game.element('auto-fire').checked = false; state.effects = [];
  const hpBefore = aligned.hp; game.update(1 / 60);
  assert.equal(aligned.hp, hpBefore);
});

test('cryo stacks slow less each time, then crawl until the shatter gap', () => {
  const game = createGame(); game.chooseWeapon('cryo'); const state = game.getState(); state.spawnClock = 1e9;
  assert.equal(game.weaponAims('cryo'), true);
  game.element('auto-fire').checked = false;
  const enemy = visibleEnemy(game, 'drone', 240, 300);
  enemy.speed = 40; enemy.hp = enemy.maxHp = 1000;
  // One stack slows but deals no damage, and the second stack cuts less speed than the first.
  const hpBefore = enemy.hp;
  game.applyChill(enemy, 1);
  const afterFirst = enemy.speed * (1 - enemy.chill);
  const firstCut = enemy.speed - afterFirst;
  assert.ok(enemy.chill > 0 && enemy.chill < 1);
  assert.ok(game.chillSpeedFactor(enemy) < 1);
  assert.equal(enemy.frozen, false);
  assert.equal(enemy.hp, hpBefore, 'slow stacks must not deal damage');
  game.applyChill(enemy, 1);
  const afterSecond = enemy.speed * (1 - enemy.chill);
  const secondCut = afterFirst - afterSecond;
  assert.ok(secondCut < firstCut - 1e-9, 'each stack should slow less than the previous one');
  assert.equal(enemy.hp, hpBefore);
  // Reaching the crawl freezes the enemy without killing it, and speed floors at 10.
  while (!enemy.frozen) game.applyChill(enemy, 1);
  assert.equal(enemy.hp, hpBefore, 'the crawl is not a kill');
  assert.ok(Math.abs(enemy.speed * game.chillSpeedFactor(enemy) - 10) < 1e-6, 'frozen forward speed floors at 10');
  const y = enemy.y;
  game.update(1);
  assert.ok(Math.abs(enemy.y - y - 10) < 1e-6, 'a frozen enemy keeps crawling');
  // Stacks short of the gap do nothing. The hit that fills the gap executes.
  assert.equal(game.cryoShatterGap(enemy), 9, 'a single round at threat 1 owes about four seconds of crawl');
  state.build.cryo = game.weapons.cryo.max;
  assert.equal(game.cryoShatterGap(enemy), 27, 'a 3×3 volley owes more stacks so the crawl survives the wider pattern');
  state.threat = 8;
  assert.equal(game.cryoShatterGap(enemy), 43, 'threat stretches the crawl on top of the wider volley');
  state.build.cryo = 1; state.threat = 1;
  const need = enemy.cryoFreezeStacks + game.cryoShatterGap(enemy);
  while (enemy.cryoStacks < need - 1) game.applyChill(enemy, 1);
  assert.equal(enemy.hp, hpBefore, 'stacks short of the gap must not kill');
  game.hit(enemy, 0, false);
  assert.equal(enemy.hp, hpBefore, 'a hit before the gap must not shatter');
  game.applyChill(enemy, 1);
  assert.equal(enemy.hp, hpBefore, 'crossing the gap without a hit must not kill');
  game.hit(enemy, 0, false);
  assert.equal(enemy.hp, 0, 'filling the shatter gap executes the target');
  assert.equal(enemy.frozen, false);
  assert.equal(enemy.cryoStacks, 0);
  // A fresh target: frost rounds are projectiles with a slow-stack payload and no damage.
  const next = visibleEnemy(game, 'drone', 240, 200);
  next.speed = 40; next.hp = next.maxHp = 1000;
  game.weapons.cryo.fire(state.weapons[0], next);
  const bullet = state.bullets.at(-1);
  assert.equal(bullet.weaponId, 'cryo');
  assert.equal(bullet.damage, 0);
  assert.ok(bullet.stacks >= 1);
  assert.ok(bullet.splash > 0);
});

test('cryo frost bursts stack slow on nearby enemies without damage', () => {
  const game = createGame(); game.chooseWeapon('cryo'); const state = game.getState(); state.spawnClock = 1e9;
  game.element('auto-fire').checked = false;
  const primary = visibleEnemy(game, 'drone', 240, 300);
  const nearby = visibleEnemy(game, 'drone', 280, 300);
  const far = visibleEnemy(game, 'drone', 380, 300);
  for (const enemy of [primary, nearby, far]) { enemy.speed = 80; enemy.hp = enemy.maxHp = 1000; }
  game.weapons.cryo.fire(state.weapons[0], primary);
  for (let tick = 0; tick < 60 && state.bullets.length; tick++) game.update(1 / 60);
  assert.ok(primary.cryoStacks > 0, 'a direct hit should stack slow');
  assert.ok(nearby.cryoStacks > 0, 'the impact burst should stack slow nearby');
  assert.equal(far.cryoStacks || 0, 0, 'enemies outside the burst stay warm');
  assert.ok(primary.chill > 0 && nearby.chill > 0);
  assert.equal(primary.hp, 1000); assert.equal(nearby.hp, 1000); assert.equal(far.hp, 1000);
});

test('cryo ranks widen the volley from 1×1 to 3×3', () => {
  const game = createGame(); game.chooseWeapon('cryo'); const state = game.getState(); state.spawnClock = 1e9;
  game.element('auto-fire').checked = false;
  const enemy = visibleEnemy(game, 'tank', 240, 100);
  enemy.speed = 0; enemy.hp = enemy.maxHp = 100000;
  assert.equal(game.element('shot-stat').textContent, '1×1');
  state.build.cryo = game.weapons.cryo.max;
  game.updateUI();
  assert.equal(game.element('shot-stat').textContent, '3×3');
  game.weapons.cryo.fire(state.weapons[0], enemy);
  assert.equal(state.bullets.length, 3, 'the first burst fires three parallel rounds');
  for (let tick = 0; tick < 24; tick++) game.update(1 / 60);
  assert.equal(state.bullets.length, 9, 'three bursts of three rounds per cycle');
});

test('slow per stack scales with enemy max HP', () => {
  const game = createGame(); game.beginRun(); const state = game.getState(); state.spawnClock = 1e9;
  const drone = visibleEnemy(game, 'drone', 200, 200);
  const tank = visibleEnemy(game, 'tank', 280, 200);
  const boss = visibleEnemy(game, 'boss', 240, 100);
  for (const enemy of [drone, tank, boss]) game.applyChill(enemy, 1);
  assert.ok(drone.chill > tank.chill, 'trash should slow faster than tanks');
  assert.ok(tank.chill > boss.chill, 'tanks should slow faster than bosses');
  assert.ok(drone.hp > 0 && tank.hp > 0 && boss.hp > 0, 'one stack must never kill');
});

test('enough slow stacks crawl a boss, then the gap executes it', () => {
  const game = createGame(); game.beginRun(); const state = game.getState(); state.spawnClock = 1e9;
  const boss = visibleEnemy(game, 'boss', 240, 200);
  let stacks = 0;
  while (!boss.frozen && stacks < 200) { game.applyChill(boss, 1); stacks++; }
  assert.equal(boss.frozen, true, 'a boss reaches the crawl with enough stacks');
  assert.ok(stacks > 1, 'a boss should need more than one stack');
  assert.equal(boss.hp, boss.maxHp, 'the crawl must not kill a boss');
  assert.equal(game.cryoShatterGap(boss), 9, 'the pile shares one gap; a boss is slower to reach the crawl, not slower after it');
  const hp = boss.hp;
  while (boss.cryoStacks < boss.cryoFreezeStacks + game.cryoShatterGap(boss)) game.applyChill(boss, 1);
  assert.equal(boss.hp, hp, 'the gap itself does not deal damage');
  game.hit(boss, 0, false);
  assert.equal(boss.hp, 0, 'filling the shatter gap executes the boss');
});

test('frozen enemies stay crawling instead of shattering on their own', () => {
  const game = createGame(); game.beginRun(); const state = game.getState(); state.spawnClock = 1e9;
  game.element('auto-fire').checked = false;
  state.enemies.length = 0;
  // A row of crawlers. They used to self-break after 0.9s; they now stay until the
  // shatter gap is filled, which is what keeps the pile on the field.
  const enemies = [];
  for (let i = 0; i < 5; i++) {
    const enemy = visibleEnemy(game, 'drone', 120 + i * 40, 200);
    enemy.speed = 40; enemy.hp = enemy.maxHp = 200;
    while (!enemy.frozen) game.applyChill(enemy, 1);
    enemies.push(enemy);
  }
  assert.ok(enemies.every(enemy => enemy.frozen));
  const hp = enemies.map(enemy => enemy.hp);
  for (let i = 0; i < 150; i++) game.update(1 / 60);
  assert.ok(enemies.every((enemy, index) => enemy.hp === hp[index] && enemy.frozen), 'crawlers should survive without more stacks');
});

test('a hit does not shatter a frozen enemy before the stack gap', () => {
  const game = createGame(); game.beginRun(); const state = game.getState(); state.spawnClock = 1e9;
  const enemy = visibleEnemy(game, 'drone', 240, 300);
  enemy.speed = 40; enemy.hp = enemy.maxHp = 1000;
  while (!enemy.frozen) game.applyChill(enemy, 1);
  assert.equal(enemy.frozen, true);
  const hp = enemy.hp;
  game.hit(enemy, 5, false);
  assert.equal(enemy.frozen, true, 'a hit should leave the crawl in place');
  assert.equal(enemy.hp, hp - 5, 'the hit deals its own damage and nothing more');
});

test('rad deals damage only over time, stacks without expiring, and ramps', () => {
  const game = createGame(); game.chooseWeapon('rad'); const state = game.getState(); state.spawnClock = 1e9;
  game.element('auto-fire').checked = false;
  const enemy = visibleEnemy(game, 'tank', 240, 300);
  enemy.speed = 0; enemy.hp = enemy.maxHp = 100000;
  const before = enemy.hp;
  game.applyRad(enemy, 1);
  assert.equal(enemy.hp, before, 'applying rad must not deal direct damage');
  assert.equal(enemy.rad, 1, 'one round is one stack');
  // Ticks accumulate, so health falls over time.
  for (let i = 0; i < 60; i++) game.update(1 / 60);
  const oneStackDrop = before - enemy.hp;
  assert.ok(oneStackDrop > 0, 'rad should deal damage over time');
  // Stacks never expire: the investment keeps paying across the whole run.
  for (let i = 0; i < 300; i++) game.update(1 / 60);
  assert.equal(enemy.rad, 1, 'rad stacks must not expire');
  // More stacks means strictly more DPS, which is the ramp the weapon is built around.
  const hpBefore = enemy.hp;
  for (let i = 0; i < 60; i++) game.update(1 / 60);
  const oneStackSecond = hpBefore - enemy.hp;
  game.applyRad(enemy, 9);
  assert.equal(enemy.rad, 10);
  const hpTen = enemy.hp;
  for (let i = 0; i < 60; i++) game.update(1 / 60);
  const tenStackSecond = hpTen - enemy.hp;
  assert.ok(tenStackSecond > oneStackSecond * 5, 'ten stacks should dwarf one stack');
  assert.ok(game.radDps(enemy) > radDpsAtOne(game, enemy));
  // Stacks cap so a single enemy is never an unbounded damage sink.
  for (let i = 0; i < 100; i++) game.applyRad(enemy, 5);
  assert.equal(enemy.rad, 40, 'rad stacks cap at 40');
});
function radDpsAtOne(game, enemy) {
  const saved = enemy.rad;
  enemy.rad = 1;
  const dps = game.radDps(enemy);
  enemy.rad = saved;
  return dps;
}

test('rad damage over time awards XP and score exactly once', () => {
  const game = createGame(); game.beginRun(); const state = game.getState(); state.spawnClock = 1e9;
  const enemy = visibleEnemy(game, 'drone', 240, 300);
  enemy.speed = 0; enemy.hp = 1;
  const xpBefore = state.xp, scoreBefore = state.score;
  game.damageOverTime(enemy, 5);
  assert.equal(state.kills, 1);
  assert.equal(state.xp - xpBefore, enemy.xp);
  assert.ok(state.score > scoreBefore);
  game.damageOverTime(enemy, 5);
  assert.equal(state.kills, 1, 'a dead enemy must not be killed twice');
});

test('damage over time does not spam the flash effect', () => {
  const game = createGame(); game.beginRun(); const state = game.getState(); state.spawnClock = 1e9;
  const enemy = visibleEnemy(game, 'tank', 240, 300);
  enemy.hp = enemy.maxHp = 100000; enemy.flash = 0;
  game.damageOverTime(enemy, 1);
  assert.equal(enemy.flash, 0, 'DoT must not set flash');
});

test('gravity: charged enemies magnetise toward each other and crush on contact', () => {
  const game = createGame(); game.chooseWeapon('gravity'); const state = game.getState(); state.spawnClock = 1e9;
  game.element('auto-fire').checked = false;
  assert.equal(state.weaponId, 'gravity');
  state.enemies.length = 0;
  const left = visibleEnemy(game, 'tank', 220, 500), right = visibleEnemy(game, 'tank', 280, 500);
  left.speed = right.speed = 0; left.hp = left.maxHp = 100000; right.hp = right.maxHp = 100000;
  // Only a charged enemy pulls. At least one must be charged for the magnet to engage.
  for (let i = 0; i < 30; i++) game.update(1 / 60);
  assert.equal(left.driftX, 0, 'uncharged enemies must not be pulled');
  assert.equal(right.driftX, 0, 'uncharged enemies must not be pulled');
  game.applyGravity(left, 6);
  const rightStart = right.x, leftHp = left.hp, rightHp = right.hp;
  for (let i = 0; i < 120; i++) game.update(1 / 60);
  assert.ok(right.x < rightStart, 'a charged enemy should pull its neighbour inward');
  assert.ok(left.hp < leftHp, 'the charged enemy buckles under its own gravity');
  // Keep the magnet running until the pair is close enough to crush.
  for (let i = 0; i < 240 && right.hp === rightHp; i++) game.update(1 / 60);
  assert.ok(right.hp < rightHp, 'the pulled neighbour is crushed once they overlap');
});

test('rad rounds: each round adds stacks and never deals direct damage', () => {
  const game = createGame(); game.chooseWeapon('rad'); const state = game.getState(); state.spawnClock = 1e9;
  game.element('auto-fire').checked = false;
  state.enemies.length = 0;
  const enemy = visibleEnemy(game, 'tank', 240, 200); enemy.speed = 0; enemy.hp = enemy.maxHp = 100000;
  const bullet = { weaponId: 'rad', damage: 0, stacks: 1, slow: false, splash: 0 };
  const before = enemy.hp;
  game.applyBulletHit(enemy, bullet);
  assert.equal(enemy.hp, before, 'rad rounds must not deal direct damage');
  assert.equal(enemy.rad, 1, 'one round adds exactly one stack');
  game.applyBulletHit(enemy, bullet);
  assert.equal(enemy.rad, 2, 'each further round adds one more stack');
  for (let i = 0; i < 60; i++) game.update(1 / 60);
  assert.ok(enemy.hp < before, 'rad should burn the enemy over time');
});

test('rad auto-aim targets the enemy about to leak, not the nearest one', () => {
  const game = createGame(); game.chooseWeapon('rad'); const state = game.getState(); state.spawnClock = 1e9;
  game.element('auto-fire').checked = false;
  state.enemies.length = 0;
  // The near enemy is close to the defender, the far one is almost at the outpost. Nearest
  // aim would pick the near one; rad must pick the leaker.
  const near = visibleEnemy(game, 'drone', 240, 500), leaker = visibleEnemy(game, 'drone', 120, 610);
  near.speed = leaker.speed = 0; near.hp = near.maxHp = 1000; leaker.hp = leaker.maxHp = 1000;
  assert.equal(game.aimTarget(), near, 'baseline aim picks the nearest enemy');
  assert.equal(game.radAimTarget(), leaker, 'rad aim picks the enemy closest to leaking');
  // Saturate both: the aim no longer dumps rounds into the deepest stack. Risk collapses
  // below arrival time, which is the "just enough" behaviour.
  game.applyRad(leaker, 40); game.applyRad(near, 40);
  assert.ok(game.radRisk(leaker).risk < game.radRisk(visibleEnemy(game, 'tank', 240, 200)).risk,
    'a saturated enemy is less attractive than a fresh one');
});

test('rad aim spreads stacks across the field instead of dumping them on one enemy', () => {
  const game = createGame(); game.chooseWeapon('rad'); const state = game.getState(); state.spawnClock = 1e9;
  game.element('auto-fire').checked = false;
  state.enemies.length = 0;
  // Two identical enemies at the same depth: one already saturated, one clean. The clean one
  // is the one still at risk, so the aim must seed it rather than over-stacking the first.
  const saturated = visibleEnemy(game, 'drone', 200, 560), clean = visibleEnemy(game, 'drone', 280, 560);
  saturated.speed = clean.speed = 0; saturated.hp = saturated.maxHp = 1000; clean.hp = clean.maxHp = 1000;
  game.applyRad(saturated, 40);
  assert.equal(game.radAimTarget(), clean);
  const risk = game.radRisk(clean);
  assert.ok(risk.risk > 0, 'a fresh enemy at risk has positive risk (it would leak)');
});

test('rad stacks ramp damage so a boss with many stacks melts', () => {
  const game = createGame(); game.chooseWeapon('rad'); const state = game.getState(); state.spawnClock = 1e9;
  game.element('auto-fire').checked = false;
  state.enemies.length = 0;
  const boss = visibleEnemy(game, 'boss', 240, 200); boss.speed = 0; boss.hp = boss.maxHp = 100000;
  const before = boss.hp;
  for (let i = 0; i < 30; i++) game.applyRad(boss, 1);
  assert.equal(boss.rad, 30);
  for (let i = 0; i < 180; i++) game.update(1 / 60);
  assert.ok(boss.hp < before, 'a heavily irradiated boss must take real damage');
});

test('the blaster deals immediate damage and leaves no status', () => {
  const game = createGame(); game.chooseWeapon('blaster'); const state = game.getState(); state.spawnClock = 1e9;
  state.enemies.length = 0;
  const enemy = visibleEnemy(game, 'tank', 240, 200); enemy.speed = 0; enemy.hp = enemy.maxHp = 100000;
  const before = enemy.hp;
  game.applyBulletHit(enemy, { weaponId: 'blaster', damage: 40, slow: false, splash: 0 });
  assert.equal(enemy.hp, before - 40, 'blaster rounds deal damage on impact');
  assert.equal(enemy.rad, 0); assert.equal(enemy.charge, 0);
});

test('the chosen weapon is locked for the run and reset clears it', () => {
  const game = createGame();
  assert.equal(game.getState().weaponId, null, 'a fresh run has no weapon until one is picked');
  assert.equal(game.getState().phase, 'ready');
  game.chooseWeapon('rad');
  assert.equal(game.getState().weaponId, 'rad');
  assert.equal(game.getState().phase, 'combat');
  // Choosing again mid-run must not switch the weapon.
  game.chooseWeapon('gravity');
  assert.equal(game.getState().weaponId, 'rad', 'the weapon is locked once combat starts');
  game.reset();
  assert.equal(game.getState().weaponId, null);
  assert.equal(game.getState().phase, 'ready');
});

test('beginRun without a prior choice defaults to the blaster', () => {
  const game = createGame(); game.beginRun();
  const state = game.getState();
  assert.equal(state.weaponId, 'blaster');
  assert.equal(state.weapons[0].id, 'blaster');
  const enemy = visibleEnemy(game, 'tank', 240, 200); enemy.speed = 0; enemy.hp = enemy.maxHp = 100000;
  const before = enemy.hp;
  game.applyBulletHit(enemy, { weaponId: 'blaster', damage: 25, slow: false, splash: 0 });
  assert.equal(enemy.hp, before - 25);
});

test('the unified roster is exactly six weapons with one evolution each', () => {
  const game = createGame();
  assert.deepEqual([...game.WEAPON_IDS], ['blaster', 'gravity', 'cryo', 'rad', 'orbit', 'mines']);
  assert.equal('nova' in game.weapons, false);
  assert.equal('poison' in game.weapons, false);
  for (const id of game.WEAPON_IDS) {
    assert.equal(typeof game.weapons[id].fire, 'function', id + ' has a fire function');
    assert.equal(game.weapons[id].max, ['blaster', 'gravity', 'cryo', 'rad'].includes(id) ? 5 : 3);
  }
  const evolutions = Object.values(game.evolutions);
  assert.equal(evolutions.length, 6);
  for (const evo of evolutions) {
    assert.ok(game.WEAPON_IDS.includes(evo.from), evo.name + ' evolves a real weapon');
    assert.ok(evo.requires in game.upgrades, evo.name + ' pairs with a passive');
    assert.equal(evo.max, 1);
  }
});

test('pierce and blast are mutually exclusive and cryo hides frost', () => {
  const game = createGame(); game.beginRun(); const state = game.getState();
  state.build = { pierce: 1 };
  assert.ok(Array.from({ length: 80 }, () => game.pickChoices()).every(choices => !choices.includes('blast')));
  state.build = { blast: 1 };
  assert.ok(Array.from({ length: 80 }, () => game.pickChoices()).every(choices => !choices.includes('pierce')));
  // Cryo already chills; frost rounds never appear in its pool.
  const cryo = createGame(); cryo.chooseWeapon('cryo');
  assert.ok(Array.from({ length: 80 }, () => cryo.pickChoices()).every(choices => !choices.includes('frost')));
  // Other weapons can still be offered frost.
  const blaster = createGame(); blaster.beginRun();
  assert.ok(Array.from({ length: 80 }, () => blaster.pickChoices()).some(choices => choices.includes('frost')));
});

test('every weapon can clear the 300 s window at a comparable rate', () => {
  // Balance guard, not a benchmark. Every weapon is played by the same greedy bot over the
  // same seeded family, so a weapon that cannot keep up with the swarm fails here.
  const seeds = [19, 37, 3, 7, 11, 23, 41, 53, 67, 79];
  for (const weaponId of ['blaster', 'gravity', 'cryo', 'rad', 'orbit', 'mines']) {
    // Buy damage, then the weapon's own rank, then the paired passive for its evolution.
    // All ids are listed because the pool can offer any passive or ready evolution.
    const gate = weaponId === 'blaster' ? 'pierce' : weaponId === 'gravity' || weaponId === 'mines' || weaponId === 'cryo' ? 'blast' : 'damage';
    const priority = ['damage', weaponId, gate, 'pierce', 'blast', 'frost',
      'arc', 'singularity', 'absolute', 'meltdown', 'twin', 'cluster', 'repair'];
    let survived = 0;
    for (const seed of seeds) {
      const game = createGame(seed); game.chooseWeapon(weaponId);
      const state = game.getState();
      for (let tick = 0; tick < 60 * 300 && state.phase !== 'lost'; tick++) {
        if (state.phase === 'upgrade') {
          const choice = state.health < 55 && state.choices.includes('repair') ? 'repair' : priority.find(id => state.choices.includes(id));
          assert.ok(choice, weaponId + ' seed ' + seed + ' offered no pickable choice: ' + state.choices);
          game.chooseUpgrade(choice);
        } else { game.move(240, 550); game.update(1 / 60); }
      }
      assert.ok(state.kills > 0 && state.level > 1, weaponId + ' seed ' + seed + ' made no progress: ' + JSON.stringify({ kills: state.kills, level: state.level, time: state.runTime, phase: state.phase, enemies: state.enemies.length }));
      if (state.phase === 'combat') survived++;
    }
    // A floor of 2/10 catches a weapon that cannot keep up at all without pinning one family.
    assert.ok(survived >= 2, weaponId + ' survived only ' + survived + '/' + seeds.length);
  }
});

test('the locked weapon is shown as a rank row in the loadout', () => {
  const game = createGame(); const state = game.getState();
  game.chooseWeapon('rad');
  const loadout = game.element('loadout');
  assert.equal(loadout.children[0].className, 'loadout-item core');
  assert.equal(loadout.children[0].children[1].textContent, 'Rad');
  assert.equal(loadout.children[0].children[2].textContent, 'LOCKED · RANK 1 / 5');
  assert.equal(state.weaponId, 'rad');
});

test('uncharged overlapping enemies take no collision damage', () => {
  const game = createGame(); game.beginRun(); const state = game.getState(); state.spawnClock = 1e9;
  game.element('auto-fire').checked = false;
  state.enemies.length = 0;
  const a = visibleEnemy(game, 'tank', 240, 400), b = visibleEnemy(game, 'tank', 245, 400);
  a.speed = b.speed = 0; a.hp = a.maxHp = 100000; b.hp = b.maxHp = 100000;
  for (let i = 0; i < 60; i++) game.update(1 / 60);
  assert.equal(a.hp, a.maxHp);
  assert.equal(b.hp, b.maxHp);
});

test('draw renders every enemy, mine, and effect state without throwing', () => {
  const game = createGame(); game.chooseWeapon('gravity'); const state = game.getState(); state.spawnClock = 1e9;
  state.build = { gravity: 1, cryo: 1, mines: 1 };
  state.enemies.length = 0;
  const chilled = visibleEnemy(game, 'drone', 120, 300);
  const frozen = visibleEnemy(game, 'tank', 240, 320);
  const irradiated = visibleEnemy(game, 'runner', 340, 280);
  const charged = visibleEnemy(game, 'drone', 160, 420);
  const boss = visibleEnemy(game, 'boss', 240, 160);
  game.applyChill(chilled, 1);
  while (!frozen.frozen) game.applyChill(frozen, 1);
  game.applyRad(irradiated, 12);
  game.applyGravity(charged, 4);
  // Every effect kind the draw path knows about, plus both bullet types and both mine states.
  state.effects.push({ x: 240, y: 545, radius: 80, life: .3, cryo: true });
  state.effects.push({ x: 240, y: 545, radius: 80, life: .3, mine: true });
  state.effects.push({ x: 240, y: 545, angle: -Math.PI / 2, length: 620, life: .1, beam: true });
  state.effects.push({ x: 200, y: 200, radius: 70, life: .3 });
  state.effects.push({ x: 240, y: 200, life: .5, xp: 12 });
  state.mines.push({ x: 200, y: 500, radius: 50, damage: 30, arm: 0, sub: false });
  state.mines.push({ x: 280, y: 500, radius: 50, damage: 30, arm: .3, sub: true });
  state.bullets.push({ x: 240, y: 400, vx: 0, vy: -560, damage: 40, splash: 0, slow: false,
    pierce: 0, hitEnemies: new Set(), color: '#9cfff1', radius: 3, life: 1, enemy: false });
  state.bullets.push({ x: 200, y: 300, vx: 0, vy: 145, enemy: true, radius: 6, color: '#ff687e', life: 1, damage: 5 });
  state.particles.push({ x: 200, y: 400, vx: 1, vy: 1, life: .3, color: '#fff' });
  assert.doesNotThrow(() => game.draw());
  assert.equal(frozen.frozen, true);
  assert.ok(boss.hp > 0);
});
