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
      applyChill, applyPoison, applyGravity, applyBulletHit, damageOverTime, chillSpeedFactor, weapons, WEAPON_IDS,
      WEAPON_CLASS_IDS, weaponClasses, chooseClass, fireVolley, poisonDps, poisonRisk, poisonAimTarget, blasterTarget, draw,
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
  assert.equal(Object.values(state.build).reduce((sum, count) => sum + count, 0), 2);
});

test('capped upgrades and full-health repairs are excluded from choices', () => {
  const game = createGame(); game.beginRun();
  const state = game.getState(); state.build.damage = game.upgrades.damage.max;
  const remainingRanks = Object.entries(game.upgrades).reduce((sum, [id, upgrade]) => id === 'repair' ? sum : sum + upgrade.max - (state.build[id] || 0), 0);
  for (let i = 0; i < remainingRanks; i++) {
    game.gainXP(game.nextLevelXP(state.level)); game.requestUpgrade();
    assert.ok(!state.choices.includes('damage')); assert.ok(!state.choices.includes('repair'));
    for (const id of state.choices) assert.ok((state.build[id] || 0) < game.upgrades[id].max);
    game.chooseUpgrade(state.choices[0]);
  }
  game.gainXP(game.nextLevelXP(state.level)); game.requestUpgrade();
  assert.equal(state.choices.length, 1); assert.equal(state.choices[0], 'repair');
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

test('pause freezes combat; armor blocks damage and repair caps at full health', () => {
  const game = createGame(); game.beginRun(); game.togglePause();
  const before = JSON.stringify(game.getState()); game.update(1);
  assert.equal(JSON.stringify(game.getState()), before); game.togglePause();
  const state = game.getState(); state.build.armor = 2; game.damageBase(10);
  assert.equal(state.health, 92);
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
  state.build.armor = 5;
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

test('all nine shot patterns emit bursts of simultaneous parallel bullets', () => {
  for (let bursts = 1; bursts <= 3; bursts++) for (let parallel = 1; parallel <= 3; parallel++) {
    const game = createGame(); game.beginRun(); const state = game.getState();
    state.build = { multishot: parallel - 1, burst: bursts - 1 };
    const enemy = visibleEnemy(game, 'tank', 240, 100); enemy.hp = enemy.maxHp = 100000; enemy.speed = 0;
    game.firePilot(enemy);
    assert.equal(state.bullets.length, parallel);
    assert.equal(state.pilot.pendingBursts.length, bursts - 1);
    const volley = state.bullets;
    assert.equal(new Set(volley.map(bullet => bullet.vx)).size, 1);
    assert.equal(new Set(volley.map(bullet => bullet.vy)).size, 1);
    for (let index = 1; index < volley.length; index++) {
      const dx = volley[index].x - volley[index - 1].x, dy = volley[index].y - volley[index - 1].y;
      assert.ok(Math.abs(Math.hypot(dx, dy) - 8) < 1e-9);
      assert.ok(Math.abs(dx * volley[index].vx + dy * volley[index].vy) < 1e-9);
    }
    let emitted = parallel; state.bullets = [];
    for (let tick = 0; tick < 48; tick++) {
      game.update(1 / 60);
      if (state.bullets.length) assert.equal(state.bullets.length, parallel);
      emitted += state.bullets.length; state.bullets = [];
    }
    assert.equal(emitted, bursts * parallel, bursts + '×' + parallel);
    assert.equal(state.pilot.pendingBursts.length, 0);
  }
});

test('3×3 fires three bursts of three parallel bullets every second', () => {
  const game = createGame(); game.beginRun(); const state = game.getState();
  state.build = { multishot: 2, burst: 2 };
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

test('burst and parallel bullet counts stay capped at three', () => {
  const game = createGame(); game.beginRun(); const state = game.getState();
  state.build = { multishot: 10, burst: 10 };
  const enemy = visibleEnemy(game, 'tank', 240, 100);
  game.firePilot(enemy); assert.equal(state.bullets.length, 3);
  assert.equal(state.pilot.pendingBursts.length, 2);
  assert.equal(game.shotPattern().bursts, 3); assert.equal(game.shotPattern().parallel, 3);
  assert.equal(game.upgrades.burst.max, 2); assert.equal(game.upgrades.multishot.max, 2);
  assert.equal('spread' in game.upgrades, false);
});

test('scheduled bursts freeze during pause and upgrade selection and retarget after a kill', () => {
  const game = createGame(); game.beginRun(); const state = game.getState();
  state.build = { burst: 2, multishot: 2 };
  const near = visibleEnemy(game, 'tank', 340, 430), far = visibleEnemy(game, 'tank', 100, 120);
  game.firePilot(near); assert.ok(state.bullets[0].vx > 0);
  const pending = JSON.stringify(state.pilot.pendingBursts), cooldown = state.pilot.cooldown;
  game.togglePause(); game.update(1);
  assert.equal(JSON.stringify(state.pilot.pendingBursts), pending); assert.equal(state.pilot.cooldown, cooldown);
  game.togglePause(); game.gainXP(18); game.requestUpgrade(); game.update(1);
  assert.equal(JSON.stringify(state.pilot.pendingBursts), pending); assert.equal(state.pilot.cooldown, cooldown);
  game.chooseUpgrade(state.choices[0]); game.hit(near, 1000, false); state.bullets = [];
  for (let tick = 0; tick < 18; tick++) game.update(1 / 60);
  assert.equal(state.bullets.length, 3); assert.ok(state.bullets.every(bullet => bullet.vx < 0));
  assert.equal(game.aimTarget(), far);
});

test('defeat and restart cancel scheduled bursts', () => {
  for (const action of ['defeat', 'restart']) {
    const game = createGame(); game.beginRun(); const state = game.getState();
    state.build = { burst: 2, multishot: 2 };
    const enemy = visibleEnemy(game, 'tank', 240, 100); game.firePilot(enemy);
    assert.equal(state.pilot.pendingBursts.length, 2);
    if (action === 'defeat') game.damageBase(100);
    else game.reset();
    assert.equal(game.getState().pilot.pendingBursts.length, 0);
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
    // A sensible player prioritises scaling damage and survivability before spending
    // level-ups on extra weapon ranks. Weapon ranks sit last so the bot does not chase
    // them when a passive is on offer.
    const priority = ['damage', 'blast', 'multishot', 'burst', 'pierce', 'armor', 'aura', 'frost', 'speed',
      'nova', 'orbit', 'cryo', 'repair'];
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
  const originals = { drone: [35, 30, 8], runner: [23, 53.8, 6], tank: [130, 21, 16], boss: [2400, 14, 100] };
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

test('nova and orbit are independent weapons with their own cooldowns', () => {
  const game = createGame(); game.beginRun(); const state = game.getState(); state.spawnClock = 1e9;
  state.build = { nova: 1 };
  game.gainXP(18); game.requestUpgrade(); state.choices = ['nova']; game.chooseUpgrade('nova');
  assert.ok(state.weapons.some(weapon => weapon.id === 'nova'));
  assert.equal(state.weapons.filter(weapon => weapon.id === 'orbit').length, 0);
  state.build.orbit = 1; game.gainXP(30); game.requestUpgrade(); state.choices = ['orbit']; game.chooseUpgrade('orbit');
  const ids = state.weapons.map(weapon => weapon.id).sort();
  assert.equal(ids.join(','), 'blaster,nova,orbit');
  // Newly acquired weapons start ready, then run on their own intervals.
  const nova = state.weapons.find(weapon => weapon.id === 'nova');
  const orbit = state.weapons.find(weapon => weapon.id === 'orbit');
  assert.equal(nova.cooldown, 0); assert.equal(orbit.cooldown, 0);
  state.pilot.cooldown = 1e9;
  state.enemies.length = 0;
  game.update(1 / 60);
  // Cooldown decrements before the fire gate, so a weapon that fires this frame is
  // reset to its full interval, exactly as the blaster behaves.
  assert.equal(nova.cooldown, 1.6);
  assert.equal(orbit.cooldown, .25);
  game.update(1 / 60);
  assert.ok(Math.abs(nova.cooldown - (1.6 - 1 / 60)) < 1e-9, 'nova ' + nova.cooldown);
  assert.ok(Math.abs(orbit.cooldown - (.25 - 1 / 60)) < 1e-9, 'orbit ' + orbit.cooldown);
});

test('nova damages nearby enemies without bullets and still awards XP', () => {
  const game = createGame(); game.beginRun(); const state = game.getState(); state.spawnClock = 1e9;
  state.build = { nova: 3 };
  game.gainXP(18); game.requestUpgrade(); state.choices = ['nova']; game.chooseUpgrade('nova');
  const near = visibleEnemy(game, 'drone', 240, 500), far = visibleEnemy(game, 'drone', 240, 120);
  near.hp = near.maxHp = 100000; far.hp = far.maxHp = 100000;
  state.enemies.forEach(enemy => { enemy.speed = 0; enemy.attackClock = 1e9; });
  state.pilot.cooldown = 1e9; // isolate Nova: the blaster cannot fire this frame
  const beforeNear = near.hp, beforeFar = far.hp, bulletsBefore = state.bullets.length;
  game.update(1 / 60);
  assert.equal(state.bullets.length, bulletsBefore);
  assert.ok(near.hp < beforeNear); assert.equal(far.hp, beforeFar);
  assert.ok(state.effects.some(effect => !effect.xp && effect.radius > 0));
});

test('orbital drone damages on contact and orbits without aiming', () => {
  const game = createGame(); game.beginRun(); const state = game.getState(); state.spawnClock = 1e9;
  state.build = { orbit: 2 };
  game.gainXP(18); game.requestUpgrade(); state.choices = ['orbit']; game.chooseUpgrade('orbit');
  const orbit = state.weapons.find(weapon => weapon.id === 'orbit');
  const startPhase = orbit.phase;
  game.element('auto-fire').checked = true;
  state.pilot.cooldown = 1e9; // isolate the drone: the blaster cannot fire
  const enemy = visibleEnemy(game, 'tank', 240, 480); enemy.hp = enemy.maxHp = 100000; enemy.speed = 0; enemy.attackClock = 1e9;
  game.update(1 / 60);
  assert.notEqual(orbit.phase, startPhase);
  assert.equal(state.bullets.length, 0);
  let damaged = false;
  for (let tick = 0; tick < 120 && !damaged; tick++) { game.update(1 / 60); if (enemy.hp < enemy.maxHp) damaged = true; }
  assert.ok(damaged, 'drone should contact the enemy as it orbits');
});

test('extra weapons stop firing when auto-fire is off and Space is released', () => {
  const game = createGame(); game.beginRun(); const state = game.getState(); state.spawnClock = 1e9;
  state.build = { nova: 3 };
  game.gainXP(18); game.requestUpgrade(); state.choices = ['nova']; game.chooseUpgrade('nova');
  const nova = state.weapons.find(weapon => weapon.id === 'nova');
  game.element('auto-fire').checked = false;
  state.enemies.length = 0;
  state.enemies.push({ type: 'drone', hp: 1e6, maxHp: 1e6, x: 240, y: 480, originX: 240, speed: 0,
    radius: 13, xp: 5, damage: 10, color: '#ef829b', time: 0, slow: 0, flash: 0, attackClock: 1e9 });
  game.update(1 / 60);
  assert.equal(nova.cooldown, 0);
  game.keys.add('Space'); game.update(1 / 60);
  assert.ok(nova.cooldown > 0);
});

test('cryo chills to a standstill and only the shatter kills', () => {
  const game = createGame(); game.beginRun(); const state = game.getState(); state.spawnClock = 1e9;
  const enemy = visibleEnemy(game, 'drone', 240, 300);
  enemy.speed = 20; enemy.hp = enemy.maxHp = 1000;
  assert.equal(game.chillSpeedFactor(enemy), 1);
  game.applyChill(enemy, .5);
  assert.ok(game.chillSpeedFactor(enemy) < 1, 'chill should slow');
  assert.equal(enemy.frozen, false);
  game.applyChill(enemy, .5);
  assert.equal(enemy.frozen, true);
  assert.equal(game.chillSpeedFactor(enemy), 0);
  // Frozen: forward progress stops and the position is a statue.
  const frozenY = enemy.y;
  game.update(1 / 60); game.update(1 / 60); game.update(1 / 60);
  assert.equal(enemy.y, frozenY, 'frozen enemy must not advance');
  // Cryo contact alone deals no damage.
  const hpBefore = enemy.hp;
  game.weapons.cryo.fire({ cooldown: 0 });
  assert.equal(enemy.hp, hpBefore, 'cryo must not deal direct damage');
  // The next hit shatters for a large bonus and clears the freeze.
  game.hit(enemy, 1, false);
  assert.ok(enemy.hp < hpBefore - 40, 'shatter should add a large bonus');
  assert.equal(enemy.frozen, false);
});

test('frozen enemies break on their own instead of clogging the field', () => {
  const game = createGame(); game.beginRun(); const state = game.getState(); state.spawnClock = 1e9;
  game.element('auto-fire').checked = false;
  state.enemies.length = 0;
  // A row of fragile enemies that freeze immediately. Without self-break they would sit
  // as unkillable statues and stall the run, which is the bug this guards.
  const enemies = [];
  for (let i = 0; i < 5; i++) {
    const enemy = visibleEnemy(game, 'drone', 120 + i * 40, 400);
    enemy.speed = 0; enemy.hp = enemy.maxHp = 200;
    game.applyChill(enemy, 1);
    enemies.push(enemy);
  }
  assert.ok(enemies.every(enemy => enemy.frozen));
  for (let i = 0; i < 150; i++) game.update(1 / 60);
  // Every statue must have broken on its own rather than sitting frozen forever. They
  // take shatter damage rather than dying, because 200 HP survives a ~40 point bonus.
  const stillFrozen = enemies.filter(enemy => enemy.hp > 0 && enemy.frozen).length;
  assert.equal(stillFrozen, 0, 'no enemy should stay frozen indefinitely');
  const damaged = enemies.filter(enemy => enemy.hp < enemy.maxHp).length;
  assert.equal(damaged, 5, 'every frozen enemy should have taken shatter damage');
});

test('a frozen enemy breaks immediately when hit', () => {
  const game = createGame(); game.beginRun(); const state = game.getState(); state.spawnClock = 1e9;
  const enemy = visibleEnemy(game, 'drone', 240, 300);
  enemy.speed = 0; enemy.hp = enemy.maxHp = 1000;
  game.applyChill(enemy, 1);
  assert.equal(enemy.frozen, true);
  const before = enemy.hp;
  game.hit(enemy, 5, false);
  assert.equal(enemy.frozen, false, 'a hit should break the freeze');
  assert.ok(before - enemy.hp > 40, 'shatter adds a bonus on top of the hit');
});

test('bosses resist cryo and never freeze', () => {
  const game = createGame(); game.beginRun(); const state = game.getState(); state.spawnClock = 1e9;
  const boss = visibleEnemy(game, 'boss', 240, 200);
  for (let i = 0; i < 10; i++) game.applyChill(boss, .5);
  assert.equal(boss.frozen, false, 'boss must never freeze');
  assert.ok(boss.chill <= .6 + 1e-9, 'boss chill caps at 0.6');
});

test('poison deals damage only over time, stacks without expiring, and ramps', () => {
  const game = createGame(); game.chooseClass('poison'); const state = game.getState(); state.spawnClock = 1e9;
  game.element('auto-fire').checked = false;
  const enemy = visibleEnemy(game, 'tank', 240, 300);
  enemy.speed = 0; enemy.hp = enemy.maxHp = 100000;
  const before = enemy.hp;
  game.applyPoison(enemy, 1);
  assert.equal(enemy.hp, before, 'applying poison must not deal direct damage');
  assert.equal(enemy.poison, 1, 'one bullet is one stack');
  // Ticks accumulate, so health falls over time.
  for (let i = 0; i < 60; i++) game.update(1 / 60);
  const oneStackDrop = before - enemy.hp;
  assert.ok(oneStackDrop > 0, 'poison should deal damage over time');
  // Stacks never expire: the investment keeps paying across the whole run.
  for (let i = 0; i < 300; i++) game.update(1 / 60);
  assert.equal(enemy.poison, 1, 'poison stacks must not expire');
  // More stacks means strictly more DPS, which is the ramp the class is built around.
  const hpBefore = enemy.hp;
  for (let i = 0; i < 60; i++) game.update(1 / 60);
  const oneStackSecond = hpBefore - enemy.hp;
  game.applyPoison(enemy, 9);
  assert.equal(enemy.poison, 10);
  const hpTen = enemy.hp;
  for (let i = 0; i < 60; i++) game.update(1 / 60);
  const tenStackSecond = hpTen - enemy.hp;
  assert.ok(tenStackSecond > oneStackSecond * 5, 'ten stacks should dwarf one stack');
  assert.ok(game.poisonDps(enemy) > poisonDpsAtOne(game, enemy));
  // Stacks cap so a single enemy is never an unbounded damage sink.
  for (let i = 0; i < 100; i++) game.applyPoison(enemy, 5);
  assert.equal(enemy.poison, 40, 'poison stacks cap at 40');
});
function poisonDpsAtOne(game, enemy) {
  const saved = enemy.poison;
  enemy.poison = 1;
  const dps = game.poisonDps(enemy);
  enemy.poison = saved;
  return dps;
}

test('poison damage over time awards XP and score exactly once', () => {
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

test('gravity class: charged enemies magnetise toward each other and crush on contact', () => {
  const game = createGame(); game.chooseClass('gravity'); const state = game.getState(); state.spawnClock = 1e9;
  game.element('auto-fire').checked = false;
  assert.equal(state.classId, 'gravity');
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

test('poison class: each bullet adds one stack and never deals direct damage', () => {
  const game = createGame(); game.chooseClass('poison'); const state = game.getState(); state.spawnClock = 1e9;
  game.element('auto-fire').checked = false;
  state.enemies.length = 0;
  const enemy = visibleEnemy(game, 'tank', 240, 200); enemy.speed = 0; enemy.hp = enemy.maxHp = 100000;
  const bullet = { classId: 'poison', damage: 40, stacks: 1, slow: false, splash: 0 };
  const before = enemy.hp;
  game.applyBulletHit(enemy, bullet);
  assert.equal(enemy.hp, before, 'poison rounds must not deal direct damage');
  assert.equal(enemy.poison, 1, 'one bullet adds exactly one stack');
  game.applyBulletHit(enemy, bullet);
  assert.equal(enemy.poison, 2, 'each further bullet adds one more stack');
  for (let i = 0; i < 60; i++) game.update(1 / 60);
  assert.ok(enemy.hp < before, 'poison should burn the enemy over time');
});

test('poison auto-aim targets the enemy about to leak, not the nearest one', () => {
  const game = createGame(); game.chooseClass('poison'); const state = game.getState(); state.spawnClock = 1e9;
  game.element('auto-fire').checked = false;
  state.enemies.length = 0;
  // The near enemy is close to the defender, the far one is almost at the outpost. Physical
  // aim would pick the near one; poison must pick the leaker.
  const near = visibleEnemy(game, 'drone', 240, 500), leaker = visibleEnemy(game, 'drone', 120, 610);
  near.speed = leaker.speed = 0; near.hp = near.maxHp = 1000; leaker.hp = leaker.maxHp = 1000;
  assert.equal(game.aimTarget(), near, 'baseline aim picks the nearest enemy');
  assert.equal(game.poisonAimTarget(), leaker, 'poison aim picks the enemy closest to leaking');
  // Saturate both: the aim no longer dumps bullets into the deepest stack. Risk collapses
  // below arrival time, which is the "just enough" behaviour — no enemy stays attractive.
  game.applyPoison(leaker, 40); game.applyPoison(near, 40);
  assert.ok(game.poisonRisk(leaker).risk < game.poisonRisk(visibleEnemy(game, 'tank', 240, 200)).risk,
    'a saturated enemy is less attractive than a fresh one');
});

test('poison aim spreads stacks across the field instead of dumping them on one enemy', () => {
  const game = createGame(); game.chooseClass('poison'); const state = game.getState(); state.spawnClock = 1e9;
  game.element('auto-fire').checked = false;
  state.enemies.length = 0;
  // Two identical enemies at the same depth: one already saturated, one clean. The clean one
  // is the one still at risk, so the aim must seed it rather than over-stacking the first.
  const saturated = visibleEnemy(game, 'drone', 200, 560), clean = visibleEnemy(game, 'drone', 280, 560);
  saturated.speed = clean.speed = 0; saturated.hp = saturated.maxHp = 1000; clean.hp = clean.maxHp = 1000;
  game.applyPoison(saturated, 40);
  assert.equal(game.poisonAimTarget(), clean);
  const risk = game.poisonRisk(clean);
  assert.ok(risk.risk > 0, 'a fresh enemy at risk has positive risk (it would leak)');
});

test('poison stacks ramp damage so a boss with many stacks melts', () => {
  const game = createGame(); game.chooseClass('poison'); const state = game.getState(); state.spawnClock = 1e9;
  game.element('auto-fire').checked = false;
  state.enemies.length = 0;
  const boss = visibleEnemy(game, 'boss', 240, 200); boss.speed = 0; boss.hp = boss.maxHp = 100000;
  const before = boss.hp;
  for (let i = 0; i < 30; i++) game.applyPoison(boss, 1);
  assert.equal(boss.poison, 30);
  for (let i = 0; i < 180; i++) game.update(1 / 60);
  assert.ok(boss.hp < before, 'a heavily poisoned boss must take real damage');
});

test('physical class deals immediate damage and leaves no status', () => {
  const game = createGame(); game.chooseClass('physical'); const state = game.getState(); state.spawnClock = 1e9;
  state.enemies.length = 0;
  const enemy = visibleEnemy(game, 'tank', 240, 200); enemy.speed = 0; enemy.hp = enemy.maxHp = 100000;
  const before = enemy.hp;
  game.applyBulletHit(enemy, { classId: 'physical', damage: 40, slow: false, splash: 0 });
  assert.equal(enemy.hp, before - 40, 'physical rounds deal damage on impact');
  assert.equal(enemy.poison, 0); assert.equal(enemy.charge, 0);
});

test('the chosen weapon class is locked for the run and reset clears it', () => {
  const game = createGame();
  assert.equal(game.getState().classId, null, 'a fresh run has no class until one is picked');
  assert.equal(game.getState().phase, 'ready');
  game.chooseClass('poison');
  assert.equal(game.getState().classId, 'poison');
  assert.equal(game.getState().phase, 'combat');
  // Choosing again mid-run must not switch the class.
  game.chooseClass('gravity');
  assert.equal(game.getState().classId, 'poison', 'the class is locked once combat starts');
  game.reset();
  assert.equal(game.getState().classId, null);
  assert.equal(game.getState().phase, 'ready');
});

test('beginRun without a prior choice defaults to the physical class', () => {
  const game = createGame(); game.beginRun();
  const state = game.getState();
  assert.equal(state.classId, 'physical');
  const enemy = visibleEnemy(game, 'tank', 240, 200); enemy.speed = 0; enemy.hp = enemy.maxHp = 100000;
  const before = enemy.hp;
  game.applyBulletHit(enemy, { classId: 'physical', damage: 25, slow: false, splash: 0 });
  assert.equal(enemy.hp, before - 25);
});

test('poison and gravity are not offered as upgrade weapons anymore', () => {
  const game = createGame();
  assert.equal('rad' in game.upgrades, false);
  assert.equal('poison' in game.upgrades, false);
  assert.equal('gravity' in game.upgrades, false);
  assert.equal(game.WEAPON_IDS.includes('poison'), false);
  assert.equal(game.WEAPON_IDS.includes('gravity'), false);
  assert.deepEqual([...game.WEAPON_CLASS_IDS], ['physical', 'poison', 'gravity']);
});

test('every weapon class can clear the 300 s window at a comparable rate', () => {
  // Balance guard, not a benchmark. Each class is played by the same greedy bot over the
  // same seeded families, so a class that falls out of band (e.g. a nerf that makes DoT
  // unable to keep up with the swarm) fails here instead of shipping.
  const priority = ['damage', 'blast', 'multishot', 'burst', 'pierce', 'armor', 'aura', 'frost', 'speed',
    'nova', 'orbit', 'cryo', 'repair'];
  const seeds = [19, 37, 3, 7, 11, 23, 41, 53, 67, 79];
  for (const classId of ['physical', 'poison', 'gravity']) {
    let survived = 0;
    for (const seed of seeds) {
      const game = createGame(seed); game.chooseClass(classId);
      const state = game.getState();
      for (let tick = 0; tick < 60 * 300 && state.phase !== 'lost'; tick++) {
        if (state.phase === 'upgrade') {
          const choice = state.health < 55 && state.choices.includes('repair') ? 'repair' : priority.find(id => state.choices.includes(id));
          assert.ok(choice, classId + ' seed ' + seed + ' offered no pickable choice: ' + state.choices);
          game.chooseUpgrade(choice);
        } else { game.move(240, 550); game.update(1 / 60); }
      }
      assert.ok(state.kills > 0 && state.level > 1, classId + ' seed ' + seed + ' made no progress');
      if (state.phase === 'combat') survived++;
    }
    // Measured: physical is the strongest baseline; poison and gravity sit in the same band.
    // A floor of 3 catches a class that cannot keep up at all without pinning one seed family.
    assert.ok(survived >= 3, classId + ' survived only ' + survived + '/' + seeds.length);
  }
});

test('unlocked core weapon is shown as a locked row in the loadout', () => {
  const game = createGame(); const state = game.getState();
  game.chooseClass('poison');
  const loadout = game.element('loadout');
  assert.equal(loadout.children[0].className, 'loadout-item core');
  assert.equal(loadout.children[0].children[2].textContent, 'LOCKED · ' + game.weaponClasses.poison.tag);
  assert.equal(state.classId, 'poison');
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

test('draw renders every enemy and effect state without throwing', () => {
  const game = createGame(); game.chooseClass('gravity'); const state = game.getState(); state.spawnClock = 1e9;
  state.build = { cryo: 1, nova: 1, orbit: 1 };
  for (const id of ['cryo', 'nova', 'orbit']) {
    if (!state.weapons.some(weapon => weapon.id === id)) state.weapons.push({ id, cooldown: 0, pendingBursts: [], phase: 0 });
  }
  state.enemies.length = 0;
  const chilled = visibleEnemy(game, 'drone', 120, 300);
  const frozen = visibleEnemy(game, 'tank', 240, 320);
  const poisoned = visibleEnemy(game, 'runner', 340, 280);
  const charged = visibleEnemy(game, 'drone', 160, 420);
  const boss = visibleEnemy(game, 'boss', 240, 160);
  game.applyChill(chilled, .5);
  game.applyChill(frozen, 1);
  game.applyPoison(poisoned, 12);
  game.applyGravity(charged, 4);
  // Every effect kind the draw path knows about, plus both bullet types.
  state.effects.push({ x: 240, y: 545, radius: 80, life: .3, cryo: true });
  state.effects.push({ x: 240, y: 545, radius: 80, life: .3, nova: true });
  state.effects.push({ x: 200, y: 200, radius: 70, life: .3 });
  state.effects.push({ x: 240, y: 200, life: .5, xp: 12 });
  state.bullets.push({ x: 240, y: 400, vx: 0, vy: -560, damage: 40, splash: 0, slow: false,
    pierce: 0, hitEnemies: new Set(), color: '#9cfff1', radius: 3, life: 1, enemy: false });
  state.bullets.push({ x: 200, y: 300, vx: 0, vy: 145, enemy: true, radius: 6, color: '#ff687e', life: 1, damage: 5 });
  state.particles.push({ x: 200, y: 400, vx: 1, vy: 1, life: .3, color: '#fff' });
  assert.doesNotThrow(() => game.draw());
  assert.equal(frozen.frozen, true);
  assert.ok(boss.hp > 0);
});
