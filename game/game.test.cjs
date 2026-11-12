// Run with: node --test game/game.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function createGame() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      checked: false, hidden: false, disabled: false, style: {}, dataset: {}, listeners: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(name, handler) { this.listeners[name] = handler; },
      setAttribute() {}, focus() {}, getContext() { return {}; }
    });
    return elements.get(id);
  };
  const towerButtons = ['pulse', 'cannon', 'frost'].map(type => { const button = element(type); button.dataset.tower = type; return button; });
  let seed = 19;
  const math = Object.create(Math);
  math.random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const sandbox = {
    Math: math, document: { getElementById: element, querySelectorAll: () => towerButtons, addEventListener() {} },
    window: { addEventListener() {} }, localStorage: { getItem: () => null, setItem() {} },
    setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame() {}
  };
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(__dirname, 'game.js'), 'utf8');
  const anchor = 'reset(); requestAnimationFrame(frame);';
  assert.ok(source.includes(anchor), 'test instrumentation anchor exists');
  vm.runInContext(source.replace(anchor, `
    globalThis.game = { reset, prepare, selectPad, launchWave, update, spawn, hit, damageBase, togglePause,
      getState: () => state, choose: type => { chosen = type; }, move: (x, y) => { pointer = { x, y }; },
      keys, isPaused: () => paused };
    reset();
  `), sandbox);
  return { ...sandbox.game, element };
}

test('construction, upgrade, and sale preserve the credit economy', () => {
  const game = createGame(); game.prepare(); game.selectPad(4);
  assert.equal(game.getState().credits, 120);
  game.element('upgrade').listeners.click();
  assert.equal(game.getState().towers[4].level, 2);
  assert.equal(game.getState().credits, 72);
  game.element('sell').listeners.click();
  assert.equal(game.getState().credits, 142);
  assert.equal(game.getState().towers[4], null);
  assert.equal(game.element('tower-actions').hidden, true);
});

test('insufficient funds and combat prevent construction and upgrades', () => {
  const game = createGame(); game.prepare(); game.choose('cannon');
  game.selectPad(0); game.selectPad(1); game.selectPad(2);
  assert.equal(game.getState().credits, 0);
  assert.equal(game.getState().towers[2], null);
  game.launchWave(); game.getState().credits = 500; game.selectPad(2);
  game.selectPad(0); game.element('upgrade').listeners.click(); game.element('sell').listeners.click();
  game.element('pilot-upgrade').listeners.click();
  assert.equal(game.getState().towers[2], null);
  assert.equal(game.getState().towers[0].level, 1);
  assert.equal(game.getState().pilot.level, 1);
  assert.equal(game.getState().credits, 500);
});

test('pause freezes movement, projectiles, and spawning', () => {
  const game = createGame(); game.prepare(); game.launchWave(); game.update(1 / 60);
  game.togglePause(); const before = JSON.stringify(game.getState());
  for (let i = 0; i < 100; i++) game.update(1 / 60);
  assert.equal(JSON.stringify(game.getState()), before);
  game.togglePause(); game.update(1 / 60);
  assert.notEqual(JSON.stringify(game.getState()), before);
});

test('movement stays in the defender lane and manual fire requires Space', () => {
  const game = createGame(); game.prepare(); game.launchWave();
  game.element('auto-fire').checked = false;
  game.move(-100, 1000);
  for (let i = 0; i < 60; i++) game.update(1 / 60);
  assert.equal(game.getState().pilot.x, 103); assert.equal(game.getState().pilot.y, 593);
  assert.equal(game.getState().bullets.length, 0);
  game.keys.add('Space'); game.update(1 / 60);
  assert.equal(game.getState().bullets.length, 2);
});

test('frost slows enemies and cannon splash damages neighboring enemies', () => {
  const game = createGame(); game.prepare(); game.launchWave();
  const state = game.getState(); state.spawnQueue = [];
  game.spawn('tank'); game.spawn('tank');
  const [first, second] = state.enemies;
  first.x = first.originX = 230; second.x = second.originX = 245; first.y = second.y = 250;
  game.hit(first, 1, true);
  const y = first.y; game.update(1 / 60);
  assert.ok(first.y - y < first.speed / 60 * .6);
  state.bullets.push({ x: first.x, y: first.y, vx: 0, vy: 0, life: 1, damage: 34, splash: 54, radius: 5, color: '#ffcb78' });
  const hp1 = first.hp, hp2 = second.hp; game.update(1 / 60);
  assert.equal(first.hp, hp1 - 34); assert.equal(second.hp, hp2 - 34);
});

test('wave clear awards credits and capped repair; leaked enemies damage the base', () => {
  const game = createGame(); game.prepare(); game.launchWave();
  const state = game.getState(); state.spawnQueue = []; state.health = 98;
  game.spawn('drone'); state.enemies[0].y = 624; game.update(1 / 60);
  assert.equal(state.phase, 'build'); assert.equal(state.health, 95);
  assert.equal(state.credits, 228);
});

test('boss reaching the base ends the run and restart clears state', () => {
  const game = createGame(); game.prepare(); game.launchWave();
  game.getState().spawnQueue = []; game.spawn('boss'); game.getState().enemies[0].y = 624;
  game.update(1 / 60);
  assert.equal(game.getState().phase, 'lost'); assert.equal(game.getState().health, 0);
  game.reset(); assert.equal(game.getState().phase, 'ready'); assert.equal(game.getState().credits, 180);
  assert.equal(game.getState().enemies.length, 0); assert.equal(game.isPaused(), false);
});

test('a funded strategy can survive all ten waves using normal upgrade costs', () => {
  const game = createGame(); game.prepare();
  const state = game.getState(); const results = [];
  // Choose and purchase defenses through the same actions as the UI.
  const plan = [[4, 'pulse'], [5, 'pulse'], [2, 'frost'], [3, 'cannon'], [0, 'cannon'], [1, 'pulse']];
  for (let wave = 1; wave <= 10; wave++) {
    for (const [pad, type] of plan) {
      if (state.towers[pad]) continue;
      game.choose(type); game.selectPad(pad);
    }
    game.element('pilot-upgrade').listeners.click();
    for (const [pad] of plan) if (state.towers[pad]) {
      game.selectPad(pad); game.element('upgrade').listeners.click();
    }
    game.launchWave();
    for (let tick = 0; tick < 60 * 150 && state.phase === 'combat'; tick++) {
      const threat = state.enemies.filter(e => e.hp > 0).sort((a, b) => b.y - a.y)[0];
      game.move(threat ? threat.x : 240, 590);
      game.update(1 / 60);
    }
    results.push({ wave, health: state.health, phase: state.phase, credits: state.credits });
    assert.equal(state.phase, wave === 10 ? 'won' : 'build', JSON.stringify(results));
    assert.ok(state.credits >= 0);
  }
  assert.ok(state.score > 0); assert.ok(state.kills > 0);
});
