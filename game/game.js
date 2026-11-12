(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const canvas = $('field'), ctx = canvas.getContext('2d');
  const W = 480, H = 680, MAX_ALIVE = 40, THREAT_RATE = 30, BOSS_EVERY = 4;
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const upgrades = {
    damage: { name: 'Overcharged rounds', icon: '✦', max: 5, description: '+25% blaster damage per rank.' },
    multishot: { name: 'Parallel barrels', icon: '⋔', max: 2, description: 'Add one parallel bullet to every burst. Upgrade from 1 to 3 bullets fired together.' },
    burst: { name: 'Burst repeat', icon: '✣', max: 2, description: 'Add one burst per firing cycle. Upgrade from 1 to 3 bursts per second.' },
    pierce: { name: 'Phase rounds', icon: '➶', max: 3, description: 'Each shot passes through one more enemy.' },
    blast: { name: 'Volatile rounds', icon: '◈', max: 3, description: 'Shots explode on impact. Each rank increases the blast radius.' },
    frost: { name: 'Cryo rounds', icon: '❄', max: 3, description: 'Shots slow enemies. Each rank makes the chill stronger and longer.' },
    aura: { name: 'Plasma pulse', icon: '◎', max: 4, description: 'A pulse damages nearby enemies every 2 seconds. Ranks increase damage and reach.' },
    armor: { name: 'Reactive armor', icon: '⬡', max: 5, description: 'Block 10% of incoming damage per rank.' },
    speed: { name: 'Afterburner', icon: '»', max: 4, description: '+12% movement speed per rank.' },
    repair: { name: 'Emergency repair', icon: '+', max: Infinity, description: 'Restore 25 base integrity immediately, up to 100.' },
    nova: { name: 'Nova pulse', icon: '◎', weapon: true, max: 3, description: 'A close-range pulse every 1.6 seconds. Ranks add damage and reach. Stacks with your blaster.' },
    orbit: { name: 'Orbital drone', icon: '⟳', weapon: true, max: 3, description: 'A drone circles your defender, damaging anything it touches. Ranks add damage and speed.' },
    cryo: { name: 'Cryo lance', icon: '✳', weapon: true, max: 3, description: 'Chills enemies to a standstill. Frozen enemies shatter on the next hit for damage scaled to health lost. Bosses only slow.' }
  };
  // The core weapon is chosen once per run and locked. It changes what every blaster
  // bullet does on contact, so the three classes are mutually exclusive rather than
  // stacking weapons. See fireVolley() and applyBulletHit().
  const WEAPON_CLASS_IDS = ['physical', 'poison', 'gravity'];
  const weaponClasses = {
    physical: { name: 'Kinetic blaster', icon: '✦', tag: 'PHYSICAL', description: 'Standard rounds. Every hit deals direct damage immediately.' },
    poison: { name: 'Venom blaster', icon: '☣', tag: 'POISON', description: 'Every bullet adds one poison stack. Stacks never expire and deal damage over time; the auto-aim spreads poison so enemies die just before the outpost.' },
    gravity: { name: 'Graviton rounds', icon: '◉', tag: 'GRAVITY', description: 'Rounds charge enemies with gravity. No direct damage: charged enemies pull each other together and crush on impact.' }
  };
  const keys = new Set();
  let state, paused = false, pointer = null, last = 0, elapsed = 0, bannerTimer;
  let soundEnabled = false, audioContext, best = 0;
  try { best = Number(localStorage.getItem('skyhold-survivor-best')) || 0; } catch { /* Storage is optional. */ }
  const SETTINGS_KEY = 'skyhold-survivor-settings';
  let autoFire = true;
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if (typeof saved.autoFire === 'boolean') autoFire = saved.autoFire;
    if (typeof saved.sound === 'boolean') soundEnabled = saved.sound;
  } catch { /* Settings are optional. */ }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ autoFire, sound: soundEnabled })); } catch { /* Play without persistence. */ }
  }
  const stars = Array.from({ length: 65 }, (_, i) => ({ x: (i * 137.7) % W, y: (i * 83.3) % H, size: i % 4 === 0 ? 1.6 : .8 }));
  const rank = id => state.build[id] || 0;
  const nextLevelXP = level => 18 + (level - 1) * 12;
  const weaponDamage = () => 40 * (1 + rank('damage') * .25);
  const fireInterval = () => 1;
  const shotPattern = () => ({ bursts: clamp(1 + rank('burst'), 1, 3), parallel: clamp(1 + rank('multishot'), 1, 3) });
  function enemySpeedFactor(enemy) { return enemy.slow > 0 ? chillFactor() : 1; }
  const moveSpeed = () => 270 * (1 + rank('speed') * .12);
  const spawnDelay = threat => Math.max(.3, 1.2 - threat * .06);

  function reset() {
    state = { phase: 'ready', classId: null, health: 100, score: 0, kills: 0, level: 1, xp: 0, build: {},
      enemies: [], bullets: [], particles: [], effects: [], spawnClock: .6,
      pilot: { id: 'blaster', x: 240, y: 545, cooldown: 0, pendingBursts: [], hitTimer: 0, angle: -Math.PI / 2, auraClock: 0 },
      runTime: 0, threat: 1, choices: [] };
    state.weapons = [state.pilot];
    paused = false; keys.clear(); pointer = null;
    clearTimeout(bannerTimer); $('banner').classList.remove('visible');
    $('auto-fire').checked = autoFire; closeUpgrade();
    overlay('ONE PILOT. ENDLESS POTENTIAL.', 'Choose your<br>core weapon.',
      'Your blaster aims and fires automatically. Pick the round type that defines this run — it is locked until you restart. Dodge, earn XP, and choose upgrades. Keep the base alive.',
      'Start surviving', 'AUTO AIM · LOCKED WEAPON CLASS · LEVEL-UP CHOICES');
    renderClassPicker(); showClassPicker();
    message('Pick a weapon class. It is locked for this run.');
    renderLoadout(); updateUI();
  }

  function overlay(kicker, title, text, action, note) {
    $('overlay-kicker').textContent = kicker; $('overlay-title').innerHTML = title;
    $('overlay-text').textContent = text; $('overlay-action').innerHTML = action + ' <span>→</span>';
    $('overlay-note').textContent = note; $('overlay').hidden = false;
  }
  function renderClassPicker() {
    const picker = $('class-picker'); picker.replaceChildren();
    for (const id of WEAPON_CLASS_IDS) {
      const data = weaponClasses[id], card = document.createElement('button');
      card.className = 'class-card'; card.dataset.classId = id; card.type = 'button';
      if (state.classId === id) card.classList.add('selected');
      const icon = document.createElement('span'); icon.className = 'class-icon'; icon.textContent = data.icon;
      const name = document.createElement('strong'); name.textContent = data.name;
      const tag = document.createElement('span'); tag.className = 'class-tag'; tag.textContent = data.tag;
      const description = document.createElement('span'); description.className = 'class-description'; description.textContent = data.description;
      card.append(icon, tag, name, description);
      card.addEventListener('click', () => chooseClass(id));
      picker.append(card);
    }
    picker.hidden = false;
  }
  function showClassPicker() { const picker = $('class-picker'); picker.hidden = false; $('overlay-action').hidden = true; }
  function hideClassPicker() { $('class-picker').hidden = true; $('overlay-action').hidden = false; }
  // Choosing a class is the real start of a run: it locks the bullet effect and begins combat.
  function chooseClass(id) {
    if (state.phase !== 'ready' || !WEAPON_CLASS_IDS.includes(id)) return;
    state.classId = id; hideClassPicker(); beginRun();
  }
  function message(text) { $('status').textContent = text; }
  function announce(text) {
    $('banner').textContent = text; $('banner').classList.add('visible');
    clearTimeout(bannerTimer); bannerTimer = setTimeout(() => $('banner').classList.remove('visible'), 1500);
  }
  function beginRun() {
    hideClassPicker();
    state.classId = state.classId || 'physical';
    $('overlay').hidden = true; state.phase = 'combat'; state.spawnClock = .6;
    announce('HOSTILES INBOUND');
    message(weaponClasses[state.classId].name + ' locked in. Defeat enemies to earn XP and evolve your build.');
    renderLoadout(); updateUI(); canvas.focus({ preventScroll: true });
  }
  function updateUI() {
    $('health').innerHTML = Math.ceil(state.health) + '<span>%</span>';
    $('health-bar').style.width = state.health + '%';
    $('health-bar').style.background = state.health <= 30 ? '#ff7984' : '#65e5dd';
    $('threat').innerHTML = '∞<span> THREAT ' + state.threat + '</span>';
    $('level').textContent = 'LV ' + state.level;
    $('xp-label').textContent = 'XP ' + state.xp + ' / ' + nextLevelXP(state.level);
    $('xp-bar').style.width = Math.min(100, state.xp / nextLevelXP(state.level) * 100) + '%';
    $('next-level').textContent = Math.max(0, nextLevelXP(state.level) - state.xp) + ' XP';
    $('kills').textContent = state.kills;
    $('hostiles').textContent = aliveCount() + ' ON FIELD';
    $('score').textContent = 'SCORE ' + state.score; $('best').textContent = best;
    $('phase').textContent = paused ? 'OPERATIONS PAUSED' : ({ ready: 'AWAITING PILOT', combat: 'SURVIVAL ACTIVE', upgrade: 'CHOOSE AN UPGRADE', lost: 'BASE LOST' })[state.phase];
    $('phase-tag').textContent = paused ? 'PAUSED' : ({ ready: 'READY', combat: 'LIVE', upgrade: 'LEVEL UP', lost: 'LOST' })[state.phase];
    $('pause').disabled = state.phase !== 'combat';
    $('pause').innerHTML = paused ? 'Resume <span>▷</span>' : 'Pause <span>Ⅱ</span>';
    // The class changes what a "hit" means, so the damage readout changes with it: poison
    // and gravity never deal direct damage, and showing a per-shot number would be a lie.
    $('damage-stat').textContent = state.classId === 'poison'
      ? poisonDpsPerStack().toFixed(1) + '/stack'
      : state.classId === 'gravity' ? gravitySelfDps().toFixed(0) + '/s' : weaponDamage().toFixed(0);
    const pattern = shotPattern();
    $('shot-stat').textContent = pattern.bursts + '×' + pattern.parallel;
    const bullets = pattern.bursts * pattern.parallel;
    $('shot-total').textContent = state.classId === 'poison'
      ? bullets + ' poison stack' + (bullets === 1 ? '' : 's') + ' per cycle · stacks scale the burn'
      : state.classId === 'gravity'
        ? bullets + ' gravity charge' + (bullets === 1 ? '' : 's') + ' per cycle · charged enemies magnetise'
        : bullets + ' bullet' + (bullets === 1 ? '' : 's') + ' per cycle · bursts × parallel bullets';
    $('rate-stat').textContent = '1 Hz';
    $('armor-stat').textContent = rank('armor') * 10 + '%';
    $('auto-fire').disabled = state.phase === 'upgrade';
    $('build-count').textContent = Object.values(state.build).reduce((sum, count) => sum + count, 0) + ' UPGRADES';
    $('weapon-count').textContent = state.weapons.length + (state.weapons.length === 1 ? ' WEAPON' : ' WEAPONS') + (state.classId ? ' · ' + weaponClasses[state.classId].tag : '');
  }
  function renderLoadout() {
    const loadout = $('loadout'); loadout.replaceChildren();
    // The locked core weapon leads the list so the run's identity is always visible.
    const coreId = state.classId;
    if (coreId) {
      const core = weaponClasses[coreId], row = document.createElement('div'); row.className = 'loadout-item core';
      const icon = document.createElement('span'); icon.className = 'loadout-icon'; icon.textContent = core.icon;
      const name = document.createElement('strong'); name.textContent = core.name;
      const badge = document.createElement('span'); badge.className = 'loadout-rank'; badge.textContent = 'LOCKED · ' + core.tag;
      row.append(icon, name, badge); loadout.append(row);
    }
    const owned = Object.entries(state.build).filter(([, count]) => count > 0);
    if (!owned.length) {
      if (coreId) return;
      const empty = document.createElement('p'); empty.className = 'empty-build';
      empty.textContent = 'Pick a weapon class to lock in. Then add weapons and passives from level-up choices — they all fire together. Your upgrades will appear here.'; loadout.append(empty); return;
    }
    for (const [id, count] of owned) {
      const row = document.createElement('div'); row.className = 'loadout-item';
      const icon = document.createElement('span'); icon.className = 'loadout-icon'; icon.textContent = upgrades[id].icon;
      const name = document.createElement('strong'); name.textContent = upgrades[id].name;
      const badge = document.createElement('span'); badge.className = 'loadout-rank';
      badge.textContent = id === 'repair' ? count + ' USED'
        : (upgrades[id].weapon ? 'WEAPON · RANK ' : 'RANK ') + count + ' / ' + upgrades[id].max;
      row.append(icon, name, badge); loadout.append(row);
    }
  }

  function gainXP(amount) { state.xp += amount; }
  function shuffle(list) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }
  // Shifted pools were tried and measured, then rejected. Reserving a weapon slot and
  // weighting weapons both hurt survival (~44/100 fell to ~29/100 and ~26/100 across two
  // seed families) because they take cards away from damage and defence, while a plain
  // pool already offers every weapon by level 3-5 in ~95% of runs. Keep it uniform.
  function pickChoices() {
    const available = id => rank(id) < upgrades[id].max && (id !== 'repair' || state.health < 100);
    const choices = shuffle(Object.keys(upgrades).filter(available)).slice(0, 3);
    // A fully capped build with a healthy base still offers restoration.
    if (!choices.length) choices.push('repair');
    return choices;
  }
  function requestUpgrade() {
    if (paused || state.phase !== 'combat' || state.xp < nextLevelXP(state.level)) return false;
    state.xp -= nextLevelXP(state.level); state.level++; state.phase = 'upgrade';
    keys.clear(); pointer = null;
    state.choices = pickChoices();
    $('upgrade-kicker').textContent = 'LEVEL ' + state.level + ' UNLOCKED';
    const container = $('upgrade-choices'); container.replaceChildren();
    state.choices.forEach((id, index) => {
      const data = upgrades[id], card = document.createElement('button'); card.className = 'upgrade-card'; card.dataset.upgrade = id;
      const icon = document.createElement('span'); icon.className = 'upgrade-icon'; icon.textContent = data.icon;
      const badge = document.createElement('span'); badge.className = 'upgrade-rank';
      badge.textContent = id === 'repair' ? 'INSTANT RECOVERY'
        : (data.weapon ? 'WEAPON · RANK ' : 'RANK ') + (rank(id) + 1) + ' / ' + data.max;
      const name = document.createElement('strong'); name.textContent = data.name;
      const description = document.createElement('span'); description.className = 'upgrade-description'; description.textContent = data.description;
      const pick = document.createElement('span'); pick.className = 'upgrade-pick'; pick.textContent = '[' + (index + 1) + '] SELECT UPGRADE →';
      card.append(icon, badge, name, description, pick); card.addEventListener('click', () => chooseUpgrade(id)); container.append(card);
    });
    $('upgrade-modal').hidden = false; document.body.classList.add('choosing-upgrade');
    message('Level ' + state.level + '! Choose one upgrade to continue.'); updateUI();
    container.children[0]?.focus({ preventScroll: true });
    tone(880, .16);
    return true;
  }
  function closeUpgrade() { $('upgrade-modal').hidden = true; document.body.classList.remove('choosing-upgrade'); }
  function chooseUpgrade(id) {
    if (state.phase !== 'upgrade' || !state.choices.includes(id)) return;
    state.build[id] = rank(id) + 1;
    if (id === 'repair') state.health = Math.min(100, state.health + 25);
    syncWeapons();
    state.choices = []; state.phase = 'combat'; closeUpgrade(); renderLoadout();
    message(upgrades[id].name + ' acquired. Keep moving and let your weapons work.'); updateUI();
    // Overflow XP can earn several levels. Each level still requires its own choice.
    if (!requestUpgrade()) canvas.focus({ preventScroll: true });
  }

  function threatFor(runTime) { return 1 + Math.floor(runTime / THREAT_RATE); }
  function spawnType(threat) {
    const roll = Math.random();
    if (threat >= 3 && roll < Math.min(.22, .08 + (threat - 3) * .02)) return 'tank';
    if (threat >= 2 && roll < Math.min(.55, .32 + (threat - 2) * .04)) return 'runner';
    return 'drone';
  }
  function aliveCount() {
    let alive = 0;
    for (const enemy of state.enemies) if (enemy.hp > 0) alive++;
    return alive;
  }
  function spawnOne() {
    state.spawnClock = spawnDelay(state.threat);
    if (aliveCount() >= MAX_ALIVE) return;
    spawn(spawnType(state.threat));
  }
  function spawn(type) {
    const scale = 1 + (state.threat - 1) * .22;
    const data = {
      drone: { hp: 46 * scale, speed: 31 + state.threat * 2.2, radius: 13, xp: 5, damage: 10, color: '#ef829b' },
      runner: { hp: 30 * scale, speed: 56 + state.threat * 3.1, radius: 10, xp: 6, damage: 8, color: '#ffbd78' },
      tank: { hp: 170 * scale, speed: 22 + state.threat * 1.1, radius: 19, xp: 12, damage: 20, color: '#b59dff' },
      boss: { hp: 3200 * scale, speed: 16, radius: 40, xp: 80, damage: 100, color: '#ff687e' }
    }[type];
    const x = type === 'boss' ? 240 : 85 + Math.random() * 310;
    // status fields: chill/frozen drive Cryo, poison drives the stacking DoT, charge/chargeTimer
    // drive the gravity class's magnet pull, driftX/driftY carry external forces because x
    // is recomputed from originX each frame.
    state.enemies.push({ ...data, type, maxHp: data.hp, x, originX: x, y: -50, time: 0, slow: 0, flash: 0, attackClock: 2,
      chill: 0, frozen: false, poison: 0, charge: 0, chargeTimer: 0, driftX: 0, driftY: 0, impactClock: 0 });
  }
  function aimTarget() {
    return state.enemies.reduce((nearest, enemy) => enemy.hp > 0 && enemy.y >= 0 && enemy.y < 623 &&
      (!nearest || distance(state.pilot, enemy) < distance(state.pilot, nearest)) ? enemy : nearest, null);
  }
  const BASE_LINE = 623;
  function advanceSpeed(enemy) {
    return enemy.speed * enemySpeedFactor(enemy) * chillSpeedFactor(enemy);
  }
  // Poison does not want the nearest enemy: it wants the enemy that will otherwise reach
  // the outpost. Risk is time-to-die minus time-to-reach. Positive means poison still has
  // work to do; once poison is on pace to kill before arrival the score goes negative and
  // the aim moves on. That is what spreads stacks across the field instead of stacking one
  // enemy into absurdity while its neighbours walk through unopposed.
  function poisonRisk(enemy) {
    const reach = Math.max(0, BASE_LINE - enemy.y) / Math.max(1, advanceSpeed(enemy));
    const dps = poisonDps(enemy);
    // Capped rather than Infinity so risk stays comparable and tie-breaks work. Any enemy
    // with no poison on it is maximally urgent: it will never die on its own.
    const die = dps > 0 ? Math.min(enemy.hp / dps, RISK_CAP) : RISK_CAP;
    return { risk: die - reach, reach, die };
  }
  function poisonAimTarget() {
    let best = null, bestPick = null;
    for (const enemy of state.enemies) {
      if (enemy.hp <= 0 || enemy.y < 0 || enemy.y >= BASE_LINE) continue;
      const pick = poisonRisk(enemy);
      // Highest risk wins; ties break toward the enemy closest to the outpost, then toward
      // the one with the fewest stacks so freshly spawned hostiles get seeded early.
      if (!bestPick || pick.risk > bestPick.risk + 1e-6
        || (Math.abs(pick.risk - bestPick.risk) <= 1e-6 && (pick.reach < bestPick.reach - 1e-6
          || (Math.abs(pick.reach - bestPick.reach) <= 1e-6 && poisonStacks(enemy) < poisonStacks(best))))) {
        best = enemy; bestPick = pick;
      }
    }
    return best;
  }
  // The blaster's aim is class-aware: physical and gravity want the nearest threat, poison
  // wants whoever is about to leak through. Everything else (reticle, burst retargeting)
  // follows this so the on-screen marker always matches where the next bullet will go.
  function blasterTarget() {
    return state.classId === 'poison' ? poisonAimTarget() : aimTarget();
  }
  const WEAPON_IDS = ['nova', 'orbit', 'cryo'];
  const novaRadius = () => 64 + rank('nova') * 22;
  const orbitRadius = () => 54 + rank('orbit') * 8;
  const cryoRadius = () => 90 + rank('cryo') * 25;
  const CHILL_DECAY = .35, CHILL_PER_TICK = .55, BOSS_CHILL_CAP = .6, FREEZE_BREAK_DELAY = .9;
  // Poison has no expiry, so the cap is what keeps a single target from absorbing infinite
  // damage. 40 stacks is enough that a boss hit by sustained fire keeps ramping for a while.
  const POISON_MAX_STACKS = 40, POISON_LETHAL_MARGIN = 90, POISON_SAFE_MARGIN = 260;
  // Sentinel time-to-die for an enemy that carries no poison yet. Large but finite so it
  // compares cleanly against real estimates and never wins a tie-break by being NaN.
  const RISK_CAP = 999;
  // driftX is a positional offset, not a velocity, and it decays 6% per frame. The pull is
  // therefore tuned as an equilibrium offset: a fully charged enemy drags a neighbour in
  // over roughly a second instead of teleporting it.
  const GRAVITY_MAX = 6, GRAVITY_LIFE = 3, GRAVITY_PULL = 150, GRAVITY_RANGE = 240;
  const freezeThreshold = enemy => enemy.type === 'boss' ? Infinity : 1;
  function applyChill(enemy, amount) {
    const cap = enemy.type === 'boss' ? BOSS_CHILL_CAP : 1;
    const wasFrozen = enemy.frozen;
    enemy.chill = Math.min(cap, (enemy.chill || 0) + amount);
    enemy.frozen = enemy.chill >= 1 && freezeThreshold(enemy) <= 1;
    // Arm the break the moment the enemy freezes. Without this the field clogs with
    // statues that a 1 Hz blaster can never clear fast enough.
    if (enemy.frozen && !wasFrozen) enemy.freezeTimer = FREEZE_BREAK_DELAY;
  }
  // Frozen enemies break on their own after a short hold, and immediately on any hit.
  function shatter(enemy) {
    if (!enemy.frozen) return 0;
    const bonus = 40 + (enemy.maxHp - enemy.hp) * .35;
    enemy.frozen = false; enemy.chill = 0; enemy.freezeTimer = 0;
    burst(enemy.x, enemy.y, '#a6ceff', 20); tone(880, .08, 'triangle', .02);
    state.score += 30;
    return bonus;
  }
  // Chill multiplies movement; a frozen enemy stops entirely. Kept separate from the
  // frost passive's slow so the two stack multiplicatively rather than overwrite.
  function chillSpeedFactor(enemy) {
    if (!enemy.chill) return 1;
    return Math.max(0, 1 - enemy.chill);
  }
  function applyPoison(enemy, stacks) {
    // Poison never expires: every bullet is a permanent investment. The cap only stops a
    // single enemy from becoming an infinite damage sink.
    enemy.poison = Math.min(POISON_MAX_STACKS, (enemy.poison || 0) + stacks);
  }
  // Poison is a pure damage-over-time class: no direct damage at all. Damage per second is
  // linear in stacks, so every bullet makes the next second hurt more — which is what makes
  // it ramp satisfyingly on a boss that survives long enough to accumulate stacks. The
  // per-stack value is deliberately much larger than a physical round's fraction: at 1 Hz
  // a lone bullet must still be worth its slot. Tuned to parity with physical over a
  // 50-run, two-family headless sweep (see the balance test).
  const poisonDpsPerStack = () => weaponDamage() * .15;
  const poisonStacks = enemy => enemy.poison || 0;
  const poisonDps = enemy => poisonStacks(enemy) * poisonDpsPerStack();
  // Gravity pays no direct damage at all; the damage is the crush. A lone charged enemy
  // still buckles under its own gravity, so it dies without a partner.
  const gravityImpact = () => weaponDamage() * 1.4;
  const gravityCrush = () => weaponDamage() * .9;
  const gravitySelfDps = () => weaponDamage() * 3.1;
  const GRAVITY_STACKS_PER_HIT = 2;

  function applyGravity(enemy, charges) {
    enemy.charge = Math.min(GRAVITY_MAX, (enemy.charge || 0) + charges);
    enemy.chargeTimer = GRAVITY_LIFE;
  }
  // Bullets carry the run's locked class rather than being a plain physical hit. Every
  // class still applies frost slow on impact; only physical deals direct damage.
  function applyBulletHit(enemy, bullet) {
    if (bullet.slow) enemy.slow = 1.3 + rank('frost') * .35;
    if (state.classId === 'poison') { applyPoison(enemy, bullet.stacks || 1); enemy.flash = Math.max(enemy.flash, .05); }
    else if (state.classId === 'gravity') { applyGravity(enemy, GRAVITY_STACKS_PER_HIT); enemy.flash = Math.max(enemy.flash, .05); }
    else hit(enemy, bullet.damage, bullet.slow);
  }
  // Weapons are data plus a `fire` function, each driven by its own cooldown in update().
  // `state.pilot` doubles as the blaster's instance so movement and its firing state live
  // together; any additional weapon gets its own instance in `state.weapons`.
  const weapons = {
    blaster: {
      name: 'Blaster', icon: '✦',
      fire(weapon, target) {
        const pattern = shotPattern();
        if (weapon.cooldown > 1e-9 || weapon.pendingBursts.length) return;
        // Simulation delays freeze with pause and level-up choices; the cycle finishes within one second.
        for (let burstIndex = 0; burstIndex < pattern.bursts; burstIndex++) {
          const delay = burstIndex * .20;
          if (delay === 0) fireVolley(target, pattern.parallel);
          else weapon.pendingBursts.push({ delay, parallel: pattern.parallel });
        }
        weapon.cooldown = fireInterval();
      }
    },
    nova: {
      name: 'Nova pulse', icon: '◎',
      fire(weapon) {
        if (weapon.cooldown > 1e-9) return;
        const pilot = state.pilot, radius = novaRadius(), damage = 18 + rank('nova') * 10;
        // Damage routes through hit() so kills, score, XP, and the death guard stay consistent.
        for (const enemy of state.enemies) {
          if (enemy.hp > 0 && enemy.y >= 0 && distance(pilot, enemy) < radius + enemy.radius) hit(enemy, damage, false);
        }
        state.effects.push({ x: pilot.x, y: pilot.y, radius, life: .4, nova: true });
        weapon.cooldown = 1.6; tone(430, .07, 'triangle', .012);
      }
    },
    orbit: {
      name: 'Orbital drone', icon: '⟳',
      fire(weapon) {
        if (weapon.cooldown > 1e-9) return;
        const pilot = state.pilot, damage = 8 + rank('orbit') * 6;
        const drone = { x: pilot.x + Math.cos(weapon.phase) * orbitRadius(), y: pilot.y + Math.sin(weapon.phase) * orbitRadius() };
        for (const enemy of state.enemies) {
          if (enemy.hp > 0 && distance(drone, enemy) < 14 + enemy.radius) hit(enemy, damage, false);
        }
        weapon.cooldown = .25; tone(560, .03, 'square', .005);
      }
    },
    cryo: {
      name: 'Cryo lance', icon: '❆',
      fire(weapon) {
        if (weapon.cooldown > 1e-9) return;
        const pilot = state.pilot, radius = cryoRadius();
        // Contact applies chill only. Cryo never deals damage; the shatter inside hit()
        // is what converts accumulated freeze into a kill.
        for (const enemy of state.enemies) {
          if (enemy.hp > 0 && enemy.y >= 0 && distance(pilot, enemy) < radius + enemy.radius) {
            applyChill(enemy, CHILL_PER_TICK);
            enemy.flash = Math.max(enemy.flash, .05);
          }
        }
        state.effects.push({ x: pilot.x, y: pilot.y, radius, life: .4, cryo: true });
        weapon.cooldown = 1.2; tone(720, .05, 'sine', .008);
      }
    }
  };
  // Instances are created only for owned weapon upgrades, and removed when a run resets.
  function syncWeapons() {
    for (const id of WEAPON_IDS) {
      const owned = rank(id) > 0, existing = state.weapons.find(entry => entry.id === id);
      if (owned && !existing) state.weapons.push({ id, cooldown: 0, pendingBursts: [], phase: 0 });
      else if (!owned && existing) state.weapons = state.weapons.filter(entry => entry.id !== id);
    }
  }
  function firePilot(target) {
    const weapon = state.weapons.find(entry => entry.id === 'blaster');
    if (weapon) weapons.blaster.fire(weapon, target);
  }
  function fireVolley(target, parallel) {
    const pilot = state.pilot, flightTime = distance(pilot, target) / 560;
    const predicted = { x: target.x, y: target.y + target.speed * enemySpeedFactor(target) * flightTime };
    const angle = Math.atan2(predicted.y - pilot.y, predicted.x - pilot.x);
    pilot.angle = angle;
    const classId = state.classId || 'physical';
    // Physical rounds stay cyan; poison reads acid green, gravity violet. Frost overrides.
    const tint = classId === 'poison' ? '#a9e08a' : classId === 'gravity' ? '#c3a9ff' : '#9cfff1';
    for (let barrel = 0; barrel < parallel; barrel++) {
      const offset = (barrel - (parallel - 1) / 2) * 8;
      state.bullets.push({ x: pilot.x + Math.cos(angle) * 18 - Math.sin(angle) * offset,
        y: pilot.y + Math.sin(angle) * 18 + Math.cos(angle) * offset,
        vx: Math.cos(angle) * 560, vy: Math.sin(angle) * 560,
        damage: weaponDamage(), splash: rank('blast') ? 28 + rank('blast') * 12 : 0,
        // Exactly one poison stack per bullet: multishot and burst multiply stacks, which is
        // how the poison class scales without ever dealing direct damage.
        stacks: 1,
        slow: rank('frost') > 0, pierce: rank('pierce'), hitEnemies: new Set(), classId,
        color: rank('frost') ? '#a6baff' : tint, radius: rank('blast') ? 4 : 3, life: 2, enemy: false });
    }
    tone(650, .025, 'triangle', .009);
  }
  function burst(x, y, color, count = 10) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, speed = 25 + Math.random() * 100;
      state.particles.push({ x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, life: .3 + Math.random() * .35, color });
    }
  }
  const chillFactor = () => Math.max(.4, .72 - rank('frost') * .07);
  // Single death path. Everything that can kill routes through here so score, kills, XP,
  // particles, and the popup effect stay consistent no matter the damage source.
  function killEnemy(enemy) {
    state.score += enemy.xp * 20; state.kills++; gainXP(enemy.xp);
    burst(enemy.x, enemy.y, enemy.color, enemy.type === 'boss' ? 50 : 12);
    state.effects.push({ x: enemy.x, y: enemy.y, life: .8, xp: enemy.xp });
    tone(150, .06, 'triangle', .025); updateUI();
  }
  function hit(enemy, damage, slow) {
    if (enemy.hp <= 0) return;
    // A frozen enemy shatters on the next damage of any source, and also breaks on its
    // own timer in update(). Shatter scales with health already removed.
    if (enemy.frozen) damage += shatter(enemy);
    enemy.hp -= damage; enemy.flash = .09;
    if (slow) enemy.slow = 1.3 + rank('frost') * .35;
    if (enemy.hp <= 0) killEnemy(enemy);
  }
  // Damage over time bypasses flash and slow so per-frame ticks do not strobe enemies or
  // repeatedly re-arm chill/slow state. Death still routes through killEnemy.
  function damageOverTime(enemy, damage) {
    if (enemy.hp <= 0 || damage <= 0) return;
    enemy.hp -= damage;
    if (enemy.hp <= 0) killEnemy(enemy);
  }
  function damageBase(amount, breach = false) {
    state.health = Math.max(0, state.health - amount * (breach ? 1 : 1 - rank('armor') * .1));
    burst(240, 636, '#ff687e', 15); tone(70, .16, 'sawtooth', .04); updateUI();
    if (state.health <= 0) finish();
  }
  function saveBest() {
    best = Math.max(best, state.score);
    try { localStorage.setItem('skyhold-survivor-best', String(best)); } catch { /* Play without persistence. */ }
  }
  function finish() {
    if (state.phase === 'lost') return;
    state.phase = 'lost'; paused = false; keys.clear(); pointer = null; closeUpgrade();
    for (const weapon of state.weapons) weapon.pendingBursts = [];
    saveBest(); updateUI();
    message('The base has fallen. Try a new upgrade combination.');
    overlay('SIGNAL LOST', 'One more<br>evolution.',
      'Held for ' + formatTime(state.runTime) + ' at threat ' + state.threat + ' and level ' + state.level + '. ' + state.kills + ' hostiles defeated. Score: ' + state.score + '.',
      'Play again', 'PERSONAL BEST ' + best.toLocaleString());
  }
  function formatTime(seconds) {
    const total = Math.floor(seconds);
    return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
  }

  function update(dt) {
    if (paused || state.phase !== 'combat') return;
    const pilot = state.pilot;
    const mx = (keys.has('ArrowRight') || keys.has('KeyD') ? 1 : 0) - (keys.has('ArrowLeft') || keys.has('KeyA') ? 1 : 0);
    const my = (keys.has('ArrowDown') || keys.has('KeyS') ? 1 : 0) - (keys.has('ArrowUp') || keys.has('KeyW') ? 1 : 0);
    const magnitude = Math.hypot(mx, my) || 1;
    pilot.x = clamp(pilot.x + mx / magnitude * moveSpeed() * dt, 30, 450);
    pilot.y = clamp(pilot.y + my / magnitude * moveSpeed() * dt, 85, 593);
    if (pointer) {
      const dx = pointer.x - pilot.x, dy = pointer.y - pilot.y;
      const step = Math.min(1, moveSpeed() * dt / Math.max(1, Math.hypot(dx, dy)));
      pilot.x = clamp(pilot.x + dx * step, 30, 450); pilot.y = clamp(pilot.y + dy * step, 85, 593);
    }
    pilot.hitTimer = Math.max(0, pilot.hitTimer - dt);
    state.particles.forEach(p => { p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt; });
    state.particles = state.particles.filter(p => p.life > 0);
    state.effects.forEach(e => { e.life -= dt; }); state.effects = state.effects.filter(e => e.life > 0);
    state.runTime += dt;
    const threat = threatFor(state.runTime);
    if (threat > state.threat) {
      state.threat = threat; announce('THREAT ' + threat);
      if (threat % BOSS_EVERY === 0) { spawn('boss'); message('A siege carrier has entered the field. Protect the base.'); }
      updateUI();
    }
    state.spawnClock -= dt;
    if (state.spawnClock <= 0) spawnOne();
    // Ticking order is load-bearing: cooldown decrement precedes the fire gate, and the
    // burst queue decrements before it drains. Weapon ticks must stay ahead of the
    // bullet-integration loop below so new bullets advance on their birth frame.
    for (const weapon of state.weapons) {
      weapon.cooldown = Math.max(0, weapon.cooldown - dt);
      weapon.pendingBursts.forEach(volley => { volley.delay -= dt; });
      while (weapon.pendingBursts.length && weapon.pendingBursts[0].delay <= 1e-9) {
        const volley = weapon.pendingBursts.shift(), burstTarget = blasterTarget();
        if (burstTarget) fireVolley(burstTarget, volley.parallel);
      }
      if (weapon.id === 'blaster') continue;
      // Non-aiming weapons run their own clock independently of the blaster.
      if (weapon.id === 'orbit') weapon.phase = (weapon.phase || 0) + dt * (2.2 + rank('orbit') * .5);
      const autoFireOn = $('auto-fire').checked || keys.has('Space');
      if (autoFireOn) weapons[weapon.id].fire(weapon);
    }
    const target = blasterTarget();
    if (target) {
      pilot.angle = Math.atan2(target.y - pilot.y, target.x - pilot.x);
      if (($('auto-fire').checked || keys.has('Space')) && pilot.cooldown <= 1e-9) {
        firePilot(target);
      }
    }
    if (rank('aura')) {
      pilot.auraClock -= dt;
      if (pilot.auraClock <= 0) {
        const radius = 70 + rank('aura') * 25;
        for (const e of state.enemies) if (e.hp > 0 && e.y >= 0 && distance(pilot, e) < radius + e.radius) hit(e, 12 + rank('aura') * 12, false);
        state.effects.push({ x: pilot.x, y: pilot.y, radius, life: .4 }); pilot.auraClock = 2;
      }
    }
    // Gravity class: charged enemies behave like magnets. Every charged enemy pulls
    // nearby enemies toward itself, so a well-aimed burst turns a cluster into a pile.
    // Horizontal force is still a drift offset because x is rebuilt from originX.
    if (state.classId === 'gravity') {
      for (const puller of state.enemies) {
        if (puller.hp <= 0 || !(puller.charge > 0)) continue;
        const force = GRAVITY_PULL * (puller.charge / GRAVITY_MAX);
        for (const target of state.enemies) {
          if (target === puller || target.hp <= 0) continue;
          const dx = puller.x - target.x, dy = puller.y - target.y, span = Math.hypot(dx, dy);
          if (span > GRAVITY_RANGE || span < 1e-6) continue;
          // Falloff keeps far enemies drifting in gently instead of snapping together.
          const scale = force * (1 - span / GRAVITY_RANGE) * dt;
          target.driftX += dx / span * scale;
          target.driftY += dy / span * scale * .6;
        }
      }
    }
    for (const enemy of state.enemies) {
      if (enemy.hp <= 0) continue;
      enemy.impactClock = Math.max(0, (enemy.impactClock || 0) - dt);
      // A frozen enemy breaks on its own after a short hold so the field cannot clog with
      // statues. It still shatters instantly if anything damages it first.
      if (enemy.frozen) {
        enemy.freezeTimer = Math.max(0, (enemy.freezeTimer || 0) - dt);
        if (enemy.freezeTimer <= 0) damageOverTime(enemy, shatter(enemy));
      }
      // Once frozen, chill no longer decays: a statue stays frozen until it is shattered.
      else if (enemy.chill > 0) enemy.chill = Math.max(0, enemy.chill - CHILL_DECAY * dt);
      if (enemy.chill < 1) enemy.frozen = false;
      if (enemy.poison > 0) damageOverTime(enemy, poisonDps(enemy) * dt);
      if (enemy.charge > 0) {
        // Self-buckle plus the pull strength, so charge matters even for a lone target.
        damageOverTime(enemy, gravitySelfDps() * (enemy.charge / GRAVITY_MAX) * dt);
        enemy.chargeTimer -= dt;
        if (enemy.chargeTimer <= 0) { enemy.charge = 0; enemy.chargeTimer = 0; }
      }
    }
    // Collision damage needs at least one charged participant: a magnet crushes whatever
    // it drags into itself. Two uncharged enemies overlapping (they spawn near each other)
    // must stay harmless.
    for (let i = 0; i < state.enemies.length; i++) {
      const a = state.enemies[i];
      if (a.hp <= 0) continue;
      for (let j = i + 1; j < state.enemies.length; j++) {
        const b = state.enemies[j];
        if (b.hp <= 0) continue;
        const strength = Math.max(a.charge || 0, b.charge || 0);
        if (strength <= 0) continue;
        const span = distance(a, b), overlap = a.radius + b.radius;
        if (span > overlap) continue;
        // Crush and impact scale with charge: a fully charged pair melts a pile.
        const scale = strength / GRAVITY_MAX;
        damageOverTime(a, gravityCrush() * scale * dt); damageOverTime(b, gravityCrush() * scale * dt);
        if (span < overlap * .7 && a.impactClock <= 0 && b.impactClock <= 0) {
          const impact = gravityImpact() * scale;
          hit(a, impact, false); hit(b, impact, false);
          a.impactClock = .5; b.impactClock = .5;
          state.particles.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, vx: 0, vy: 0, life: .25, color: '#c3a9ff' });
        }
      }
    }
    for (const enemy of state.enemies) {
      if (enemy.hp <= 0) continue;
      // Frozen enemies stop advancing and stop swaying entirely — a statue mid-field.
      // Their sway phase is held so they resume from the same offset when thawed.
      const frozen = enemy.frozen && enemy.chill >= 1;
      if (!frozen) enemy.time += dt;
      enemy.slow = Math.max(0, enemy.slow - dt); enemy.flash = Math.max(0, enemy.flash - dt);
      if (!frozen) enemy.y += enemy.speed * enemySpeedFactor(enemy) * chillSpeedFactor(enemy) * dt;
      enemy.x = enemy.originX + Math.sin(enemy.time * (enemy.type === 'runner' ? 2 : .8)) * (enemy.type === 'boss' ? 45 : 16) + (enemy.driftX || 0);
      enemy.y += (enemy.driftY || 0) * dt;
      enemy.driftX = (enemy.driftX || 0) * .94;
      enemy.driftY = (enemy.driftY || 0) * .94;
      if (enemy.type === 'boss' && enemy.y > 0) {
        enemy.attackClock -= dt;
        if (enemy.attackClock <= 0) {
          const angle = Math.atan2(pilot.y - enemy.y, pilot.x - enemy.x);
          for (const spread of [-.24, 0, .24]) state.bullets.push({ x: enemy.x, y: enemy.y + 25, vx: Math.cos(angle + spread) * 145,
            vy: Math.sin(angle + spread) * 145, enemy: true, radius: 6, color: '#ff687e', life: 6, damage: 5 });
          enemy.attackClock = 2.3;
        }
      }
      if (distance(enemy, pilot) < enemy.radius + 15 && pilot.hitTimer <= 0) {
        pilot.hitTimer = 1; damageBase(5);
        if (state.phase !== 'combat') return;
        hit(enemy, 30, false); burst(pilot.x, pilot.y, '#65e5dd', 12);
      }
      if (enemy.hp > 0 && enemy.y > 623) { enemy.hp = 0; damageBase(enemy.damage, enemy.type === 'boss'); if (state.phase !== 'combat') return; }
    }
    for (const bullet of state.bullets) {
      bullet.x += bullet.vx * dt; bullet.y += bullet.vy * dt; bullet.life -= dt;
      if (bullet.enemy) {
        if (distance(bullet, pilot) < bullet.radius + 13 && pilot.hitTimer <= 0) {
          pilot.hitTimer = .6; bullet.life = 0; damageBase(bullet.damage); burst(pilot.x, pilot.y, '#ff687e');
          if (state.phase !== 'combat') return;
        }
        continue;
      }
      for (const enemy of state.enemies) {
        if (enemy.hp <= 0 || bullet.hitEnemies.has(enemy) || distance(bullet, enemy) >= enemy.radius + bullet.radius) continue;
        bullet.hitEnemies.add(enemy);
        if (bullet.splash) {
          burst(bullet.x, bullet.y, '#ffcb78', 12);
          for (const nearby of state.enemies) if (nearby.hp > 0 && distance(nearby, enemy) < bullet.splash + nearby.radius) applyBulletHit(nearby, bullet);
        } else { applyBulletHit(enemy, bullet); burst(bullet.x, bullet.y, bullet.color, 3); }
        if (bullet.pierce > 0) bullet.pierce--; else { bullet.life = 0; break; }
      }
    }
    state.bullets = state.bullets.filter(b => b.life > 0 && b.y > -60 && b.y < H + 40 && b.x > -30 && b.x < W + 30);
    state.enemies = state.enemies.filter(e => e.hp > 0);
    if (state.phase === 'combat') requestUpgrade();
  }

  function roundedRect(x, y, w, h, r, color) { ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill(); }
  function drawEnemy(enemy) {
    ctx.save(); ctx.translate(enemy.x, enemy.y);
    // Status tints are layered so the most dangerous state wins: frozen reads as ice,
    // then poisoned enemies glow acid green, charged ones violet, then the normal frost slow.
    ctx.fillStyle = enemy.flash > 0 ? '#fff'
      : enemy.chill >= 1 ? '#d8f3ff'
      : enemy.chill > 0 ? '#a6d4ff'
      : enemy.poison > 0 ? '#a9e08a'
      : enemy.charge > 0 ? '#c3a9ff'
      : enemy.slow > 0 ? '#a6ceff' : enemy.color;
    if (enemy.type === 'boss') {
      ctx.beginPath(); ctx.moveTo(0, 38); ctx.lineTo(-43, 11); ctx.lineTo(-36, -23); ctx.lineTo(-17, -34); ctx.lineTo(17, -34); ctx.lineTo(36, -23); ctx.lineTo(43, 11); ctx.closePath(); ctx.fill();
      roundedRect(-26, -16, 52, 30, 6, '#381f37'); roundedRect(-9, -8, 18, 20, 4, '#ff687e');
      ctx.fillStyle = '#ffba78'; ctx.fillRect(-35, 11, 9, 13); ctx.fillRect(26, 11, 9, 13);
    } else if (enemy.type === 'tank') {
      ctx.beginPath(); ctx.moveTo(-17, -16); ctx.lineTo(17, -16); ctx.lineTo(22, 7); ctx.lineTo(0, 23); ctx.lineTo(-22, 7); ctx.closePath(); ctx.fill();
      roundedRect(-10, -7, 20, 17, 3, '#292039'); roundedRect(-4, -2, 8, 8, 2, enemy.color);
    } else {
      const r = enemy.radius;
      ctx.beginPath(); ctx.moveTo(0, r + 4); ctx.lineTo(-r - 5, -r + 3); ctx.lineTo(-5, -r / 2); ctx.lineTo(0, -r); ctx.lineTo(5, -r / 2); ctx.lineTo(r + 5, -r + 3); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#30253b'; ctx.beginPath(); ctx.moveTo(0, r - 3); ctx.lineTo(-5, -4); ctx.lineTo(5, -4); ctx.closePath(); ctx.fill();
    }
    if (enemy.hp < enemy.maxHp || enemy.type === 'boss') {
      const width = enemy.type === 'boss' ? 78 : 30;
      ctx.fillStyle = '#060d1a'; ctx.fillRect(-width / 2, -enemy.radius - 12, width, 4);
      ctx.fillStyle = enemy.color; ctx.fillRect(-width / 2, -enemy.radius - 12, width * Math.max(0, enemy.hp / enemy.maxHp), 4);
    }
    // Frozen enemies get a crystalline outline so the shatter setup is readable at a glance.
    if (enemy.chill >= 1) {
      ctx.strokeStyle = '#e6faff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, enemy.radius + 5, 0, Math.PI * 2); ctx.stroke();
    }
    // Charged enemies show their pull strength as a violet halo, so the magnet is visible.
    if (enemy.charge > 0 && enemy.chill < 1) {
      ctx.strokeStyle = '#c3a9ff'; ctx.globalAlpha = .35 + (enemy.charge / GRAVITY_MAX) * .45; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(0, 0, enemy.radius + 6, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // Poison stacks read as tick marks around the rim plus the stack count, so the ramp is
    // legible: a boss with 30 stacks should look as dangerous to itself as it feels.
    if (enemy.poison > 0 && enemy.chill < 1) {
      const ratio = Math.min(1, enemy.poison / POISON_MAX_STACKS);
      ctx.strokeStyle = '#a9e08a'; ctx.globalAlpha = .3 + ratio * .6; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(0, 0, enemy.radius + 7, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ratio); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#c9f5ab'; ctx.font = 'bold 9px system-ui'; ctx.textAlign = 'center';
      ctx.fillText(String(enemy.poison), 0, -enemy.radius - 16);
    }
    ctx.restore();
  }
  function draw() {
    ctx.clearRect(0, 0, W, H);
    const gradient = ctx.createLinearGradient(0, 0, 0, H); gradient.addColorStop(0, '#17223a'); gradient.addColorStop(1, '#0b1a29');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#27375055'; ctx.lineWidth = 1;
    for (let y = -40 + (elapsed * 14) % 40; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    for (let x = 0; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (const star of stars) { ctx.fillStyle = '#9ab6d43a'; ctx.fillRect(star.x, (star.y + elapsed * 8) % H, star.size, star.size); }
    for (let y = 28; y < 600; y += 44) { ctx.fillStyle = '#65e5dd40'; ctx.fillRect(12, y, 3, 12); ctx.fillRect(465, y, 3, 12); }
    ctx.textAlign = 'center'; ctx.font = '9px system-ui'; ctx.fillStyle = '#93a6c066'; ctx.fillText('INCOMING HOSTILES', 240, 29);
    for (const enemy of state.enemies) drawEnemy(enemy);
    const target = blasterTarget();
    if (target && state.phase === 'combat') {
      ctx.strokeStyle = '#ffcb7880'; ctx.lineWidth = 1; ctx.setLineDash([4, 6]);
      ctx.beginPath(); ctx.arc(target.x, target.y, target.radius + 8, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    }
    for (const bullet of state.bullets) {
      ctx.fillStyle = bullet.color; ctx.shadowColor = bullet.color; ctx.shadowBlur = 7;
      ctx.beginPath(); ctx.ellipse(bullet.x, bullet.y, bullet.radius, bullet.enemy ? bullet.radius : 7, Math.atan2(bullet.vy, bullet.vx) + Math.PI / 2, 0, Math.PI * 2); ctx.fill();
    }
    ctx.shadowBlur = 0;
    const pilot = state.pilot;
    if (rank('armor')) { ctx.strokeStyle = '#65e5dd44'; ctx.beginPath(); ctx.arc(pilot.x, pilot.y, 28, 0, Math.PI * 2); ctx.stroke(); }
    ctx.save(); ctx.translate(pilot.x, pilot.y); ctx.rotate(pilot.angle + Math.PI / 2);
    if (pilot.hitTimer > 0 && Math.floor(elapsed * 14) % 2) ctx.globalAlpha = .45;
    ctx.fillStyle = '#65e5dd55'; ctx.beginPath(); ctx.moveTo(-6, 14); ctx.lineTo(0, 23 + Math.sin(elapsed * 35) * 4); ctx.lineTo(6, 14); ctx.fill();
    ctx.fillStyle = '#65e5dd'; ctx.beginPath(); ctx.moveTo(0, -24); ctx.lineTo(10, -3); ctx.lineTo(22, 15); ctx.lineTo(7, 12); ctx.lineTo(0, 17); ctx.lineTo(-7, 12); ctx.lineTo(-22, 15); ctx.lineTo(-10, -3); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#cafff7'; ctx.beginPath(); ctx.moveTo(0, -15); ctx.lineTo(5, 3); ctx.lineTo(-5, 3); ctx.closePath(); ctx.fill();
    const barrels = shotPattern().parallel;
    for (let barrel = 0; barrel < barrels; barrel++) roundedRect((barrel - (barrels - 1) / 2) * 8 - 2, -20, 4, 17, 1, '#defffa');
    ctx.restore();
    for (const weapon of state.weapons) {
      if (weapon.id !== 'orbit') continue;
      const drone = { x: pilot.x + Math.cos(weapon.phase || 0) * orbitRadius(), y: pilot.y + Math.sin(weapon.phase || 0) * orbitRadius() };
      ctx.strokeStyle = '#b59dff33'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(pilot.x, pilot.y, orbitRadius(), 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#b59dff'; ctx.shadowColor = '#b59dff'; ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.arc(drone.x, drone.y, 6, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
    }
    for (const p of state.particles) { ctx.globalAlpha = Math.max(0, p.life / .65); ctx.fillStyle = p.color; ctx.fillRect(p.x - 2, p.y - 2, 3, 3); }
    ctx.globalAlpha = 1;
    for (const effect of state.effects) {
      ctx.globalAlpha = Math.min(1, effect.life * 2);
      if (effect.xp) { ctx.fillStyle = '#ffcb78'; ctx.font = 'bold 11px system-ui'; ctx.fillText('+' + effect.xp + ' XP', effect.x, effect.y - (1 - effect.life / .8) * 28); }
      else { ctx.strokeStyle = effect.nova ? '#ffcb78' : effect.cryo ? '#a6d4ff' : '#65e5dd'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(effect.x, effect.y, effect.radius * (1 - effect.life / .4), 0, Math.PI * 2); ctx.stroke(); }
    }
    ctx.globalAlpha = 1; ctx.lineWidth = 1;
    roundedRect(32, 622, 416, 46, 6, '#132c39');
    ctx.fillStyle = state.health <= 30 ? '#ff687e90' : '#65e5dd90'; ctx.fillRect(38, 622, 404, 3);
    for (let x = 44; x < 437; x += 24) roundedRect(x, 634, 16, 9, 2, '#65e5dd22');
    ctx.fillStyle = '#9eb9c6'; ctx.font = '8px system-ui'; ctx.fillText('S K Y H O L D   /   L A S T   O U T P O S T', 240, 659);
  }

  function togglePause() {
    if (state.phase !== 'combat') return;
    paused = !paused; keys.clear(); pointer = null;
    if (paused) overlay('TAKE A BREATHER', 'Holding<br>position.', 'Your battlefield is paused. Resume whenever you are ready.', 'Resume game', 'P TO RESUME');
    else { $('overlay').hidden = true; canvas.focus({ preventScroll: true }); }
    updateUI();
  }
  function tone(frequency, duration, type = 'sine', volume = .03) {
    if (!soundEnabled || !audioContext || audioContext.state !== 'running') return;
    const oscillator = audioContext.createOscillator(), gain = audioContext.createGain();
    oscillator.type = type; oscillator.frequency.setValueAtTime(frequency, audioContext.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(30, frequency / 2), audioContext.currentTime + duration);
    gain.gain.setValueAtTime(volume, audioContext.currentTime); gain.gain.exponentialRampToValueAtTime(.001, audioContext.currentTime + duration);
    oscillator.connect(gain); gain.connect(audioContext.destination); oscillator.start(); oscillator.stop(audioContext.currentTime + duration);
  }
  $('sound').addEventListener('click', async () => {
    try {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio) { $('sound').textContent = 'Sound unavailable'; return; }
      if (!audioContext) audioContext = new Audio();
      await audioContext.resume(); soundEnabled = !soundEnabled; saveSettings();
      $('sound').textContent = soundEnabled ? 'Sound on' : 'Sound off'; $('sound').setAttribute('aria-pressed', String(soundEnabled)); tone(500, .08);
    } catch { $('sound').textContent = 'Sound unavailable'; }
  });
  $('auto-fire').addEventListener('change', () => { autoFire = $('auto-fire').checked; saveSettings(); });
  $('overlay-action').addEventListener('click', () => {
    if (paused) togglePause();
    else if (state.phase === 'lost') reset();
    else beginRun();
  });
  $('pause').addEventListener('click', togglePause); $('restart').addEventListener('click', reset);
  const gameKeys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'KeyP', 'Escape'];
  window.addEventListener('keydown', event => {
    if (state.phase === 'upgrade') {
      const index = ['Digit1', 'Digit2', 'Digit3'].indexOf(event.code);
      if (index >= 0) { event.preventDefault(); if (!event.repeat) chooseUpgrade(state.choices[index]); }
      if (event.code === 'Tab') {
        const cards = Array.from($('upgrade-choices').children), current = cards.indexOf(document.activeElement);
        event.preventDefault(); cards[(current + (event.shiftKey ? -1 : 1) + cards.length) % cards.length]?.focus();
      }
      if (gameKeys.includes(event.code) && !(event.code === 'Space' && event.target.closest('.upgrade-card'))) event.preventDefault();
      return;
    }
    if (!gameKeys.includes(event.code) || state.phase !== 'combat') return;
    if (event.target.closest('button, input, a') && !['KeyP', 'Escape'].includes(event.code)) return;
    event.preventDefault();
    if (event.code === 'KeyP' || event.code === 'Escape') { if (!event.repeat) togglePause(); }
    else keys.add(event.code);
  });
  window.addEventListener('keyup', event => keys.delete(event.code));
  // Losing focus must not pause the run. Only held inputs are released so the defender
  // does not keep drifting on a key that was never lifted. The simulation keeps running:
  // browsers already throttle requestAnimationFrame in a hidden tab, and the frame loop
  // clamps dt, so time away costs you without silently freezing the fight.
  const releaseInputs = () => { keys.clear(); pointer = null; };
  window.addEventListener('blur', releaseInputs);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseInputs(); });
  function canvasPoint(event) { const rect = canvas.getBoundingClientRect(); return { x: (event.clientX - rect.left) / rect.width * W, y: (event.clientY - rect.top) / rect.height * H }; }
  canvas.addEventListener('pointerdown', event => {
    if (paused || state.phase !== 'combat' || pointer) return;
    event.preventDefault(); canvas.focus({ preventScroll: true }); pointer = { ...canvasPoint(event), id: event.pointerId }; canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', event => { if (pointer && pointer.id === event.pointerId) pointer = { ...canvasPoint(event), id: event.pointerId }; });
  const release = event => { if (pointer && pointer.id === event.pointerId) pointer = null; };
  canvas.addEventListener('pointerup', release); canvas.addEventListener('pointercancel', release); canvas.addEventListener('lostpointercapture', release);
  // Back the canvas with physical pixels so vector art stays crisp on high-DPI screens.
  // Drawing code keeps using the fixed 480x680 logical coordinate system, so the backing
  // size is derived from the element's real CSS size and scaled back down via setTransform.
  function resizeCanvas() {
    const rect = typeof canvas.getBoundingClientRect === 'function' ? canvas.getBoundingClientRect() : null;
    const cssWidth = (rect && rect.width) || W;
    const ratio = Math.min(3, (cssWidth / W) * (window.devicePixelRatio || 1));
    canvas.width = Math.round(W * ratio); canvas.height = Math.round(H * ratio);
    if (typeof ctx.setTransform === 'function') ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }
  function frame(now) {
    const dt = Math.min(.033, Math.max(0, (now - (last || now)) / 1000)); last = now;
    if (!paused && state.phase !== 'upgrade') elapsed += dt;
    update(dt); draw(); requestAnimationFrame(frame);
  }
  resizeCanvas(); window.addEventListener('resize', resizeCanvas);
  reset(); requestAnimationFrame(frame);
})();
