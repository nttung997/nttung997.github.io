(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const canvas = $('field'), ctx = canvas.getContext('2d');
  const W = 480, H = 680, MAX_ALIVE = 40, THREAT_RATE = 30, BOSS_EVERY = 4;
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  // One unified weapon system. A run locks exactly one of six weapons; its rank lives in
  // state.build[weaponId] and its evolution replaces the base at max rank plus one paired
  // passive. Passives are shared by every weapon, so the level-up pool is passives plus
  // the locked weapon's next rank plus its evolution once the gate is met.
  const upgrades = {
    damage: { name: 'Overcharged rounds', icon: '✦', max: 5, description: '+25% weapon damage per rank.' },
    pierce: { name: 'Phase rounds', icon: '➶', max: 3, description: 'Each projectile passes through one more enemy. Exclusive with Volatile rounds.' },
    blast: { name: 'Volatile rounds', icon: '◈', max: 3, description: 'Projectiles explode on impact. Each rank increases the blast radius. Exclusive with Phase rounds.' },
    frost: { name: 'Cryo rounds', icon: '❄', max: 3, description: 'Projectiles slow enemies. Each rank makes the chill stronger and longer.' },
    repair: { name: 'Emergency repair', icon: '+', max: Infinity, description: 'Restore 35 base integrity immediately, up to 100.' }
  };
  // `interval` is seconds between activations; `fire` mutates the world. Rank scaling is
  // read through weaponRank(), which treats an unranked weapon as rank 1 and lets an
  // evolved weapon inherit its base's maxed rank. Evolutions have the same shape and
  // delegate to the base weapon's fire; their unique effect lives in the shared mechanics.
  const weapons = {
    blaster: {
      name: 'Blaster', icon: '✦', tag: 'PHYSICAL', max: 5, interval: 1,
      description: 'Aimed bursts. Ranks 1→5 widen the volley 1×1, 1×2, 2×2, 2×3, 3×3. Evolves into the Arc laser.',
      fire(weapon, target) { firePattern(weapon, target, 'blaster', fireInterval()); }
    },
    gravity: {
      name: 'Gravity', icon: '◉', tag: 'GRAVITY', max: 5, interval: 1,
      description: 'Aimed rounds charge enemies; ranks widen the volley and add bursts. Charged enemies pull each other together and crush on contact.',
      fire(weapon, target) {
        if (firePattern(weapon, target, 'gravity', 1)) tone(360, .03, 'sine', .006);
      }
    },
    cryo: {
      name: 'Cryo', icon: '❆', tag: 'CRYO', max: 5, interval: .9,
      description: 'Aimed frost volleys (1×1, 1×2, 2×2, 2×3, 3×3 at ranks 1–5) that stack slow on impact and in a burst. Each stack slows less than the last. At speed 10 the target crawls; the shatter waits longer as threat and the volley grow. No direct damage.',
      fire(weapon, target) {
        if (firePattern(weapon, target, 'cryo', .9)) tone(700, .04, 'sine', .008);
      }
    },
    rad: {
      name: 'Rad', icon: '☣', tag: 'RAD', max: 5, interval: 1,
      description: 'Aimed rounds add permanent radiation stacks; ranks widen the volley and add bursts. Damage ramps with every stack, and auto-aim targets the enemy about to leak.',
      fire(weapon, target) {
        if (firePattern(weapon, target, 'rad', 1)) tone(620, .03, 'triangle', .007);
      }
    },
    orbit: {
      name: 'Orbital drone', icon: '⟳', tag: 'ORBIT', max: 3, interval: .25,
      description: 'A drone sweeps a wide contact zone around your defender. No aim required.',
      fire(weapon) {
        if (weapon.cooldown > 1e-9) return;
        const pilot = state.pilot, damage = orbitDamage(), ring = orbitRadius();
        // The drone patrols the ring; anything crossing that lane is shredded. Using the
        // lane rather than the drone's instantaneous position keeps a stationary build
        // viable while the drone animation still sells the fantasy.
        const lanes = rank('twin') > 0 ? 2 : 1;
        for (const enemy of state.enemies) {
          if (enemy.hp <= 0 || enemy.y < 0) continue;
          if (Math.abs(distance(pilot, enemy) - ring) > ORBIT_HIT_RADIUS + enemy.radius) continue;
          // Bigger bodies take more contact damage, so tanks and siege carriers stay
          // relevant without overkill on trash.
          hit(enemy, damage * lanes * (1 + enemy.radius / 20), false);
        }
        weapon.cooldown = .25; tone(560, .03, 'square', .005);
      }
    },
    mines: {
      name: 'Mines', icon: '✸', tag: 'MINES', max: 3, interval: .6,
      description: 'Drops armed charges behind you. Enemies that touch a charge take blast damage.',
      fire(weapon) {
        if (weapon.cooldown > 1e-9) return;
        const pilot = state.pilot, rankNow = weaponRank('mines');
        // Spread drops across a rear arc so a stationary build covers the whole lane.
        weapon.phase = ((weapon.phase || 0) + 1) % 5;
        const lateral = (weapon.phase - 2) * 40;
        dropMine({ x: clamp(pilot.x - Math.cos(pilot.angle) * 24 - Math.sin(pilot.angle) * lateral, 18, W - 18),
          y: clamp(pilot.y - Math.sin(pilot.angle) * 24 + Math.cos(pilot.angle) * lateral, 64, H - 70),
          radius: 110 + (rankNow - 1) * 12, damage: mineDamage(), arm: .45, sub: false });
        weapon.cooldown = .6; tone(300, .04, 'square', .008);
      }
    }
  };
  const WEAPON_IDS = ['blaster', 'gravity', 'cryo', 'rad', 'orbit', 'mines'];
  const evolutionReady = (evoId, from, passive) => rank(evoId) === 0
    && rank(from) >= weapons[from].max && rank(passive) > 0;
  const evolutions = {
    arc: {
      name: 'Arc laser', icon: '⚡', tag: 'ARC', max: 1, interval: .2, from: 'blaster', requires: 'pierce',
      description: 'Replaces your blaster with a continuous beam that pierces every enemy along the aim line, sweeping five times a second.',
      ready: () => evolutionReady('arc', 'blaster', 'pierce'),
      fire(weapon, target) {
        if (weapon.cooldown > 1e-9 || !target) return;
        const pilot = state.pilot;
        const angle = Math.atan2(target.y - pilot.y, target.x - pilot.x);
        pilot.angle = angle;
        const cos = Math.cos(angle), sin = Math.sin(angle);
        for (const enemy of state.enemies) {
          if (enemy.hp <= 0 || enemy.y < 0) continue;
          const dx = enemy.x - pilot.x, dy = enemy.y - pilot.y;
          const along = dx * cos + dy * sin;
          if (along < -enemy.radius || along > ARC_RANGE) continue;
          const across = Math.abs(-dx * sin + dy * cos);
          if (across > ARC_HALF_WIDTH + enemy.radius) continue;
          if (rank('frost')) enemy.slow = 1.3 + rank('frost') * .35;
          hit(enemy, arcDamage(), false);
        }
        state.effects.push({ x: pilot.x, y: pilot.y, angle, length: ARC_RANGE, life: .12, beam: true });
        weapon.cooldown = ARC_INTERVAL; tone(900, .02, 'sawtooth', .004);
      }
    },
    singularity: {
      name: 'Singularity', icon: '◉', tag: 'SINGULARITY', max: 1, interval: 1, from: 'gravity', requires: 'blast',
      description: 'Gravity rounds gain a stronger, wider pull that collapses a whole cluster into one point.',
      ready: () => evolutionReady('singularity', 'gravity', 'blast'),
      fire(weapon, target) { weapons.gravity.fire(weapon, target); }
    },
    absolute: {
      name: 'Absolute zero', icon: '❄', tag: 'ABSOLUTE ZERO', max: 1, interval: .9, from: 'cryo', requires: 'blast',
      description: 'When an enemy starts crawling, one slow stack spills onto nearby enemies.',
      ready: () => evolutionReady('absolute', 'cryo', 'blast'),
      fire(weapon, target) { weapons.cryo.fire(weapon, target); }
    },
    meltdown: {
      name: 'Meltdown', icon: '☢', tag: 'MELTDOWN', max: 1, interval: 1, from: 'rad', requires: 'damage',
      description: 'Radiation ticks faster and spreads to nearby enemies when a host dies.',
      ready: () => evolutionReady('meltdown', 'rad', 'damage'),
      fire(weapon, target) { weapons.rad.fire(weapon, target); }
    },
    twin: {
      name: 'Twin orbit', icon: '⟲', tag: 'TWIN ORBIT', max: 1, interval: .25, from: 'orbit', requires: 'damage',
      description: 'A second drone circles opposite the first, doubling contact coverage.',
      ready: () => evolutionReady('twin', 'orbit', 'damage'),
      fire(weapon) { weapons.orbit.fire(weapon); }
    },
    cluster: {
      name: 'Cluster mines', icon: '✹', tag: 'CLUSTER MINES', max: 1, interval: .6, from: 'mines', requires: 'blast',
      description: 'Detonating a charge scatters three sub-charges around the blast.',
      ready: () => evolutionReady('cluster', 'mines', 'blast'),
      fire(weapon) { weapons.mines.fire(weapon); }
    }
  };
  const EVOLUTION_IDS = Object.keys(evolutions);
  const upgradeData = id => upgrades[id] || weapons[id] || evolutions[id];
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
  // The Arc laser ticks five times a second, so its per-tick damage is scaled down to land
  // in the same band as the other weapons while paying for its piercing line.
  const arcDamage = () => weaponDamage() * .5;
  const ARC_INTERVAL = .2, ARC_RANGE = 620, ARC_HALF_WIDTH = 12;
  const orbitDamage = () => weaponDamage() * .8 + (weaponRank('orbit') - 1) * 10;
  // The locked weapon is the run's only weapon; an owned evolution replaces it.
  function activeWeaponId() {
    for (const id of EVOLUTION_IDS) if (rank(id) > 0) return id;
    return state.weaponId;
  }
  // Base weapons scale off their rank. An evolved weapon inherits its base's maxed rank so
  // per-hit values and the rank-5 volley pattern survive the replace.
  function weaponRank(id) {
    const own = rank(id);
    if (own > 0) return own;
    const active = state && state.phase !== 'ready' ? activeWeaponId() : null;
    return active && evolutions[active] && evolutions[active].from === id ? weapons[id].max : 1;
  }
  // Bullet weapons rank their way through the same shot pattern:
  // 1×1, 1×2, 2×2, 2×3, 3×3 at ranks 1–5.
  const PATTERN_BY_RANK = [
    { bursts: 1, parallel: 1 },
    { bursts: 1, parallel: 2 },
    { bursts: 2, parallel: 2 },
    { bursts: 2, parallel: 3 },
    { bursts: 3, parallel: 3 }
  ];
  const patternBase = id => id === 'absolute' ? 'cryo'
    : id === 'singularity' ? 'gravity'
    : id === 'meltdown' ? 'rad' : id;
  const BULLET_WEAPONS = ['blaster', 'cryo', 'gravity', 'rad', 'absolute', 'singularity', 'meltdown'];
  const isBulletWeapon = id => BULLET_WEAPONS.includes(id);
  const shotPattern = (id = 'blaster') => {
    const base = patternBase(id);
    const rankNow = clamp(weaponRank(base), 1, weapons[base].max);
    return PATTERN_BY_RANK[rankNow - 1];
  };
  function enemySpeedFactor(enemy) { return enemy.slow > 0 ? chillFactor() : 1; }
  const moveSpeed = () => 270;
  const spawnDelay = threat => Math.max(.3, 1.2 - threat * .06);

  function reset() {
    state = { phase: 'ready', weaponId: null, health: 100, score: 0, kills: 0, level: 1, xp: 0, build: {},
      enemies: [], bullets: [], mines: [], particles: [], effects: [], spawnClock: .6,
      pilot: { x: 240, y: 545, hitTimer: 0, angle: -Math.PI / 2 },
      weapons: [], runTime: 0, threat: 1, choices: [] };
    paused = false; keys.clear(); pointer = null;
    clearTimeout(bannerTimer); $('banner').classList.remove('visible');
    $('auto-fire').checked = autoFire; closeUpgrade();
    overlay('ONE PILOT. SIX WEAPONS.', 'Choose your<br>weapon.',
      'Your weapon aims and fires automatically. Pick one of six — it is locked until you restart. Dodge, earn XP, rank it up, and evolve it. Keep the base alive.',
      'Start surviving', 'AUTO AIM · LOCKED WEAPON · EVOLUTIONS');
    renderWeaponPicker(); showWeaponPicker();
    message('Pick a weapon. It is locked for this run.');
    renderLoadout(); updateUI();
  }

  function overlay(kicker, title, text, action, note) {
    $('overlay-kicker').textContent = kicker; $('overlay-title').innerHTML = title;
    $('overlay-text').textContent = text; $('overlay-action').innerHTML = action + ' <span>→</span>';
    $('overlay-note').textContent = note; $('overlay').hidden = false;
  }
  function renderWeaponPicker() {
    const picker = $('class-picker'); picker.replaceChildren();
    for (const id of WEAPON_IDS) {
      const data = weapons[id], card = document.createElement('button');
      card.className = 'class-card'; card.dataset.weaponId = id; card.type = 'button';
      if (state.weaponId === id) card.classList.add('selected');
      const icon = document.createElement('span'); icon.className = 'class-icon'; icon.textContent = data.icon;
      const name = document.createElement('strong'); name.textContent = data.name;
      const tag = document.createElement('span'); tag.className = 'class-tag'; tag.textContent = data.tag;
      const description = document.createElement('span'); description.className = 'class-description'; description.textContent = data.description;
      card.append(icon, tag, name, description);
      card.addEventListener('click', () => chooseWeapon(id));
      picker.append(card);
    }
    picker.hidden = false;
  }
  function showWeaponPicker() { const picker = $('class-picker'); picker.hidden = false; $('overlay-action').hidden = true; }
  function hideWeaponPicker() { $('class-picker').hidden = true; $('overlay-action').hidden = false; }
  // Choosing a weapon is the real start of a run: it locks the only weapon and begins combat.
  function chooseWeapon(id) {
    if (state.phase !== 'ready' || !WEAPON_IDS.includes(id)) return;
    state.weaponId = id; state.build[id] = 1;
    hideWeaponPicker(); beginRun();
  }
  function message(text) { $('status').textContent = text; }
  function announce(text) {
    $('banner').textContent = text; $('banner').classList.add('visible');
    clearTimeout(bannerTimer); bannerTimer = setTimeout(() => $('banner').classList.remove('visible'), 1500);
  }
  function beginRun() {
    hideWeaponPicker();
    if (!state.weaponId) { state.weaponId = 'blaster'; if (!rank('blaster')) state.build.blaster = 1; }
    state.phase = 'combat'; state.spawnClock = .6; syncWeapons();
    $('overlay').hidden = true;
    announce('HOSTILES INBOUND');
    message(upgradeData(activeWeaponId()).name + ' locked in. Defeat enemies to earn XP and evolve it.');
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
    // Everything on this panel describes the one locked weapon.
    const id = state.weaponId ? activeWeaponId() : null;
    const data = id ? upgradeData(id) : null;
    $('damage-stat').textContent = id ? damageLabel(id) : '—';
    $('shot-stat').textContent = id ? shotLabel(id) : '—';
    $('shot-total').textContent = id ? shotTotalLabel(id) : 'Pick a weapon to see its firing profile.';
    $('rate-stat').textContent = data ? rateLabel(data) : '—';
    $('auto-fire').disabled = state.phase === 'upgrade';
    $('build-count').textContent = Object.values(state.build).reduce((sum, count) => sum + count, 0) + ' UPGRADES';
    $('weapon-count').textContent = data ? '1 WEAPON · ' + data.tag : 'NO WEAPON';
  }
  function rateLabel(data) {
    const hz = 1 / data.interval;
    return (Math.abs(hz - Math.round(hz)) < 1e-9 ? Math.round(hz) : hz.toFixed(1)) + ' Hz';
  }
  function damageLabel(id) {
    switch (id) {
      case 'blaster': return weaponDamage().toFixed(0);
      case 'arc': return arcDamage().toFixed(0) + '/tick';
      case 'gravity': case 'singularity': return gravityImpact().toFixed(0);
      case 'cryo': case 'absolute': return 'SLOW';
      case 'rad': case 'meltdown': return radDpsPerStack().toFixed(1) + '/stack';
      case 'orbit': case 'twin': return orbitDamage().toFixed(0);
      case 'mines': case 'cluster': return mineDamage().toFixed(0);
      default: return '—';
    }
  }
  function shotLabel(id) {
    if (isBulletWeapon(id)) {
      const pattern = shotPattern(id);
      return pattern.bursts + '×' + pattern.parallel;
    }
    return ({ arc: 'BEAM', orbit: 'ORBIT', twin: 'ORBIT', mines: 'TRAP', cluster: 'TRAP' })[id] || '—';
  }
  function shotTotalLabel(id) {
    if (id === 'blaster') {
      const pattern = shotPattern(), bullets = pattern.bursts * pattern.parallel;
      return bullets + ' bullet' + (bullets === 1 ? '' : 's') + ' per cycle · bursts × parallel bullets';
    }
    if (isBulletWeapon(id)) {
      const pattern = shotPattern(id), bullets = pattern.bursts * pattern.parallel;
      const note = {
        cryo: 'frost rounds · crawl, then shatter',
        absolute: 'frost rounds · crawl, then shatter',
        gravity: 'gravity rounds · charged enemies magnetise',
        singularity: 'gravity rounds · charged enemies magnetise',
        rad: 'radiation rounds · stacks scale the burn',
        meltdown: 'radiation rounds · stacks scale the burn'
      }[id];
      return bullets + ' round' + (bullets === 1 ? '' : 's') + ' per cycle · bursts × parallel; ' + note;
    }
    return ({
      arc: 'arc laser · pierces every enemy in the aim line, 5 ticks per second',
      orbit: 'orbital drone · contact damage, no aiming',
      twin: 'twin orbit · two drones, opposite phases',
      mines: 'mine layer · armed charges detonate on contact',
      cluster: 'cluster mines · detonations scatter sub-charges'
    })[id] || '';
  }
  function renderLoadout() {
    const loadout = $('loadout'); loadout.replaceChildren();
    // The locked weapon leads the list so the run's identity and rank are always visible.
    const id = state.weaponId ? activeWeaponId() : null;
    if (id) {
      const data = upgradeData(id), evolved = !!evolutions[id];
      const row = document.createElement('div'); row.className = 'loadout-item core';
      const icon = document.createElement('span'); icon.className = 'loadout-icon'; icon.textContent = data.icon;
      const name = document.createElement('strong'); name.textContent = data.name;
      const badge = document.createElement('span'); badge.className = 'loadout-rank';
      badge.textContent = evolved ? 'EVOLVED WEAPON' : 'LOCKED · RANK ' + rank(state.weaponId) + ' / ' + weapons[state.weaponId].max;
      row.append(icon, name, badge); loadout.append(row);
    }
    // Only passives live in the generic list; the weapon and its evolution are the core row.
    const owned = Object.entries(state.build).filter(([key, count]) => count > 0 && upgrades[key]);
    if (!owned.length) {
      if (id) return;
      const empty = document.createElement('p'); empty.className = 'empty-build';
      empty.textContent = 'Pick a weapon to lock in. Then add passives from level-up choices — they shape that weapon for the whole run. Your upgrades will appear here.'; loadout.append(empty); return;
    }
    for (const [id, count] of owned) {
      const data = upgrades[id];
      const row = document.createElement('div'); row.className = 'loadout-item';
      const icon = document.createElement('span'); icon.className = 'loadout-icon'; icon.textContent = data.icon;
      const name = document.createElement('strong'); name.textContent = data.name;
      const badge = document.createElement('span'); badge.className = 'loadout-rank';
      badge.textContent = id === 'repair' ? count + ' USED' : 'RANK ' + count + ' / ' + data.max;
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
  // The pool is passives plus the locked weapon's next rank plus its evolution once the
  // gate is met. There is no weapon-discovery problem because only one weapon can appear.
  function pickChoices() {
    const candidates = Object.keys(upgrades);
    const evolved = EVOLUTION_IDS.some(id => rank(id) > 0);
    if (state.weaponId && !evolved && rank(state.weaponId) < weapons[state.weaponId].max) candidates.push(state.weaponId);
    candidates.push(...EVOLUTION_IDS);
    const active = state.weaponId ? activeWeaponId() : null;
    const blocked = id => {
      // Cryo already chills: the frost passive would be a dead card for that run.
      if (id === 'frost' && (active === 'cryo' || active === 'absolute')) return true;
      // Phase rounds and Volatile rounds occupy the same slot: taking one removes the other.
      if (id === 'pierce' && rank('blast') > 0) return true;
      if (id === 'blast' && rank('pierce') > 0) return true;
      return false;
    };
    const available = id => {
      const data = upgradeData(id);
      if (!data || blocked(id) || rank(id) >= data.max) return false;
      if (data.ready) return data.ready();
      return id !== 'repair' || state.health < 100;
    };
    const choices = shuffle(candidates.filter(available)).slice(0, 3);
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
      const data = upgradeData(id), card = document.createElement('button'); card.className = 'upgrade-card'; card.dataset.upgrade = id;
      const icon = document.createElement('span'); icon.className = 'upgrade-icon'; icon.textContent = data.icon;
      const badge = document.createElement('span'); badge.className = 'upgrade-rank';
      badge.textContent = data.ready ? 'EVOLUTION · REPLACES ' + weapons[data.from].name.toUpperCase()
        : id === 'repair' ? 'INSTANT RECOVERY'
        : id === state.weaponId ? 'WEAPON · RANK ' + (rank(id) + 1) + ' / ' + data.max
        : 'RANK ' + (rank(id) + 1) + ' / ' + data.max;
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
    const data = upgradeData(id);
    if (state.phase !== 'upgrade' || !state.choices.includes(id) || !data) return;
    state.build[id] = rank(id) + 1;
    if (id === 'repair') state.health = Math.min(100, state.health + 35);
    if (data.ready) {
      // Evolution replace semantics: the base rank leaves the build and the evolved weapon
      // takes the slot with a fresh cooldown.
      delete state.build[data.from];
    } else if (id === state.weaponId) {
      // Taking a weapon rank resets its cooldown so the upgrade feels instant.
      const instance = state.weapons[0];
      if (instance) { instance.cooldown = 0; instance.pendingBursts = []; }
    }
    syncWeapons();
    state.choices = []; state.phase = 'combat'; closeUpgrade(); renderLoadout();
    message(data.name + ' acquired. Keep moving and let your weapon work.'); updateUI();
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
      drone: { hp: 46 * scale, speed: 31 + state.threat * 2.2, radius: 13, xp: 5, damage: 7, color: '#ef829b' },
      runner: { hp: 30 * scale, speed: 56 + state.threat * 3.1, radius: 10, xp: 6, damage: 5, color: '#ffbd78' },
      tank: { hp: 170 * scale, speed: 22 + state.threat * 1.1, radius: 19, xp: 12, damage: 14, color: '#b59dff' },
      boss: { hp: 3200 * scale, speed: 16, radius: 40, xp: 80, damage: 100, color: '#ff687e' }
    }[type];
    const x = type === 'boss' ? 240 : 85 + Math.random() * 310;
    // status fields: cryoStacks/cryoFreezeStacks/chill/frozen drive Cryo, rad drives the stacking DoT,
    // charge/chargeTimer drive Gravity's magnet pull, driftX/driftY carry external forces
    // because x is recomputed from originX each frame.
    state.enemies.push({ ...data, type, maxHp: data.hp, x, originX: x, y: -50, time: 0, slow: 0, flash: 0, attackClock: 2,
      chill: 0, cryoStacks: 0, cryoFreezeStacks: 0, frozen: false, rad: 0, charge: 0, chargeTimer: 0, driftX: 0, driftY: 0, impactClock: 0 });
  }
  function aimTarget() {
    return state.enemies.reduce((nearest, enemy) => enemy.hp > 0 && enemy.y >= 0 && enemy.y < 623 &&
      (!nearest || distance(state.pilot, enemy) < distance(state.pilot, nearest)) ? enemy : nearest, null);
  }
  const BASE_LINE = 623;
  function advanceSpeed(enemy) {
    return enemy.speed * enemySpeedFactor(enemy) * chillSpeedFactor(enemy);
  }
  // Radiation does not want the nearest enemy: it wants the enemy that will otherwise
  // reach the outpost. Risk is time-to-die minus time-to-reach. Positive means radiation
  // still has work to do; once it is on pace to kill before arrival the score goes negative
  // and the aim moves on. That spreads stacks instead of stacking one enemy into absurdity
  // while its neighbours walk through unopposed.
  function radRisk(enemy) {
    const reach = Math.max(0, BASE_LINE - enemy.y) / Math.max(1, advanceSpeed(enemy));
    const dps = radDps(enemy);
    // Capped rather than Infinity so risk stays comparable and tie-breaks work. Any enemy
    // with no radiation on it is maximally urgent: it will never die on its own.
    const die = dps > 0 ? Math.min(enemy.hp / dps, RISK_CAP) : RISK_CAP;
    return { risk: die - reach, reach, die };
  }
  function radAimTarget() {
    let best = null, bestPick = null;
    for (const enemy of state.enemies) {
      if (enemy.hp <= 0 || enemy.y < 0 || enemy.y >= BASE_LINE) continue;
      const pick = radRisk(enemy);
      // Highest risk wins; ties break toward the enemy closest to the outpost, then toward
      // the one with the fewest stacks so freshly spawned hostiles get seeded early.
      if (!bestPick || pick.risk > bestPick.risk + 1e-6
        || (Math.abs(pick.risk - bestPick.risk) <= 1e-6 && (pick.reach < bestPick.reach - 1e-6
          || (Math.abs(pick.reach - bestPick.reach) <= 1e-6 && radStacks(enemy) < radStacks(best))))) {
        best = enemy; bestPick = pick;
      }
    }
    return best;
  }
  // Aim is weapon-aware: Rad wants whoever is about to leak through; everything else wants
  // the nearest visible threat. The reticle follows the same choice.
  function weaponTarget() {
    const id = state.phase === 'ready' ? null : activeWeaponId();
    return id === 'rad' || id === 'meltdown' ? radAimTarget() : aimTarget();
  }
  // Area weapons ignore aim; the reticle and facing only move for aimed weapons.
  const weaponAims = id => !['orbit', 'twin'].includes(id);
  function blasterTarget() { return weaponTarget(); }
  const ORBIT_HIT_RADIUS = 100;
  // The patrol lane is wide enough to cover the defender's own position, so a stationary
  // player still gets value; rank widens the patrol slightly.
  const orbitRadius = () => 50 + weaponRank('orbit') * 6;
  // Every frost round carries two slow stacks; rank widens the five-step volley pattern
  // instead of inflating each round. Slow potency is per-enemy, from cryoSlowPerStack.
  const cryoStacksPerHit = () => 2;
  const cryoBurstRadius = () => 56 + weaponRank('cryo') * 8;
  const mineDamage = () => weaponDamage() * .8 + (weaponRank('mines') - 1) * 14;
  // Crawl speed at which an enemy stops being a threat. Further stacks do not slow it
  // past this — they count toward the shatter instead, so the pile stays on the field.
  const CRYO_FREEZE_SPEED = 10;
  // Each stack removes this fraction of the speed the enemy still has, so the next stack
  // always cuts less than the last. High-HP bodies get a smaller fraction. The reference
  // is the base drone's 46 HP.
  const cryoSlowPerStack = enemy => Math.min(.5, .35 * Math.sqrt(46 / Math.max(1, enemy.maxHp)));
  // Stacks still owed once the crawl begins. The early game crawls for about four seconds.
  // Threat stretches that, and the volley only shortens it by its square root, so a wide
  // pattern cannot erase the pile in a single cycle. Every body in the pile shares the gap;
  // high HP still reaches the crawl later because each stack slows it less.
  function cryoShatterGap() {
    const threat = Math.max(1, state.threat || 1);
    const pattern = shotPattern('cryo');
    const rounds = pattern.bursts * pattern.parallel;
    const desiredSeconds = (4 + .35 * (threat - 1)) / Math.sqrt(rounds);
    const stacksPerSecond = rounds * cryoStacksPerHit() / weapons.cryo.interval;
    return Math.max(1, Math.round(desiredSeconds * stacksPerSecond));
  }
  function cryoReadyToShatter(enemy) {
    return !!enemy.frozen && (enemy.cryoStacks || 0) >= (enemy.cryoFreezeStacks || 0) + cryoShatterGap(enemy);
  }
  function cryoStacksRemaining(enemy) {
    if (!enemy.frozen) return 0;
    return Math.max(0, (enemy.cryoFreezeStacks || 0) + cryoShatterGap(enemy) - (enemy.cryoStacks || 0));
  }
  // Radiation has no expiry, so the cap keeps a single target from absorbing infinite damage.
  const RAD_MAX_STACKS = 40;
  // Sentinel time-to-die for an enemy that carries no radiation yet. Large but finite so it
  // compares cleanly against real estimates and never wins a tie-break by being NaN.
  const RISK_CAP = 999;
  // Pull is a velocity in px/s, written into the enemy's lane so the displacement sticks.
  // A full charge closes a nearby gap in about a second; partial charge still gathers a cluster.
  const GRAVITY_MAX = 6, GRAVITY_LIFE = 3, GRAVITY_PULL = 260, GRAVITY_RANGE = 280;
  const MAX_MINES = 6;
  // Slow stacks persist until the target shatters. `chill` is the derived 0→1 slow fraction
  // from the diminishing curve; `cryoStacks` is the stack count the player is building.
  // `cryoFreezeStacks` is the count at the moment the crawl began, so the shatter gap is
  // measured from there rather than from zero.
  function applyChill(enemy, stacks, spread = false) {
    const wasFrozen = enemy.frozen;
    enemy.cryoStacks = (enemy.cryoStacks || 0) + stacks;
    const kept = 1 - cryoSlowPerStack(enemy);
    enemy.chill = 1 - Math.pow(kept, enemy.cryoStacks);
    // Freeze is the crawl, not the kill. Record the stack count once so later stacks
    // cannot move the finish line.
    if (!wasFrozen && enemy.speed * (1 - enemy.chill) <= CRYO_FREEZE_SPEED) {
      enemy.frozen = true;
      enemy.cryoFreezeStacks = enemy.cryoStacks;
      // Absolute zero: starting the crawl spills one stack onto neighbours, and spread
      // stacks cannot chain. A neighbour already on the shatter line breaks now.
      if (!spread && rank('absolute') > 0) {
        for (const other of state.enemies) {
          if (other !== enemy && other.hp > 0 && distance(other, enemy) < 70 + other.radius) {
            applyChill(other, 1, true);
            if (cryoReadyToShatter(other)) hit(other, 0, false);
          }
        }
      }
    }
  }
  // Shatter executes: it returns the target's remaining HP as the damage, so filling the
  // stack gap is a guaranteed kill rather than a damage bonus. Cryo has no other damage source.
  function shatter(enemy) {
    if (!cryoReadyToShatter(enemy)) return 0;
    const lethal = enemy.hp;
    enemy.frozen = false; enemy.chill = 0; enemy.cryoStacks = 0; enemy.cryoFreezeStacks = 0;
    burst(enemy.x, enemy.y, '#a6ceff', 20); tone(880, .08, 'triangle', .02);
    state.score += 30;
    return lethal;
  }
  // Chill multiplies movement. Once the crawl starts, speed floors at the threshold so
  // extra stacks do not stop the enemy. Kept separate from the frost passive's timed slow
  // so the two stack multiplicatively rather than overwrite.
  function chillSpeedFactor(enemy) {
    if (!enemy.chill) return 1;
    const factor = Math.max(0, 1 - enemy.chill);
    if (!enemy.frozen) return factor;
    const floor = Math.min(1, CRYO_FREEZE_SPEED / Math.max(enemy.speed, 1e-6));
    return Math.max(factor, floor);
  }
  function applyRad(enemy, stacks) {
    // Radiation never expires: every round is a permanent investment. The cap only stops a
    // single enemy from becoming an infinite damage sink.
    enemy.rad = Math.min(RAD_MAX_STACKS, (enemy.rad || 0) + stacks);
  }
  // Radiation is pure damage over time: no direct damage at all. Damage per second is
  // linear in stacks, so every round makes the next second hurt more. Meltdown raises the
  // per-stack value and makes stacks spread on death.
  const radDpsPerStack = () => weaponDamage() * (rank('meltdown') > 0 ? .3 : .2);
  const radStacks = enemy => enemy.rad || 0;
  const radDps = enemy => radStacks(enemy) * radDpsPerStack();
  // Gravity pays no direct damage and no burn. Charge only pulls; the damage is the
  // crush when a charged enemy overlaps another. A lone charged enemy is harmless.
  const gravityImpact = () => weaponDamage() * 1.4;
  const gravityCrush = () => weaponDamage() * .9;
  const gravityPullForce = () => GRAVITY_PULL * (rank('singularity') > 0 ? 1.6 : 1);
  const gravityPullRange = () => GRAVITY_RANGE * (rank('singularity') > 0 ? 1.35 : 1);

  function applyGravity(enemy, charges) {
    enemy.charge = Math.min(GRAVITY_MAX, (enemy.charge || 0) + charges);
    enemy.chargeTimer = GRAVITY_LIFE;
  }
  // Bullets carry their weapon id; the weapon decides what contact means. Every projectile
  // still applies the frost passive's slow.
  function applyBulletHit(enemy, bullet) {
    if (bullet.slow) enemy.slow = 1.3 + rank('frost') * .35;
    if (bullet.weaponId === 'rad') { applyRad(enemy, bullet.stacks || 1); enemy.flash = Math.max(enemy.flash, .05); }
    else if (bullet.weaponId === 'gravity') { applyGravity(enemy, bullet.charges || 1); enemy.flash = Math.max(enemy.flash, .05); }
    else if (bullet.weaponId === 'cryo') {
      // Frost rounds only add slow stacks. hit(0) is the execute check: it shatters only
      // when this round fills the stack gap past the crawl.
      applyChill(enemy, bullet.stacks || 1);
      hit(enemy, 0, false);
    }
    else hit(enemy, bullet.damage, bullet.slow);
  }
  // One instance, created from the locked weapon (or its evolution) when combat starts.
  function syncWeapons() {
    if (!state.weaponId || state.phase === 'ready') { state.weapons = []; return; }
    const id = activeWeaponId();
    if (state.weapons.length === 1 && state.weapons[0].id === id) return;
    state.weapons = [{ id, cooldown: 0, pendingBursts: [], phase: 0 }];
  }
  function firePilot(target) {
    const weapon = state.weapons.find(entry => entry.id === 'blaster');
    if (weapon) weapons.blaster.fire(weapon, target);
  }
  // Shared projectile constructor. The weapon id decides what contact means in
  // applyBulletHit(); passives decide shape and side effects.
  function fireRounds(target, options) {
    const pilot = state.pilot, speed = 560;
    const flightTime = distance(pilot, target) / speed;
    const predicted = { x: target.x, y: target.y + target.speed * enemySpeedFactor(target) * flightTime };
    const angle = Math.atan2(predicted.y - pilot.y, predicted.x - pilot.x);
    pilot.angle = angle;
    const parallel = options.parallel || 1;
    // Muzzles stay 8 px apart, but each lane launches at a slightly different angle, so a
    // multi-round volley fans out as it travels instead of staying a rigid column.
    for (let barrel = 0; barrel < parallel; barrel++) {
      const lane = barrel - (parallel - 1) / 2;
      const offset = lane * 8;
      const launch = angle + lane * .03;
      state.bullets.push({ x: pilot.x + Math.cos(angle) * 18 - Math.sin(angle) * offset,
        y: pilot.y + Math.sin(angle) * 18 + Math.cos(angle) * offset,
        vx: Math.cos(launch) * speed, vy: Math.sin(launch) * speed,
        weaponId: options.weaponId, damage: options.damage || 0, splash: options.splash || 0,
        stacks: options.stacks || 0, charges: options.charges || 0,
        chill: options.chill || 0, splashColor: options.splashColor || '#ffcb78',
        slow: options.slow || false, pierce: options.pierce || 0,
        hitEnemies: new Set(), color: rank('frost') ? '#a6baff' : options.color,
        radius: options.radius || 3, life: 2, enemy: false });
    }
    tone(650, .025, 'triangle', .009);
  }
  function fireVolley(target, parallel) {
    fireRounds(target, { weaponId: 'blaster', parallel, damage: weaponDamage(),
      splash: rank('blast') ? 28 + rank('blast') * 12 : 0, slow: rank('frost') > 0,
      pierce: rank('pierce'), color: '#9cfff1', radius: rank('blast') ? 4 : 3 });
  }
  function fireCryoVolley(target, parallel) {
    fireRounds(target, { weaponId: 'cryo', parallel, color: '#a6d4ff', radius: 4,
      stacks: cryoStacksPerHit(),
      splash: cryoBurstRadius() + (rank('blast') ? 20 + rank('blast') * 10 : 0),
      splashColor: '#a6d4ff', pierce: rank('pierce') });
  }
  function fireGravityVolley(target, parallel) {
    const rankNow = Math.min(weaponRank('gravity'), 3);
    fireRounds(target, { weaponId: 'gravity', parallel, charges: 1 + rankNow, color: '#c3a9ff',
      radius: 4, slow: rank('frost') > 0, pierce: rank('pierce'),
      splash: 34 + rankNow * 8 + (rank('blast') ? 28 + rank('blast') * 12 : 0) });
  }
  function fireRadVolley(target, parallel) {
    fireRounds(target, { weaponId: 'rad', parallel, stacks: 2 + Math.min(weaponRank('rad'), 3), color: '#a9e08a',
      radius: 4, slow: rank('frost') > 0, pierce: rank('pierce'),
      splash: rank('blast') ? 28 + rank('blast') * 12 : 0 });
  }
  function weaponVolley(id, target, parallel) {
    const base = patternBase(id);
    if (base === 'cryo') fireCryoVolley(target, parallel);
    else if (base === 'gravity') fireGravityVolley(target, parallel);
    else if (base === 'rad') fireRadVolley(target, parallel);
    else fireVolley(target, parallel);
  }
  function firePattern(weapon, target, id, cooldown) {
    if (weapon.cooldown > 1e-9 || !target || weapon.pendingBursts.length) return false;
    const pattern = shotPattern(id);
    for (let burstIndex = 0; burstIndex < pattern.bursts; burstIndex++) {
      const delay = burstIndex * .20;
      if (delay === 0) weaponVolley(id, target, pattern.parallel);
      else weapon.pendingBursts.push({ delay, parallel: pattern.parallel });
    }
    weapon.cooldown = cooldown;
    return true;
  }
  // Mines are ground hazards with an arming delay. Detonation routes through hit() so the
  // death guard owns kill credit. Cluster mines scatter sub-charges once.
  function dropMine(mine) {
    if (state.mines.length >= MAX_MINES) detonateMine(state.mines[0]);
    state.mines.push(mine);
  }
  function detonateMine(mine) {
    const index = state.mines.indexOf(mine);
    if (index >= 0) state.mines.splice(index, 1);
    state.effects.push({ x: mine.x, y: mine.y, radius: mine.radius, life: .4, mine: true });
    for (const enemy of state.enemies) {
      if (enemy.hp > 0 && distance(enemy, mine) < mine.radius + enemy.radius) {
        // Bigger bodies take more of the blast, which keeps mines relevant against tanks
        // and siege carriers without overkill on trash.
        hit(enemy, mine.damage * (1 + enemy.radius / 10), false);
      }
    }
    if (!mine.sub && rank('cluster') > 0) {
      for (let i = 0; i < 3; i++) {
        const angle = i * Math.PI * 2 / 3;
        state.mines.push({ x: mine.x + Math.cos(angle) * 34, y: mine.y + Math.sin(angle) * 34,
          radius: mine.radius * .55, damage: mine.damage * .5, arm: .2, sub: true });
      }
    }
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
    // Meltdown: a dying host vents half its radiation onto nearby enemies.
    if (rank('meltdown') > 0 && enemy.rad > 0) {
      for (const other of state.enemies) {
        if (other !== enemy && other.hp > 0 && distance(other, enemy) < 100 + other.radius) applyRad(other, Math.ceil(enemy.rad / 2));
      }
    }
    state.score += enemy.xp * 20; state.kills++; gainXP(enemy.xp);
    burst(enemy.x, enemy.y, enemy.color, enemy.type === 'boss' ? 50 : 12);
    state.effects.push({ x: enemy.x, y: enemy.y, life: .8, xp: enemy.xp });
    tone(150, .06, 'triangle', .025); updateUI();
  }
  function hit(enemy, damage, slow) {
    if (enemy.hp <= 0) return;
    // The crawl is not a kill. Shatter only when the stacks owed past the freeze are filled.
    if (cryoReadyToShatter(enemy)) damage += shatter(enemy);
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
  function damageBase(amount) {
    state.health = Math.max(0, state.health - amount);
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
    const weapon = state.weapons[0];
    const target = weaponTarget();
    if (weapon) {
      weapon.cooldown = Math.max(0, weapon.cooldown - dt);
      weapon.pendingBursts.forEach(volley => { volley.delay -= dt; });
      while (weapon.pendingBursts.length && weapon.pendingBursts[0].delay <= 1e-9) {
        const volley = weapon.pendingBursts.shift(), burstTarget = weaponTarget();
        if (!burstTarget) continue;
        weaponVolley(weapon.id, burstTarget, volley.parallel);
      }
      if (weapon.id === 'orbit' || weapon.id === 'twin') weapon.phase = (weapon.phase || 0) + dt * (2.2 + weaponRank('orbit') * .5);
      // Area weapons ignore aim; the reticle and facing only move for aimed weapons.
      if (target && weaponAims(weapon.id)) pilot.angle = Math.atan2(target.y - pilot.y, target.x - pilot.x);
      const autoFireOn = $('auto-fire').checked || keys.has('Space');
      if (autoFireOn) upgradeData(weapon.id).fire(weapon, target);
    }
    // Armed mines detonate on contact; unarmed charges are harmless until their timer ends.
    for (const mine of state.mines.slice()) {
      mine.arm -= dt;
      if (mine.arm > 0) continue;
      for (const enemy of state.enemies) {
        if (enemy.hp > 0 && distance(enemy, mine) < mine.radius + enemy.radius) { detonateMine(mine); break; }
      }
    }
    // Gravity: charged enemies are magnets. Pull is a real velocity stored on originX
    // and y, so a cluster collapses and stays piled instead of springing back to its
    // spawn lane. Charge never burns the carrier; damage happens only when bodies crush.
    if (rank('gravity') > 0 || rank('singularity') > 0) {
      const pullForce = gravityPullForce(), pullRange = gravityPullRange();
      for (const puller of state.enemies) {
        if (puller.hp <= 0 || !(puller.charge > 0)) continue;
        // Even a fresh charge gathers neighbours. Extra charge pulls harder.
        const speed = pullForce * (0.55 + 0.45 * (puller.charge / GRAVITY_MAX));
        for (const other of state.enemies) {
          if (other === puller || other.hp <= 0) continue;
          const dx = puller.x - other.x, dy = puller.y - other.y, span = Math.hypot(dx, dy);
          if (span > pullRange || span < 1e-6) continue;
          // Sqrt falloff still reaches the far side of a cluster without snapping it.
          const step = speed * Math.sqrt(1 - span / pullRange) * dt;
          other.originX += dx / span * step;
          other.y += dy / span * step * .55;
        }
      }
    }
    for (const enemy of state.enemies) {
      if (enemy.hp <= 0) continue;
      enemy.impactClock = Math.max(0, (enemy.impactClock || 0) - dt);
      // Slow stacks persist until the shatter; nothing decays here. Crawlers stay until
      // the stack gap is filled, so the field can bunch up behind them.
      if (enemy.rad > 0) damageOverTime(enemy, radDps(enemy) * dt);
      if (enemy.charge > 0) {
        // Charge is only a magnet. It expires, and it never burns the carrier on its own.
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
      // Frozen enemies keep swaying and creep at the crawl speed. They are a pile, not
      // statues: the shatter is a stack goal, so forward motion never hard-stops.
      enemy.time += dt;
      enemy.slow = Math.max(0, enemy.slow - dt); enemy.flash = Math.max(0, enemy.flash - dt);
      enemy.y += enemy.speed * enemySpeedFactor(enemy) * chillSpeedFactor(enemy) * dt;
      enemy.x = enemy.originX + Math.sin(enemy.time * (enemy.type === 'runner' ? 2 : .8)) * (enemy.type === 'boss' ? 45 : 16) + (enemy.driftX || 0);
      enemy.y += (enemy.driftY || 0) * dt;
      enemy.driftX = (enemy.driftX || 0) * .94;
      enemy.driftY = (enemy.driftY || 0) * .94;
      if (enemy.type === 'boss' && enemy.y > 0) {
        enemy.attackClock -= dt;
        if (enemy.attackClock <= 0) {
          const angle = Math.atan2(pilot.y - enemy.y, pilot.x - enemy.x);
          for (const spread of [-.24, 0, .24]) state.bullets.push({ x: enemy.x, y: enemy.y + 25, vx: Math.cos(angle + spread) * 145,
            vy: Math.sin(angle + spread) * 145, enemy: true, radius: 6, color: '#ff687e', life: 6, damage: 4 });
          enemy.attackClock = 2.3;
        }
      }
      if (distance(enemy, pilot) < enemy.radius + 15 && pilot.hitTimer <= 0) {
        pilot.hitTimer = 1; damageBase(3);
        if (state.phase !== 'combat') return;
        hit(enemy, 30, false); burst(pilot.x, pilot.y, '#65e5dd', 12);
      }
      if (enemy.hp > 0 && enemy.y > 623) { enemy.hp = 0; damageBase(enemy.damage); if (state.phase !== 'combat') return; }
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
          burst(bullet.x, bullet.y, bullet.splashColor, 12);
          if (bullet.weaponId === 'cryo') state.effects.push({ x: enemy.x, y: enemy.y, radius: bullet.splash, life: .4, cryo: true });
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
    // then irradiated enemies glow acid green, charged ones violet, then the normal slow.
    ctx.fillStyle = enemy.flash > 0 ? '#fff'
      : enemy.frozen ? '#d8f3ff'
      : enemy.chill > 0 ? '#a6d4ff'
      : enemy.rad > 0 ? '#a9e08a'
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
    // Frozen crawlers get a crystalline outline and the stacks still owed, so the
    // shatter grind is readable at a glance.
    if (enemy.frozen) {
      ctx.strokeStyle = '#e6faff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, enemy.radius + 5, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#e6faff'; ctx.font = 'bold 9px system-ui'; ctx.textAlign = 'center';
      ctx.fillText(String(cryoStacksRemaining(enemy)), 0, -enemy.radius - 16);
    }
    // Charged enemies show their pull strength as a violet halo, so the magnet is visible.
    if (enemy.charge > 0 && !enemy.frozen) {
      ctx.strokeStyle = '#c3a9ff'; ctx.globalAlpha = .35 + (enemy.charge / GRAVITY_MAX) * .45; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(0, 0, enemy.radius + 6, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // Radiation stacks read as tick marks around the rim plus the stack count, so the ramp
    // is legible: a boss with 30 stacks should look as dangerous to itself as it feels.
    if (enemy.rad > 0 && !enemy.frozen) {
      const ratio = Math.min(1, enemy.rad / RAD_MAX_STACKS);
      ctx.strokeStyle = '#a9e08a'; ctx.globalAlpha = .3 + ratio * .6; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(0, 0, enemy.radius + 7, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ratio); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#c9f5ab'; ctx.font = 'bold 9px system-ui'; ctx.textAlign = 'center';
      ctx.fillText(String(enemy.rad), 0, -enemy.radius - 16);
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
    // Ground hazards draw under the enemies so the field reads correctly.
    for (const mine of state.mines) {
      const armed = mine.arm <= 0;
      ctx.strokeStyle = armed ? '#ffcb78' : '#ffcb7866'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(mine.x, mine.y, 6, 0, Math.PI * 2); ctx.stroke();
      if (armed) {
        ctx.fillStyle = '#ffcb78'; ctx.beginPath(); ctx.arc(mine.x, mine.y, 2.5, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.strokeStyle = '#ffcb7855';
        ctx.beginPath(); ctx.arc(mine.x, mine.y, mine.radius * (1 - Math.min(1, mine.arm / .45)), 0, Math.PI * 2); ctx.stroke();
      }
    }
    for (const enemy of state.enemies) drawEnemy(enemy);
    const target = weaponTarget();
    const aimedId = state.weaponId ? activeWeaponId() : null;
    if (target && state.phase === 'combat' && aimedId && weaponAims(aimedId)) {
      ctx.strokeStyle = '#ffcb7880'; ctx.lineWidth = 1; ctx.setLineDash([4, 6]);
      ctx.beginPath(); ctx.arc(target.x, target.y, target.radius + 8, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    }
    for (const bullet of state.bullets) {
      ctx.fillStyle = bullet.color; ctx.shadowColor = bullet.color; ctx.shadowBlur = 7;
      ctx.beginPath(); ctx.ellipse(bullet.x, bullet.y, bullet.radius, bullet.enemy ? bullet.radius : 7, Math.atan2(bullet.vy, bullet.vx) + Math.PI / 2, 0, Math.PI * 2); ctx.fill();
    }
    ctx.shadowBlur = 0;
    const pilot = state.pilot;
    ctx.save(); ctx.translate(pilot.x, pilot.y); ctx.rotate(pilot.angle + Math.PI / 2);
    if (pilot.hitTimer > 0 && Math.floor(elapsed * 14) % 2) ctx.globalAlpha = .45;
    ctx.fillStyle = '#65e5dd55'; ctx.beginPath(); ctx.moveTo(-6, 14); ctx.lineTo(0, 23 + Math.sin(elapsed * 35) * 4); ctx.lineTo(6, 14); ctx.fill();
    ctx.fillStyle = '#65e5dd'; ctx.beginPath(); ctx.moveTo(0, -24); ctx.lineTo(10, -3); ctx.lineTo(22, 15); ctx.lineTo(7, 12); ctx.lineTo(0, 17); ctx.lineTo(-7, 12); ctx.lineTo(-22, 15); ctx.lineTo(-10, -3); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#cafff7'; ctx.beginPath(); ctx.moveTo(0, -15); ctx.lineTo(5, 3); ctx.lineTo(-5, 3); ctx.closePath(); ctx.fill();
    // Volley weapons draw one barrel per parallel round; other weapons use the plain hull.
    const barrelWeapon = isBulletWeapon(aimedId) ? aimedId : null;
    const barrels = barrelWeapon ? shotPattern(barrelWeapon).parallel : 1;
    for (let barrel = 0; barrel < barrels; barrel++) roundedRect((barrel - (barrels - 1) / 2) * 8 - 2, -20, 4, 17, 1, '#defffa');
    ctx.restore();
    for (const weapon of state.weapons) {
      if (weapon.id !== 'orbit' && weapon.id !== 'twin') continue;
      ctx.strokeStyle = '#b59dff33'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(pilot.x, pilot.y, orbitRadius(), 0, Math.PI * 2); ctx.stroke();
      const offsets = rank('twin') > 0 ? [0, Math.PI] : [0];
      for (const offset of offsets) {
        const drone = { x: pilot.x + Math.cos((weapon.phase || 0) + offset) * orbitRadius(), y: pilot.y + Math.sin((weapon.phase || 0) + offset) * orbitRadius() };
        // Faint hitbox so the drone's contact radius is readable.
        ctx.strokeStyle = '#b59dff22'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(drone.x, drone.y, ORBIT_HIT_RADIUS, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = '#b59dff'; ctx.shadowColor = '#b59dff'; ctx.shadowBlur = 8;
        ctx.beginPath(); ctx.arc(drone.x, drone.y, 6, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
      }
    }
    for (const p of state.particles) { ctx.globalAlpha = Math.max(0, p.life / .65); ctx.fillStyle = p.color; ctx.fillRect(p.x - 2, p.y - 2, 3, 3); }
    ctx.globalAlpha = 1;
    for (const effect of state.effects) {
      // The effect union is tagged: the beam carries its own geometry instead of a radius.
      if (effect.beam) {
        ctx.globalAlpha = Math.max(0, effect.life / .12); ctx.strokeStyle = '#b9fff9'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(effect.x, effect.y);
        ctx.lineTo(effect.x + Math.cos(effect.angle) * effect.length, effect.y + Math.sin(effect.angle) * effect.length); ctx.stroke();
        continue;
      }
      ctx.globalAlpha = Math.min(1, effect.life * 2);
      if (effect.xp) { ctx.fillStyle = '#ffcb78'; ctx.font = 'bold 11px system-ui'; ctx.fillText('+' + effect.xp + ' XP', effect.x, effect.y - (1 - effect.life / .8) * 28); }
      else { ctx.strokeStyle = effect.mine ? '#ffcb78' : effect.cryo ? '#a6d4ff' : '#65e5dd'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(effect.x, effect.y, effect.radius * (1 - effect.life / .4), 0, Math.PI * 2); ctx.stroke(); }
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
