// Run with: node --test game/game.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function createGame(initialSeed = 19) {
  const elements = new Map();
  function makeElement() {
    return { checked: false, hidden: false, disabled: false, style: {}, dataset: {}, listeners: {}, children: [],
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(name, handler) { this.listeners[name] = handler; },
      append(...nodes) { this.children.push(...nodes); }, replaceChildren(...nodes) { this.children = nodes; },
      setAttribute() {}, focus() {}, getContext() { return {}; } };
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
      getState: () => state, move: (x, y) => { pointer = { x, y }; }, keys, isPaused: () => paused };
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
  const schedule = [0, .30, .60];
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
  for (const seed of [19, 37]) {
    const game = createGame(seed); game.beginRun(); const state = game.getState();
    const priority = ['multishot', 'damage', 'blast', 'burst', 'pierce', 'frost', 'armor', 'aura', 'speed', 'repair'];
    for (let tick = 0; tick < 60 * 300 && state.phase !== 'lost'; tick++) {
      if (state.phase === 'upgrade') {
        const choice = state.health < 55 && state.choices.includes('repair') ? 'repair' : priority.find(id => state.choices.includes(id));
        game.chooseUpgrade(choice);
      } else { game.move(240, 550); game.update(1 / 60); }
    }
    assert.equal(state.phase, 'combat', JSON.stringify({ seed, health: state.health, level: state.level, build: state.build }));
    assert.ok(state.runTime > 240); assert.ok(state.threat > 8); assert.ok(state.kills > 0);
    assert.ok(state.level > 1); assert.equal('towers' in state, false); assert.equal('won' in state, false);
  }
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
  assert.equal(game.element('wave').innerHTML, '∞<span> THREAT 6</span>');
});
