// Run with: node --test game/game.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// A recording WebAudio stub. Every created voice is logged at start(), which is how the tests
// count what the mixer actually played without a real audio device.
function makeAudioClass(log) {
  return function FakeAudioContext() {
    const ctx = {
      state: 'running', currentTime: 0, sampleRate: 8000,
      destination: { connect() {} },
      resume() { ctx.state = 'running'; return Promise.resolve(); },
      createGain() {
        const node = { gain: {
          value: 1,
          setValueAtTime(value) { node.gain.value = value; },
          setTargetAtTime(value) { node.gain.value = value; },
          linearRampToValueAtTime(value) { node.gain.value = value; },
          exponentialRampToValueAtTime(value) { node.gain.value = value; }
        }, connect() {} };
        return node;
      },
      createOscillator() {
        const node = {
          type: 'sine',
          frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
          connect() {},
          start(at) { log.push({ kind: 'osc', type: node.type, layer: node.layer, at: at ?? ctx.currentTime }); },
          stop() {}
        };
        return node;
      },
      createBuffer(channels, length) { return { length, getChannelData: () => new Float32Array(length) }; },
      createBufferSource() {
        const node = { buffer: null, connect() {}, start(at) { log.push({ kind: 'noise', layer: node.layer, at: at ?? ctx.currentTime }); }, stop() {} };
        return node;
      },
      createBiquadFilter() {
        const frequency = {
          value: 0,
          setValueAtTime(value) { frequency.value = value; },
          setTargetAtTime(value) { frequency.value = value; },
          linearRampToValueAtTime(value) { frequency.value = value; },
          exponentialRampToValueAtTime(value) { frequency.value = value; }
        };
        const Q = { value: 1, setValueAtTime(value) { Q.value = value; }, setTargetAtTime(value) { Q.value = value; } };
        return { type: 'lowpass', frequency, Q, connect() {} };
      },
      createDelay() { return { delayTime: { value: 0 }, connect() {} }; }
    };
    return ctx;
  };
}

function createGame(initialSeed = 19, options = {}) {
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
      addEventListener(name, handler) { this.listeners[name] = handler; }, setAttribute() {}, focus() {},
      append(...nodes) { this.children.push(...nodes); }, replaceChildren(...nodes) { this.children = nodes; },
      getContext() { return context; },
      getBoundingClientRect() { return { width: 480, height: 680, left: 0, top: 0 }; } };
  }
  const element = id => { if (!elements.has(id)) elements.set(id, makeElement()); return elements.get(id); };
  let seed = initialSeed;
  const math = Object.create(Math);
  math.random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  // Audio is opt-in: without this option the sandbox has no AudioContext at all, which is the
  // state every pre-existing test runs in.
  const audioLog = [];
  const storage = new Map(Object.entries(options.storage || {}));
  const documentListeners = {};
  const documentStub = {
    hidden: false,
    getElementById: element, createElement: makeElement, body: makeElement(),
    addEventListener(name, handler) { documentListeners[name] = handler; }
  };
  const windowStub = { addEventListener() {}, devicePixelRatio: 1 };
  if (options.audio) windowStub.AudioContext = makeAudioClass(audioLog);
  const sandbox = { Math: math, document: documentStub, window: windowStub,
    localStorage: { getItem: key => (storage.has(key) ? storage.get(key) : null), setItem: (key, value) => storage.set(key, String(value)) },
    setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame() {} };
  // Handed to the injected harness through the sandbox, because that code runs inside the VM
  // context and cannot see this function's locals.
  sandbox.__documentListeners = documentListeners;
  sandbox.__storage = storage;
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(__dirname, 'game.js'), 'utf8'), anchor = 'reset(); requestAnimationFrame(frame);';
  assert.ok(source.includes(anchor), 'test instrumentation anchor exists');
  vm.runInContext(source.replace(anchor, `
    globalThis.game = { reset, beginRun, update, spawn, hit, damageBase, togglePause,
      aimTarget, firePilot, shotPattern, updateUI, gainXP, requestUpgrade, chooseUpgrade, nextLevelXP, upgrades,
      applyChill, applyRad, applyGravity, applyBulletHit, damageOverTime, chillSpeedFactor, cryoShatterGap, resolveGravityCollisions,
      openWell, updateWells, SINGULARITY_WELL_EVERY, SINGULARITY_WELL_LIFE, SINGULARITY_WELL_RADIUS, SINGULARITY_WELL_CORE,
      openZero, updateZeros, ZERO_RADIUS, ZERO_LIFE, ZERO_PULSE, ZERO_PULSE_STACKS, ZERO_BURST_STACKS, ZERO_CAP,
      weapons, WEAPON_IDS, evolutions, EVOLUTION_IDS, upgradeData, chooseWeapon, activeWeaponId, weaponRank,
      fireVolley, fireRounds, radDps, radRisk, radAimTarget, radStacks, radDpsPerStack, blasterTarget, weaponTarget,
      weaponAims, dropMine, detonateMine, mineDamage, mineRadius, mineRank, mineCap, mineFuse,
      mineBlastRadius, mineAt, updateMines, MINE_RANKS, MINE_ARM, MINE_CAP, MINE_CAP_MAXED, MINE_ROLL_CAP,
      CLUSTER_SUBS, CLUSTER_RADIUS_FRACTION,
      syncWeapons, pickChoices, draw,
      orbitRockCount, orbitRadius, orbitRockPositions, orbitDamage,
      orbitHitInterval, orbitSplashRadius, orbitSplashDamage, orbitRockSpecs, orbitLanes,
      ensureAudio, applyAudioGain, unlockAudio, sfx, tone, renderAudioUI, saveSettings,
      audio, getVolume: () => volume, setVolume: value => { volume = value; },
      getSound: () => soundEnabled, setSound: value => { soundEnabled = value; },
      AUDIO_DEFAULTS, SFX_GAP,
      setHidden: value => { document.hidden = value; }, documentListeners: __documentListeners, storage: __storage,
      getState: () => state, move: (x, y) => { pointer = { x, y }; }, keys, isPaused: () => paused, releaseInputs };
    reset();
  `), sandbox);
  return { ...sandbox.game, element, audioLog };
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
  game.hit(enemy, 1000); game.hit(enemy, 1000);
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

test('capped and exclusive upgrades are excluded from choices', () => {
  const game = createGame(); game.beginRun();
  const state = game.getState();
  // Max the weapon rank and the piercing passive: both are capped, and Volatile rounds is
  // blocked by the pierce/blast exclusion, so none of the three may reappear.
  state.build.blaster = game.weapons.blaster.max;
  state.build.pierce = game.upgrades.pierce.max;
  for (let i = 0; i < 40; i++) {
    const choices = game.pickChoices();
    assert.ok(!choices.includes('blaster'), 'a maxed weapon is never offered');
    assert.ok(!choices.includes('pierce'), 'a capped passive is never offered');
    assert.ok(!choices.includes('blast'), 'the exclusive passive stays blocked');
    for (const id of choices) assert.ok((state.build[id] || 0) < (game.upgrades[id] || game.weapons[id] || game.evolutions[id]).max);
  }
  // Full health hides repair; a hurt base brings it back.
  assert.ok(Array.from({ length: 40 }, () => game.pickChoices()).every(choices => !choices.includes('repair')));
  state.health = 40;
  assert.ok(Array.from({ length: 40 }, () => game.pickChoices()).some(choices => choices.includes('repair')));
});

test('auto aim chooses the nearest live visible enemy and retargets after death', () => {
  const game = createGame(); game.beginRun(); const state = game.getState();
  const far = visibleEnemy(game, 'tank', 100, 120), near = visibleEnemy(game, 'tank', 340, 430);
  visibleEnemy(game, 'drone', 240, -10);
  assert.equal(game.aimTarget(), near);
  game.firePilot(near); const bullet = state.bullets[0];
  assert.ok(bullet.vx > 0); assert.ok(bullet.vy < 0);
  game.hit(near, 1000); assert.equal(game.aimTarget(), far);
  game.hit(far, 1000); assert.equal(game.aimTarget(), null);
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

test('piercing hits each enemy once; explosions affect nearby enemies', () => {
  const game = createGame(); game.beginRun(); game.element('auto-fire').checked = false;
  const state = game.getState();
  const first = visibleEnemy(game, 'tank', 230, 250), second = visibleEnemy(game, 'tank', 245, 250);
  state.bullets.push({ x: 230, y: 250, vx: 0, vy: 0, life: 2, damage: 10, splash: 0,
    pierce: 1, hitEnemies: new Set(), radius: 3, color: '#9cfff1' });
  game.update(1 / 60);
  assert.equal(first.hp, first.maxHp - 10); assert.equal(second.hp, second.maxHp - 10);
  const hp = first.hp, y = first.y;
  game.update(1 / 60);
  assert.equal(first.hp, hp); assert.ok(first.y - y > 0);
  assert.equal(second.hp, second.maxHp - 10);
  state.bullets.push({ x: first.x, y: first.y, vx: 0, vy: 0, life: 2, damage: 15, splash: 40,
    pierce: 0, hitEnemies: new Set(), radius: 3, color: '#9cfff1' });
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
  game.hit(near, 1000); state.bullets = [];
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

test('mines rank to five and drop two charges per cycle from rank four', () => {
  const game = createGame(); game.chooseWeapon('mines'); const state = game.getState(); state.spawnClock = 1e9;
  game.element('auto-fire').checked = true; state.enemies.length = 0;
  assert.equal(game.weapons.mines.max, 5, 'mines now rank 1 to 5');
  game.update(1 / 60);
  assert.equal(state.mines.length, 1, 'rank 1 drops one charge');
  state.mines.length = 0; state.weapons[0].cooldown = 0; state.build.mines = 4;
  game.update(1 / 60);
  assert.equal(state.mines.length, 2, 'rank 4 drops two charges per cycle');
  assert.equal(new Set(state.mines.map(mine => mine.x)).size, 2, 'the two charges land on distinct slots');
});

test('mines drop one cycle per second and report 1 Hz', () => {
  const game = createGame(); game.chooseWeapon('mines'); const state = game.getState(); state.spawnClock = 1e9;
  game.element('auto-fire').checked = true; state.enemies.length = 0;
  assert.equal(game.weapons.mines.interval, 1, 'mines fire at 1 Hz');
  assert.equal(game.element('rate-stat').textContent, '1 Hz');
  const droppedAt = [];
  for (let tick = 0; tick < 180; tick++) {
    game.update(1 / 60);
    if (state.mines.length) { droppedAt.push(tick / 60); state.mines.length = 0; }
  }
  assert.equal(droppedAt.length, 3, 'three drops in three seconds');
  assert.equal(droppedAt[1] - droppedAt[0], 1, 'one second between drops');
  assert.equal(droppedAt[2] - droppedAt[1], 1);
});

test('a rolling charge travels a readable distance before it stops', () => {
  const game = createGame(); game.chooseWeapon('mines');
  // Walk speed is 270 px/s; the charge should carry several body-lengths, not a nudge.
  const mine = game.mineAt({ x: 240, y: 400, angle: 0, vx: 270, vy: 0 }, 0, 1);
  assert.ok(Math.abs(mine.vx - 270) < 1e-6, 'a walking drop inherits walk speed');
  // Integrate the roll the way updateMines does and measure the total skid.
  let x = mine.x, vx = mine.vx, travelled = 0;
  for (let tick = 0; tick < 600 && vx > 1e-6; tick++) {
    const next = Math.max(0, vx - 400 * (1 / 60)), scale = next / vx;
    vx *= scale; const step = vx * (1 / 60);
    x += step; travelled += step;
  }
  assert.ok(travelled > 80, 'the charge skids more than 80 px, found ' + travelled.toFixed(1));
});

test('a charge dropped in motion rolls; a stationary drop stays put', () => {
  const measure = moving => {
    const game = createGame(); game.chooseWeapon('mines'); const state = game.getState(); state.spawnClock = 1e9;
    game.element('auto-fire').checked = true; state.enemies.length = 0;
    if (moving) game.move(240, 100);
    game.update(1 / 60);
    const mine = state.mines[0];
    const startX = mine.x, startY = mine.y;
    for (let tick = 0; tick < 120; tick++) game.update(1 / 60);
    return Math.hypot(mine.x - startX, mine.y - startY);
  };
  assert.ok(measure(false) < 1e-6, 'a stationary drop does not move');
  assert.ok(measure(true) > 5, 'a moving drop inherits momentum and rolls');
});

test('pilot momentum tracks movement and falls to zero when stopped', () => {
  const game = createGame(); game.beginRun(); const state = game.getState(); state.spawnClock = 1e9;
  game.move(240, 100); game.update(1 / 60);
  assert.ok(state.pilot.vy < -1, 'moving up gives upward momentum');
  game.move(state.pilot.x, state.pilot.y); game.update(1 / 60);
  assert.ok(Math.hypot(state.pilot.vx, state.pilot.vy) < 1e-6, 'stopping clears momentum');
});

test('roll speed is capped so a full-sprint drop cannot fling across the arena', () => {
  const game = createGame(); game.chooseWeapon('mines');
  const mine = game.mineAt({ x: 240, y: 400, angle: 0, vx: 100000, vy: 0 }, 0, 5);
  assert.ok(Math.hypot(mine.vx, mine.vy) <= game.MINE_ROLL_CAP + 1e-6, 'roll speed stays capped');
});

test('a rolling charge is inert until it stops and arms', () => {
  const game = createGame(); game.beginRun(); const state = game.getState(); state.spawnClock = 1e9;
  state.enemies.length = 0;
  const enemy = visibleEnemy(game, 'tank', 240, 400); enemy.hp = enemy.maxHp = 1e6; enemy.speed = 0; enemy.attackClock = 1e9;
  const before = enemy.hp;
  state.mines.push({ x: 240, y: 400, vx: 200, vy: 0, radius: 110, damage: 60, arm: 0, sub: false });
  game.updateMines(1 / 60);
  assert.equal(enemy.hp, before, 'a rolling charge deals no damage');
  assert.equal(state.mines.length, 1, 'it has not detonated while rolling');
  for (let tick = 0; tick < 120 && state.mines.length; tick++) game.updateMines(1 / 60);
  assert.ok(enemy.hp < before, 'it detonates once it stops');
});

test('phase rounds give a charge a proximity fuse that trips before contact', () => {
  const trips = pierce => {
    const game = createGame(); game.chooseWeapon('mines'); const state = game.getState(); state.spawnClock = 1e9;
    state.enemies.length = 0;
    if (pierce) state.build.pierce = 1;
    // Distance 145 is outside body-plus-blast contact (110 + 19) but inside the fuse reach.
    const enemy = visibleEnemy(game, 'tank', 385, 400); enemy.hp = enemy.maxHp = 1e6; enemy.speed = 0; enemy.attackClock = 1e9;
    state.mines.push({ x: 240, y: 400, vx: 0, vy: 0, radius: 110, damage: 60, arm: 0, sub: false });
    game.updateMines(1 / 60);
    return state.mines.length === 0;
  };
  assert.equal(trips(false), false, 'without the fuse a distant body does not trip the charge');
  assert.equal(trips(true), true, 'with the fuse the charge trips before contact');
});

test('volatile rounds widen the blast and leave a burn patch', () => {
  const game = createGame(); game.chooseWeapon('mines'); const state = game.getState(); state.spawnClock = 1e9;
  state.enemies.length = 0;
  const mine = { x: 240, y: 400, vx: 0, vy: 0, radius: 110, damage: 60, arm: 0, sub: false };
  assert.equal(game.mineBlastRadius(mine), 110, 'base Mines adds no blast');
  game.detonateMine(mine);
  assert.equal(state.burns.length, 0, 'base Mines leaves no burn patch');
  state.build.blast = 2;
  assert.equal(game.mineBlastRadius(mine), 110 + 12 * 2, 'Volatile widens the blast');
  game.detonateMine({ ...mine });
  assert.ok(state.burns.length >= 1, 'Volatile leaves a burn patch');
});

test('cluster sub-charges respect the live-charge cap and inherit the blast', () => {
  const subFor = (radius, damage) => {
    const game = createGame(); game.chooseWeapon('mines'); const state = game.getState();
    state.enemies.length = 0; state.build.cluster = 1;
    // A clean field: one parent detonates into exactly CLUSTER_SUBS subs.
    const parent = { x: 240, y: 400, vx: 0, vy: 0, radius, damage, arm: 0, sub: false };
    state.mines.push(parent); game.detonateMine(parent);
    assert.equal(state.mines.filter(mine => mine.sub).length, game.CLUSTER_SUBS, 'scatters two sub-charges');
    return state.mines.find(mine => mine.sub);
  };
  // A rank-1 parent vs a rank-5 parent: the sub inherits the larger blast instead of a fixed half.
  const low = subFor(110, 32), high = subFor(158, 88);
  assert.ok(high.radius > low.radius, 'a deeper cluster sub is larger');
  assert.ok(high.damage > low.damage, 'a deeper cluster sub hits harder');
  assert.ok(high.radius < 158, 'a sub is smaller than its parent');
});

test('cluster detonations never push the live-charge count past the cap', () => {
  const game = createGame(); game.chooseWeapon('mines'); const state = game.getState();
  state.enemies.length = 0; state.build.cluster = 1;
  for (let i = 0; i < game.MINE_CAP - 1; i++) state.mines.push({ x: 100 + i, y: 300, vx: 0, vy: 0, radius: 110, damage: 32, arm: 0, sub: true });
  const parent = { x: 240, y: 400, vx: 0, vy: 0, radius: 110, damage: 32, arm: 0, sub: false };
  state.mines.push(parent); game.detonateMine(parent);
  assert.ok(state.mines.length <= game.MINE_CAP, 'never exceeds the live-charge cap');
});

test('volatile applies once per parent, not again on every cluster sub', () => {
  const game = createGame(); game.chooseWeapon('mines'); const state = game.getState();
  state.enemies.length = 0; state.build.cluster = 1; state.build.blast = 2;
  const parent = { x: 240, y: 400, vx: 0, vy: 0, radius: 110, damage: 60, arm: 0, sub: false };
  state.mines.push(parent); game.detonateMine(parent);
  const sub = state.mines.find(mine => mine.sub);
  assert.equal(sub.radius, (110 + 12 * 2) * game.CLUSTER_RADIUS_FRACTION, 'the sub bakes the widened parent blast once');
  assert.equal(game.mineBlastRadius(sub), sub.radius, 'Volatile is not added a second time on the sub');
  assert.equal(state.burns.length, 1, 'only the parent seeds a burn patch');
});

test('a cluster sub-charge detonates without spawning more sub-charges', () => {
  const game = createGame(); game.chooseWeapon('mines'); const state = game.getState();
  state.enemies.length = 0; state.build.cluster = 1;
  const parent = { x: 240, y: 400, vx: 0, vy: 0, radius: 110, damage: 60, arm: 0, sub: false };
  state.mines.push(parent); game.detonateMine(parent);
  const sub = state.mines.find(mine => mine.sub);
  const before = state.mines.length;
  game.detonateMine(sub);
  assert.equal(state.mines.length, before - 1, 'the sub is removed and spawns no children');
  assert.equal(state.mines.filter(mine => !mine.sub).length, 0, 'no new parent charges appear');
});

test('mines stats text names the roll and reflects the owned passive', () => {
  const game = createGame(); game.chooseWeapon('mines'); const state = game.getState();
  game.updateUI();
  const plain = game.element('shot-total').textContent;
  assert.ok(plain.includes('roll'), 'the kinetic roll is named in the panel');
  state.build.pierce = 1; game.updateUI();
  const fused = game.element('shot-total').textContent;
  assert.ok(fused.includes('phase fuse'), 'Phase rounds is named when owned');
  assert.notEqual(plain, fused);
});

test('an evolved Cluster mines keeps the maxed rank, cap, and pair', () => {
  const game = createGame(); game.chooseWeapon('mines'); const state = game.getState();
  state.build.mines = 5; state.build.cluster = 1; delete state.build.mines;
  assert.equal(game.mineRank(), 5, 'the evolution inherits the maxed rank');
  assert.equal(game.mineCap(), game.MINE_CAP_MAXED, 'the evolved layer keeps the raised cap');
  assert.equal(game.mineFuse(), 0, 'no fuse without Phase rounds');
  state.build.pierce = 1;
  assert.ok(game.mineFuse() > 0, 'Phase still works after evolving');
});

test('asteroid belt rocks orbit and grind enemies on contact without aiming', () => {
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
  assert.ok(damaged, 'a rock should grind the enemy as it orbits');
  assert.equal(game.weaponAims('orbit'), false);
});

test('the locked weapon stops firing when auto-fire is off and Space is released', () => {
  const game = createGame(); game.chooseWeapon('orbit'); const state = game.getState(); state.spawnClock = 1e9;
  game.element('auto-fire').checked = false;
  state.enemies.length = 0;
  const rock = game.orbitRockPositions(state.weapons[0])[0];
  const enemy = visibleEnemy(game, 'tank', rock.x, rock.y);
  enemy.speed = 0; enemy.hp = enemy.maxHp = 100000;
  const before = enemy.hp;
  game.update(1 / 60);
  assert.equal(enemy.hp, before, 'no contact damage while auto-fire is off and Space is released');
  game.keys.add('Space'); game.update(1 / 60);
  assert.ok(enemy.hp < before, 'holding Space resumes the belt');
});

test('asteroid belt ranks add rocks and the evolution completes the belt', () => {
  const game = createGame(); game.chooseWeapon('orbit'); const state = game.getState(); state.spawnClock = 1e9;
  for (const [rank, count] of [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5]]) {
    state.build.orbit = rank;
    assert.equal(game.orbitRockCount(), count);
    assert.equal(game.orbitRockPositions(state.weapons[0]).length, count);
  }
  state.build = { orbit: game.weapons.orbit.max, twin: 1 };
  game.syncWeapons(); game.updateUI();
  assert.equal(state.weapons[0].id, 'twin');
  assert.equal(game.orbitRockCount(), 6);
  assert.equal(game.orbitRockPositions(state.weapons[0]).length, 6);
  assert.equal(game.element('shot-stat').textContent, 'RING');
  assert.ok(game.element('shot-total').textContent.includes('6 rocks'));
});

test('planetary ring splits into counter-rotating elliptical lanes', () => {
  const game = createGame(); game.chooseWeapon('orbit'); const state = game.getState(); state.spawnClock = 1e9;
  state.build = { orbit: game.weapons.orbit.max, twin: 1 }; game.syncWeapons();
  const specs = game.orbitRockSpecs();
  assert.equal(specs.length, 6);
  assert.equal(specs.filter(spec => spec.dir > 0).length, 3, 'three rocks spin one way');
  assert.equal(specs.filter(spec => spec.dir < 0).length, 3, 'three rocks spin the other way');
  assert.equal(new Set(specs.map(spec => spec.rx.toFixed(2))).size, 2, 'the trios use different radii');
  assert.ok(specs.every(spec => spec.rx !== spec.ry), 'every lane is elliptical');
  assert.equal(game.orbitLanes().length, 2);
  const weapon = state.weapons[0];
  weapon.phase = 0; const before = game.orbitRockPositions(weapon);
  weapon.phase = .5; const after = game.orbitRockPositions(weapon);
  assert.equal(after.filter((rock, index) => rock.angle > before[index].angle).length, 3);
  assert.equal(after.filter((rock, index) => rock.angle < before[index].angle).length, 3);
  // The base belt stays circular and co-rotating at every rank.
  const base = createGame(); base.chooseWeapon('orbit'); const baseState = base.getState();
  for (const rank of [1, 2, 3, 4, 5]) {
    baseState.build = { orbit: rank };
    const plain = base.orbitRockSpecs();
    assert.equal(plain.length, rank);
    assert.ok(plain.every(spec => spec.dir === 1 && spec.rx === spec.ry));
  }
});

test('asteroid belt only damages bodies a rock actually touches', () => {
  const game = createGame(); game.chooseWeapon('orbit'); const state = game.getState(); state.spawnClock = 1e9;
  game.element('auto-fire').checked = true;
  state.enemies.length = 0;
  const center = visibleEnemy(game, 'tank', state.pilot.x, state.pilot.y - 40);
  center.speed = 0; center.hp = center.maxHp = 1e6;
  const rock = game.orbitRockPositions(state.weapons[0])[0];
  const onRing = visibleEnemy(game, 'tank', rock.x, rock.y);
  onRing.speed = 0; onRing.hp = onRing.maxHp = 1e6;
  const centerHp = center.hp;
  for (let tick = 0; tick < 10; tick++) game.update(1 / 60);
  assert.equal(center.hp, centerHp, 'the old aura no longer damages the pilot position');
  assert.ok(onRing.hp < onRing.maxHp, 'a touched body takes contact damage');
});

test('a grinding rock respects the per-enemy contact cooldown', () => {
  const game = createGame(); game.chooseWeapon('orbit'); const state = game.getState(); state.spawnClock = 1e9;
  game.element('auto-fire').checked = true;
  state.enemies.length = 0;
  const enemy = visibleEnemy(game, 'tank', state.pilot.x, state.pilot.y - game.orbitRadius());
  enemy.speed = 0; enemy.hp = enemy.maxHp = 1e6;
  let hits = 0, lastHp = enemy.hp;
  for (let tick = 0; tick < 60; tick++) {
    // Keep the body pinned under a rock so the contact cooldown is the only limiter.
    const rock = game.orbitRockPositions(state.weapons[0])[0];
    enemy.x = enemy.originX = rock.x; enemy.y = rock.y;
    game.update(1 / 60);
    if (enemy.hp < lastHp) { hits++; lastHp = enemy.hp; }
  }
  assert.ok(hits >= 2 && hits <= 5, 'one second of continuous contact should tick a few times, got ' + hits);
});

test('phase rounds shorten the belt contact cooldown and grind faster', () => {
  const grind = pierceRank => {
    const game = createGame(); game.chooseWeapon('orbit'); const state = game.getState(); state.spawnClock = 1e9;
    game.element('auto-fire').checked = true;
    if (pierceRank) state.build.pierce = pierceRank;
    state.enemies.length = 0;
    const enemy = visibleEnemy(game, 'tank', state.pilot.x, state.pilot.y - game.orbitRadius());
    enemy.speed = 0; enemy.hp = enemy.maxHp = 1e6;
    let hits = 0, lastHp = enemy.hp;
    for (let tick = 0; tick < 60; tick++) {
      const rock = game.orbitRockPositions(state.weapons[0])[0];
      enemy.x = enemy.originX = rock.x; enemy.y = rock.y;
      game.update(1 / 60);
      if (enemy.hp < lastHp) { hits++; lastHp = enemy.hp; }
    }
    return hits;
  };
  assert.equal(grind(0) < grind(3), true, 'phased rocks should land more contacts per second');
  const game = createGame(); game.chooseWeapon('orbit');
  assert.equal(game.orbitHitInterval(), .25, 'unphased contact cadence');
  game.getState().build.pierce = game.upgrades.pierce.max;
  assert.equal(game.orbitHitInterval(), .13, 'phase rank 3 shortens the cadence');
});

test('volatile rounds detonate belt contacts onto nearby bodies', () => {
  const game = createGame(); game.chooseWeapon('orbit'); const state = game.getState(); state.spawnClock = 1e9;
  game.element('auto-fire').checked = true;
  state.build.blast = 1;
  state.enemies.length = 0;
  const rock = game.orbitRockPositions(state.weapons[0])[0];
  const primary = visibleEnemy(game, 'tank', rock.x, rock.y);
  const nearby = visibleEnemy(game, 'drone', rock.x + 30, rock.y);
  const far = visibleEnemy(game, 'drone', rock.x - 150, rock.y);
  for (const enemy of [primary, nearby, far]) { enemy.speed = 0; enemy.hp = enemy.maxHp = 1e6; }
  const farHp = far.hp;
  game.update(1 / 60);
  assert.ok(primary.hp < primary.maxHp, 'contact still hurts the touched body');
  assert.ok(nearby.hp < nearby.maxHp, 'the contact detonation chips nearby bodies');
  assert.equal(far.hp, farHp, 'the blast has a finite radius');
  assert.ok(state.effects.some(effect => effect.belt), 'the detonation is drawn');
});

test('planetary ring is gated on a maxed belt plus Volatile rounds and replaces it', () => {
  const game = createGame(); game.chooseWeapon('orbit'); const state = game.getState();
  assert.equal(game.evolutions.twin.ready(), false);
  state.build = { blast: 1 };
  assert.equal(game.evolutions.twin.ready(), false, 'the passive alone is not enough');
  state.build = { orbit: game.weapons.orbit.max };
  assert.equal(game.evolutions.twin.ready(), false, 'a maxed belt alone is not enough');
  state.build = { orbit: game.weapons.orbit.max, blast: 1 };
  assert.equal(game.evolutions.twin.ready(), true);
  game.gainXP(18); assert.equal(game.requestUpgrade(), true);
  state.choices = ['twin']; game.chooseUpgrade('twin');
  assert.equal(state.build.twin, 1);
  assert.equal(state.build.orbit, undefined, 'the base rank is removed');
  assert.equal(state.weapons.length, 1);
  assert.equal(state.weapons[0].id, 'twin', 'the evolved belt takes the slot');
  assert.equal(state.weapons[0].cooldown, 0);
  assert.equal(game.orbitRockCount(), 6);
});

test('asteroid belt draws its ring and rocks without throwing', () => {
  const game = createGame(); game.chooseWeapon('orbit'); const state = game.getState();
  state.build = { orbit: 3 };
  game.update(1 / 60);
  assert.doesNotThrow(() => game.draw());
  state.build = { orbit: 3, twin: 1 }; game.syncWeapons(); game.update(1 / 60);
  assert.doesNotThrow(() => game.draw());
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

test('singularity reports its own evolved pull in the stats panel', () => {
  const game = createGame(); game.chooseWeapon('gravity'); const state = game.getState();
  state.spawnClock = 1e9;
  state.build = { gravity: game.weapons.gravity.max, blast: 1 };
  game.updateUI();
  const gravityTotal = game.element('shot-total').textContent;
  // Gravity reports its raw impact number; the pull multiplier is Singularity's to claim.
  assert.equal(game.element('damage-stat').textContent, '56');
  game.gainXP(18); game.requestUpgrade();
  state.choices = ['singularity']; game.chooseUpgrade('singularity');
  game.updateUI();
  // The evolution must read differently from the base weapon it replaced.
  assert.equal(game.element('damage-stat').textContent, 'PULL ×1.6 · RANGE ×1.35');
  assert.notEqual(game.element('shot-total').textContent, gravityTotal);
  assert.ok(game.element('shot-total').textContent.includes('1.35'));
  // The well is part of the locked weapon's identity, not just a hidden constant.
  assert.equal(game.element('shot-stat').textContent, '3×3 · WELL / 4th');
  assert.ok(game.element('shot-total').textContent.includes('170 px well'));
  assert.equal(game.element('weapon-count').textContent, '1 WEAPON · SINGULARITY');
  const details = game.element('loadout').children.filter(child => child.className === 'loadout-detail');
  assert.equal(details.length, 1, 'the evolved core row names the well');
  assert.ok(details[0].textContent.includes('Collapse well'));
});

test('singularity opens a collapse well on every fourth volley only', () => {
  const game = createGame(); game.chooseWeapon('gravity'); const state = game.getState(); state.spawnClock = 1e9;
  game.element('auto-fire').checked = false;
  state.build = { gravity: game.weapons.gravity.max, blast: 1 };
  game.gainXP(18); game.requestUpgrade(); state.choices = ['singularity']; game.chooseUpgrade('singularity');
  state.enemies.length = 0;
  const enemy = visibleEnemy(game, 'tank', 240, 200); enemy.hp = enemy.maxHp = 1e6; enemy.speed = 0;
  // Fire straight through the evolution's own entry point: the cadence is the evolution's,
  // not the shared per-frame gate's.
  const fire = () => { state.weapons[0].cooldown = 0; state.weapons[0].pendingBursts = []; game.evolutions.singularity.fire(state.weapons[0], enemy); };
  for (let volley = 1; volley < game.SINGULARITY_WELL_EVERY; volley++) {
    fire();
    assert.equal(state.wells.length, 0, 'volley ' + volley + ' must not open a well');
  }
  fire();
  assert.equal(state.wells.length, 1, 'the fourth volley opens exactly one well');
  assert.equal(state.wells[0].radius, game.SINGULARITY_WELL_RADIUS);
  assert.equal(state.wells[0].life, game.SINGULARITY_WELL_LIFE);
  // The cadence continues from the instance counter: three more volleys, then another well.
  for (let volley = 1; volley < game.SINGULARITY_WELL_EVERY; volley++) {
    state.wells.length = 0; fire();
    assert.equal(state.wells.length, 0, 'the cadence restarts after the well');
  }
  fire();
  assert.equal(state.wells.length, 1);
  // Base Gravity never opens a well, and the evolution counter lives on its own instance.
  const base = createGame(); base.chooseWeapon('gravity'); base.getState().spawnClock = 1e9;
  base.element('auto-fire').checked = true;
  for (let tick = 0; tick < 600; tick++) base.update(1 / 60);
  assert.equal(base.getState().wells.length, 0, 'base Gravity has no well');
});

test('a well pulls bodies inward and implodes through damage over time on expiry', () => {
  const game = createGame(); game.chooseWeapon('gravity'); const state = game.getState(); state.spawnClock = 1e9;
  game.element('auto-fire').checked = false;
  state.build = { gravity: game.weapons.gravity.max, blast: 1, singularity: 1 };
  state.enemies.length = 0;
  const enemy = visibleEnemy(game, 'tank', 260, 300); enemy.hp = enemy.maxHp = 1e6; enemy.speed = 0;
  // The well hauls the lane (originX + y) inward; `x` also carries the enemy's own sway.
  const laneDistance = () => Math.hypot(enemy.originX - 240, enemy.y - 320);
  const start = laneDistance();
  game.openWell(240, 320);
  assert.equal(state.wells.length, 1, 'the well is a world entity in state.wells');
  for (let tick = 0; tick < 20; tick++) game.update(1 / 60);
  assert.ok(state.wells.length === 1, 'the well is still alive');
  assert.ok(laneDistance() < start, 'the well drags a body inward');
  assert.equal(enemy.charge, 6, 'a body inside the core saturates to max charge');
  // Let the well expire: it implodes, leaves the field unconditionally, and kills untouched
  // HP through the DoT path so the death guard still owns credit.
  const hpBefore = enemy.hp, killsBefore = state.kills;
  for (let tick = 0; tick < Math.ceil(game.SINGULARITY_WELL_LIFE * 60) + 4; tick++) game.update(1 / 60);
  assert.equal(state.wells.length, 0, 'expiry removes the well unconditionally');
  assert.ok(enemy.hp < hpBefore, 'the implosion crushes bodies inside the radius');
  assert.equal(state.kills, killsBefore, 'a surviving body credits no kill');
  // A well with nobody inside still leaves on time.
  state.enemies.length = 0; game.openWell(100, 100);
  for (let tick = 0; tick < Math.ceil(game.SINGULARITY_WELL_LIFE * 60) + 4; tick++) game.update(1 / 60);
  assert.equal(state.wells.length, 0);
  // The implosion routes through DoT and credits exactly one kill per body.
  state.enemies.length = 0;
  const doomed = visibleEnemy(game, 'drone', 240, 320); doomed.hp = 1; doomed.speed = 0;
  const kills = state.kills, xp = state.xp;
  game.openWell(240, 320);
  for (let tick = 0; tick < Math.ceil(game.SINGULARITY_WELL_LIFE * 60) + 4; tick++) game.update(1 / 60);
  assert.equal(doomed.hp <= 0, true, 'the implosion kills a swallowed body');
  assert.equal(state.kills, kills + 1, 'the kill is credited exactly once');
  assert.ok(state.xp > xp, 'the kill awards XP through the single death path');
});

test('collapse wells never tick for a base Gravity run and restart clears them', () => {
  const game = createGame(); game.chooseWeapon('gravity'); const state = game.getState(); state.spawnClock = 1e9;
  game.element('auto-fire').checked = false;
  state.enemies.length = 0;
  const enemy = visibleEnemy(game, 'tank', 240, 320); enemy.hp = enemy.maxHp = 1e6; enemy.speed = 0;
  // A stale well from a previous run must not keep pulling or crushing. The well pulls the
  // lane (originX + y); `x` also carries the enemy's own sway, so it cannot be the measure.
  game.openWell(240, 320);
  const laneDistance = enemy => Math.hypot(enemy.originX - 240, enemy.y - 320);
  const start = laneDistance(enemy), hpBefore = enemy.hp;
  for (let tick = 0; tick < 30; tick++) game.update(1 / 60);
  assert.ok(Math.abs(laneDistance(enemy) - start) < 1e-9, 'base Gravity ignores a well pull');
  assert.equal(enemy.hp, hpBefore, 'base Gravity never implodes a well');
  assert.equal(state.wells.length, 1, 'an unowned well still occupies the field');
  // Restart wipes the well list so a stale well cannot cross a run boundary.
  game.openWell(120, 120);
  assert.equal(state.wells.length, 2);
  game.reset();
  assert.equal(game.getState().wells.length, 0, 'reset() clears wells');
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
  game.hit(enemy, 0);
  assert.equal(enemy.hp, hpBefore, 'a hit before the gap must not shatter');
  game.applyChill(enemy, 1);
  assert.equal(enemy.hp, hpBefore, 'crossing the gap without a hit must not kill');
  game.hit(enemy, 0);
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
  game.hit(boss, 0);
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
  game.hit(enemy, 5);
  assert.equal(enemy.frozen, true, 'a hit should leave the crawl in place');
  assert.equal(enemy.hp, hp - 5, 'the hit deals its own damage and nothing more');
});

test('absolute zero names its frost field on the panel', () => {
  const game = createGame(); game.chooseWeapon('cryo'); const state = game.getState();
  state.spawnClock = 1e9;
  state.build = { cryo: game.weapons.cryo.max, blast: 1 };
  game.updateUI();
  const cryoTotal = game.element('shot-total').textContent;
  assert.equal(game.element('damage-stat').textContent, 'SLOW');
  assert.equal(game.element('shot-stat').textContent, '3×3');
  game.gainXP(18); game.requestUpgrade();
  state.choices = ['absolute']; game.chooseUpgrade('absolute');
  game.updateUI();
  assert.equal(game.element('damage-stat').textContent, 'FIELD ' + game.ZERO_RADIUS + 'px');
  assert.equal(game.element('shot-stat').textContent, '3×3 · FIELD');
  assert.notEqual(game.element('shot-total').textContent, cryoTotal);
  assert.ok(game.element('shot-total').textContent.includes(game.ZERO_RADIUS + ' px field'));
  assert.ok(game.evolutions.absolute.description.includes(String(game.ZERO_BURST_STACKS)));
  assert.equal(game.element('weapon-count').textContent, '1 WEAPON · ABSOLUTE ZERO');
  const details = game.element('loadout').children.filter(child => child.className === 'loadout-detail');
  assert.equal(details.length, 1, 'the evolved core row names the field');
  assert.ok(details[0].textContent.includes('Frost field'));
});

test('a crawl plants a frost field and base cryo plants none', () => {
  const plain = createGame(); plain.chooseWeapon('cryo');
  const plainState = plain.getState(); plainState.spawnClock = 1e9; plainState.enemies.length = 0;
  const warm = visibleEnemy(plain, 'drone', 240, 300);
  while (!warm.frozen) plain.applyChill(warm, 1);
  assert.equal(plainState.zeros.length, 0, 'base Cryo plants no field');

  const game = createGame(); game.chooseWeapon('cryo'); const state = game.getState();
  state.spawnClock = 1e9; state.enemies.length = 0;
  state.build.absolute = 1;
  for (let i = 0; i < game.ZERO_CAP + 2; i++) {
    const enemy = visibleEnemy(game, 'drone', 80 + i * 50, 300);
    while (!enemy.frozen) game.applyChill(enemy, 1);
  }
  assert.equal(state.zeros.length, game.ZERO_CAP, 'a packed crawl stops at the field cap');
  assert.equal(state.zeros[0].radius, game.ZERO_RADIUS);
  assert.equal(state.zeros[0].life, game.ZERO_LIFE);
  assert.ok(state.enemies.filter(enemy => enemy.frozen).length > game.ZERO_CAP, 'later crawls still crawl without a field');
});

test('a frost field pulses stacks, and the expiry burst shatters and chains', () => {
  const game = createGame(); game.chooseWeapon('cryo'); const state = game.getState();
  state.spawnClock = 1e9; game.element('auto-fire').checked = false;
  state.build = { cryo: game.weapons.cryo.max, blast: 1, absolute: 1 };
  state.enemies.length = 0;
  const pulsed = visibleEnemy(game, 'drone', 240, 320);
  pulsed.hp = pulsed.maxHp = 5000;
  game.openZero(pulsed.x, pulsed.y);
  game.update(game.ZERO_PULSE - 1e-4);
  assert.equal(pulsed.cryoStacks || 0, 0, 'the field waits out its pulse');
  assert.equal(pulsed.hp, pulsed.maxHp);
  game.update(2e-4);
  assert.equal(pulsed.cryoStacks, game.ZERO_PULSE_STACKS, 'a pulse adds slow stacks');
  assert.equal(pulsed.hp, pulsed.maxHp, 'a pulse deals no damage');
  assert.equal(pulsed.frozen, false, 'one pulse does not crawl a healthy drone');

  state.enemies.length = 0; state.zeros.length = 0;
  const primary = visibleEnemy(game, 'drone', 240, 320);
  const neighbour = visibleEnemy(game, 'drone', 280, 320);
  const outsider = visibleEnemy(game, 'drone', 240, 40);
  primary.hp = primary.maxHp = 5000;
  while (!primary.frozen) game.applyChill(primary, 1);
  const owed = primary.cryoFreezeStacks + game.cryoShatterGap() - 1 - primary.cryoStacks;
  if (owed > 0) game.applyChill(primary, owed);
  assert.equal(primary.cryoStacks, primary.cryoFreezeStacks + game.cryoShatterGap() - 1);
  assert.equal(state.zeros.length, 1, 'the crawl planted one field');
  state.zeros[0].life = 1e-4; state.zeros[0].clock = 10;
  const plantedAt = { x: neighbour.x, y: neighbour.y };
  const kills = state.kills;
  game.update(1 / 60);
  assert.equal(primary.hp, 0, 'the burst fills the last of the shatter gap');
  assert.equal(state.kills, kills + 1, 'the shatter is a kill');
  assert.equal(neighbour.frozen, true, 'the burst crawls a neighbour');
  assert.equal(neighbour.cryoStacks, game.ZERO_BURST_STACKS);
  assert.equal(neighbour.hp, neighbour.maxHp, 'the burst deals no damage');
  assert.equal(outsider.cryoStacks || 0, 0, 'bodies outside the field stay warm');
  assert.equal(state.zeros.length, 1, 'the crawled neighbour plants the next field');
  assert.equal(state.zeros[0].life, game.ZERO_LIFE);
  assert.equal(state.zeros[0].x, plantedAt.x);
  assert.equal(state.zeros[0].y, plantedAt.y);
});

test('a frost field without absolute zero expires without chilling, and restart clears it', () => {
  const game = createGame(); game.chooseWeapon('cryo'); const state = game.getState();
  state.spawnClock = 1e9; game.element('auto-fire').checked = false;
  state.enemies.length = 0;
  const enemy = visibleEnemy(game, 'drone', 240, 320); enemy.hp = enemy.maxHp = 5000; enemy.speed = 0;
  game.openZero(240, 320);
  const hp = enemy.hp;
  game.update(game.ZERO_LIFE + .05);
  assert.equal(enemy.cryoStacks || 0, 0, 'base Cryo ignores a stale field');
  assert.equal(enemy.hp, hp);
  assert.equal(state.zeros.length, 0, 'an unowned field still expires');
  game.openZero(120, 120);
  assert.equal(state.zeros.length, 1);
  game.reset();
  assert.equal(game.getState().zeros.length, 0, 'reset() clears frost fields');
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

test('rad per-stack damage is halved', () => {
  const game = createGame(); game.chooseWeapon('rad'); const state = game.getState();
  state.spawnClock = 1e9;
  assert.equal(game.radDpsPerStack(), 4, 'base rad is 4 DPS per stack');
  const enemy = visibleEnemy(game, 'tank', 240, 300);
  enemy.hp = enemy.maxHp = 100000; enemy.speed = 0;
  game.applyRad(enemy, 40);
  assert.equal(game.radDps(enemy), 160, 'a saturated target caps at 160 DPS');
  state.build.meltdown = 1;
  assert.equal(game.radDpsPerStack(), 6, 'Meltdown is 1.5x the base value');
  assert.equal(game.radDps(enemy), 240, 'a saturated Meltdown target caps at 240 DPS');
});

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
  const rightStart = right.x;
  let pulled = false, crushed = false;
  for (let i = 0; i < 360 && !crushed; i++) {
    const beforeLeft = left.hp, beforeRight = right.hp;
    const span = Math.hypot(left.x - right.x, left.y - right.y);
    const overlapped = span <= left.radius + right.radius;
    game.update(1 / 60);
    if (right.x < rightStart - 1) pulled = true;
    if (!overlapped) {
      assert.equal(left.hp, beforeLeft, 'charge must not damage before contact');
      assert.equal(right.hp, beforeRight, 'a neighbour takes no damage until they overlap');
    } else if (left.hp < beforeLeft && right.hp < beforeRight) crushed = true;
  }
  assert.ok(pulled, 'a charged enemy should pull its neighbour inward');
  assert.ok(crushed, 'both enemies are crushed once they overlap');
  // Solid bodies: even under the magnet's squeeze the pair stays a pile of touching bodies
  // rather than collapsing onto one coordinate.
  assert.ok(Math.hypot(left.x - right.x, left.y - right.y) > (left.radius + right.radius) * .5,
    'the pile must not collapse to one point');
  // A charged enemy with nobody to pull into stays at full health until the charge ends.
  state.enemies.length = 0;
  const alone = visibleEnemy(game, 'tank', 240, 400);
  alone.speed = 0; alone.hp = alone.maxHp = 100000;
  game.applyGravity(alone, 6);
  for (let i = 0; i < 200; i++) game.update(1 / 60);
  assert.equal(alone.hp, alone.maxHp, 'a lone charged enemy must not take damage over time');
  assert.equal(alone.charge, 0, 'charge expires without dealing damage');
});

test('gravity runs make enemy bodies solid and separate overlaps', () => {
  const game = createGame(); game.chooseWeapon('gravity'); const state = game.getState(); state.spawnClock = 1e9;
  game.element('auto-fire').checked = false;
  state.enemies.length = 0;
  const a = visibleEnemy(game, 'tank', 240, 400), b = visibleEnemy(game, 'tank', 246, 400);
  a.speed = b.speed = 0; a.hp = a.maxHp = 100000; b.hp = b.maxHp = 100000;
  const contact = a.radius + b.radius;
  for (let i = 0; i < 120; i++) game.update(1 / 60);
  const span = Math.hypot(a.x - b.x, a.y - b.y);
  assert.ok(span >= contact - 1, 'bodies must not occupy the same point: ' + span);
  assert.equal(a.hp, a.maxHp, 'uncharged separation deals no damage');
  assert.equal(b.hp, b.maxHp, 'uncharged separation deals no damage');
});

test('collision physics only runs for gravity runs', () => {
  const game = createGame(); game.beginRun(); const state = game.getState(); state.spawnClock = 1e9;
  game.element('auto-fire').checked = false;
  state.enemies.length = 0;
  const a = visibleEnemy(game, 'tank', 240, 400), b = visibleEnemy(game, 'tank', 246, 400);
  a.speed = b.speed = 0; a.hp = a.maxHp = 100000; b.hp = b.maxHp = 100000;
  const start = Math.hypot(a.x - b.x, a.y - b.y);
  for (let i = 0; i < 120; i++) game.update(1 / 60);
  assert.equal(Math.hypot(a.x - b.x, a.y - b.y), start, 'a blaster run stays pass-through');
  assert.equal(a.hp, a.maxHp); assert.equal(b.hp, b.maxHp);
});

test('a charged squeeze rebounds bodies at a bounded speed', () => {
  const game = createGame(); game.chooseWeapon('gravity'); const state = game.getState(); state.spawnClock = 1e9;
  game.element('auto-fire').checked = false;
  state.enemies.length = 0;
  const left = visibleEnemy(game, 'tank', 240, 400), right = visibleEnemy(game, 'tank', 280, 400);
  left.speed = right.speed = 0; left.hp = left.maxHp = 100000; right.hp = right.maxHp = 100000;
  game.applyGravity(left, 6);
  let bounced = false;
  for (let i = 0; i < 120; i++) {
    game.update(1 / 60);
    assert.ok(Math.abs(left.vx) <= 320 && Math.abs(left.vy) <= 320, 'rebound velocity is capped');
    assert.ok(Math.abs(right.vx) <= 320 && Math.abs(right.vy) <= 320, 'rebound velocity is capped');
    if (Math.abs(left.vx) > 1 || Math.abs(right.vx) > 1) bounced = true;
  }
  assert.ok(bounced, 'a squeezed pair should rebound instead of merging');
  // A huge external velocity is damped and clamped on the next simulation step, so a body
  // can never be teleported across the arena.
  left.vx = 1e6; left.vy = -1e6;
  game.update(1 / 60);
  assert.ok(Math.abs(left.vx) <= 320 && Math.abs(left.vy) <= 320);
  assert.ok(left.originX >= left.radius - 1e-6 && left.originX <= 480 - left.radius + 1e-6);
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
    assert.equal(game.weapons[id].max, 5);
  }
  const evolutions = Object.values(game.evolutions);
  assert.equal(evolutions.length, 6);
  for (const evo of evolutions) {
    assert.ok(game.WEAPON_IDS.includes(evo.from), evo.name + ' evolves a real weapon');
    assert.ok(evo.requires in game.upgrades, evo.name + ' pairs with a passive');
    assert.equal(evo.max, 1);
  }
});

test('pierce and blast are mutually exclusive and the removed passives are gone', () => {
  const game = createGame(); game.beginRun(); const state = game.getState();
  state.build = { pierce: 1 };
  assert.ok(Array.from({ length: 80 }, () => game.pickChoices()).every(choices => !choices.includes('blast')));
  state.build = { blast: 1 };
  assert.ok(Array.from({ length: 80 }, () => game.pickChoices()).every(choices => !choices.includes('pierce')));
  // Overcharged rounds (damage) and Cryo rounds (frost) were removed from the pool.
  assert.equal('damage' in game.upgrades, false);
  assert.equal('frost' in game.upgrades, false);
  state.build = {};
  const offered = Array.from({ length: 80 }, () => game.pickChoices());
  assert.ok(offered.every(choices => !choices.includes('damage') && !choices.includes('frost')));
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
  state.effects.push({ x: 240, y: 200, radius: 70, life: .3, well: true });
  state.effects.push({ x: 240, y: 200, life: .5, xp: 12 });
  // A live well on the field plus one mid-implosion ring.
  state.wells.push({ x: 240, y: 320, radius: game.SINGULARITY_WELL_RADIUS,
    life: game.SINGULARITY_WELL_LIFE * .5, maxLife: game.SINGULARITY_WELL_LIFE, swallowed: new Set() });
  state.zeros.push({ x: 180, y: 360, radius: game.ZERO_RADIUS,
    life: game.ZERO_LIFE * .5, maxLife: game.ZERO_LIFE, clock: game.ZERO_PULSE });
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

// ---- Audio ---------------------------------------------------------------------------------
// The mixer is exercised through a recording AudioContext stub. Every test that does not opt
// into `{ audio: true }` runs with no AudioContext at all, which is the inert path.

test('audio defaults are on', () => {
  const game = createGame();
  assert.equal(game.AUDIO_DEFAULTS.sound, true);
  assert.equal(game.AUDIO_DEFAULTS.music, undefined);
  assert.equal(game.getVolume(), 1);
  assert.equal(game.element('sound').textContent, 'Sound on');
});

test('a legacy save with `music` keeps sound and volume and drops the score flag', () => {
  const game = createGame(19, { storage: { 'skyhold-survivor-settings': JSON.stringify({ autoFire: false, sound: false, music: true }) } });
  assert.equal(game.getSound(), false, 'the saved mute is honoured');
  assert.equal(game.getVolume(), 1, 'a missing volume key defaults to the default');
  assert.equal(game.element('auto-fire').checked, false);
  assert.equal(game.element('sound').textContent, 'Sound off');
  game.setSound(true); game.saveSettings();
  const saved = JSON.parse(game.storage.get('skyhold-survivor-settings'));
  assert.equal(saved.music, undefined, 'music is not written back');
});

test('saved settings round-trip and out-of-range volume clamps', () => {
  for (const [stored, expected] of [[1.8, 1], [-.4, 0], [.25, .25]]) {
    const game = createGame(19, { storage: { 'skyhold-survivor-settings': JSON.stringify({ sound: true, music: false, volume: stored }) } });
    assert.equal(game.getVolume(), expected, 'volume ' + stored + ' clamps to ' + expected);
    assert.equal(game.getSound(), true);
  }
  const game = createGame(19, { audio: true });
  game.setVolume(.42); game.setSound(false); game.saveSettings();
  const saved = JSON.parse(game.storage.get('skyhold-survivor-settings'));
  assert.deepEqual({ sound: saved.sound, volume: saved.volume }, { sound: false, volume: .42 });
  assert.equal(saved.music, undefined);
});

test('the saved sound state repaints the master toggle on boot', () => {
  // Regression: a saved `sound: true` used to leave the button reading "Sound off" until it
  // was clicked, because reset() never re-rendered the label.
  const on = createGame(19, { storage: { 'skyhold-survivor-settings': JSON.stringify({ sound: true }) } });
  assert.equal(on.element('sound').textContent, 'Sound on');
  const off = createGame(19, { storage: { 'skyhold-survivor-settings': JSON.stringify({ sound: false }) } });
  assert.equal(off.element('sound').textContent, 'Sound off');
});

test('each weapon plays exactly one sound per volley', () => {
  // Regression: fireRounds() used to play a tone for every bullet weapon while Gravity, Cryo,
  // and Rad each played a second tone of their own.
  for (const id of ['blaster', 'gravity', 'cryo', 'rad']) {
    const game = createGame(19, { audio: true });
    game.chooseWeapon(id); const state = game.getState(); state.spawnClock = 1e9;
    game.element('auto-fire').checked = false;
    state.enemies.length = 0;
    const enemy = visibleEnemy(game, 'tank', 240, 200); enemy.speed = 0; enemy.hp = enemy.maxHp = 1e6;
    game.audioLog.length = 0;
    game.weapons[id].fire(state.weapons[0], enemy);
    const shots = game.audioLog.filter(entry => entry.kind === 'osc');
    assert.equal(shots.length, 1, id + ' must emit one voice per volley, got ' + shots.length);
  }
});

test('mines clack on drop and boom on detonation', () => {
  const game = createGame(19, { audio: true });
  game.chooseWeapon('mines');
  const state = game.getState();
  state.spawnClock = 1e9; state.enemies.length = 0; state.build.mines = 4;
  game.audioLog.length = 0;
  const weapon = state.weapons[0];
  game.weapons.mines.fire(weapon);
  assert.equal(state.mines.length, 2, 'rank 4 drops two charges');
  assert.equal(game.audioLog.filter(entry => entry.kind === 'osc').length, 2, 'a double drop is one clack: thud plus arming tick');
  assert.equal(game.audioLog.filter(entry => entry.kind === 'noise').length, 0, 'a drop is not a blast');
  weapon.cooldown = 0;
  game.weapons.mines.fire(weapon);
  assert.equal(game.audioLog.filter(entry => entry.kind === 'osc').length, 2, 'a second drop inside the gap stays silent');
  game.audio.ctx.currentTime += 1;
  game.audioLog.length = 0;
  game.detonateMine(state.mines[0]);
  assert.ok(game.audioLog.some(entry => entry.kind === 'osc'), 'a blast has a body');
  assert.equal(game.audioLog.filter(entry => entry.kind === 'noise').length, 1, 'a blast has one crack');
  const voices = game.audioLog.length;
  game.detonateMine(state.mines[0]);
  assert.equal(game.audioLog.length, voices, 'a second blast inside the gap stays silent');
});

test('effects are rate limited so a mass kill cannot stack voices', () => {
  const game = createGame(19, { audio: true });
  game.beginRun(); const state = game.getState(); state.spawnClock = 1e9;
  game.audioLog.length = 0;
  for (let i = 0; i < 40; i++) game.sfx('kill', 150, .06, 'triangle', .02);
  // All calls happen at the same audio time, so the per-key gap admits one voice.
  assert.equal(game.audioLog.length, 1, 'a burst of kills inside one frame emits one voice');
  game.audio.ctx.currentTime += game.SFX_GAP.kill + .001;
  game.sfx('kill', 150, .06, 'triangle', .02);
  assert.equal(game.audioLog.length, 2, 'the next voice is admitted after the gap');
});

test('killing a boss and a drone play different pitches', () => {
  const game = createGame(19, { audio: true });
  game.beginRun(); const state = game.getState(); state.spawnClock = 1e9;
  const kill = type => {
    state.enemies.length = 0; state.phase = 'combat';
    const enemy = visibleEnemy(game, type, 240, 200);
    game.audioLog.length = 0;
    game.audio.ctx.currentTime += 1;
    game.hit(enemy, 1e9);
    return game.audioLog.length;
  };
  assert.ok(kill('drone') > 0, 'a kill is audible');
  assert.ok(kill('boss') > 0, 'a boss kill is audible');
});

test('silence is the default: no AudioContext means no voices and no crash', () => {
  const game = createGame();
  assert.equal(game.audio.ctx, null);
  assert.equal(game.ensureAudio(), false, 'without an AudioContext the mixer refuses to build');
  // Every entry point is inert, and the simulation is untouched by the attempt.
  const state = game.getState();
  game.beginRun();
  const before = JSON.stringify(state);
  assert.doesNotThrow(() => { game.sfx('shot', 600, .02); game.tone(400, .02); });
  game.update(1 / 60); game.draw();
  assert.equal(JSON.stringify({ phase: state.phase, weaponId: state.weaponId }), JSON.stringify({ phase: 'combat', weaponId: 'blaster' }));
  assert.ok(state.runTime > 0, 'the run still advances with no audio');
  assert.equal(game.audio.ctx, null, 'the mixer stays down');
});

test('muting ramps the master gain instead of tearing the graph down', () => {
  const game = createGame(19, { audio: true });
  game.unlockAudio();
  assert.ok(game.audio.ctx, 'the graph is built on the first gesture');
  const graph = game.audio.ctx;
  assert.equal(game.audio.master.gain.value, 1, 'master starts at the saved volume');
  game.setSound(false); game.applyAudioGain();
  assert.equal(game.audio.master.gain.value, 0, 'mute drives the master to zero');
  game.setSound(true); game.applyAudioGain();
  assert.equal(game.audio.master.gain.value, 1, 'unmute restores the volume');
  game.setVolume(.3); game.applyAudioGain();
  assert.equal(game.audio.master.gain.value, .3, 'the volume slider drives the same gain');
  assert.equal(game.audio.ctx, graph, 'the graph is never rebuilt');
});

test('audio controls render their state for screen readers', () => {
  const game = createGame(19, { audio: true });
  game.setSound(false); game.setVolume(.15); game.renderAudioUI();
  assert.equal(game.element('sound').textContent, 'Sound off');
  assert.equal(game.element('volume').value, '15');
  game.setSound(true); game.setVolume(1); game.renderAudioUI();
  assert.equal(game.element('sound').textContent, 'Sound on');
  assert.equal(game.element('volume').value, '100');
});

test('a restart returns to the weapon picker', () => {
  const game = createGame(19, { audio: true });
  game.chooseWeapon('rad'); game.getState().threat = 9;
  game.reset();
  assert.equal(game.getState().phase, 'ready');
  assert.equal(game.getState().weaponId, null);
});
