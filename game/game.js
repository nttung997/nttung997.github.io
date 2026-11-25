(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const canvas = $('field'), ctx = canvas.getContext('2d');
  const W = 480, H = 680, MAX_ALIVE = 40, THREAT_RATE = 30, BOSS_EVERY = 4;
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  // Singularity's evolution bonuses, shared by the mechanics and the UI copy so the numbers
  // the player reads can never drift from the numbers the game uses.
  const SINGULARITY_PULL = 1.6, SINGULARITY_RANGE = 1.35;
  // The collapse well: every fourth volley opens a timed well that drags the pile into a
  // point and implodes. Pull and range are stronger multipliers on the magnet's own
  // constants, and the implosion scales with the radius² volume it swallowed.
  const SINGULARITY_WELL_EVERY = 4, SINGULARITY_WELL_LIFE = 1.2, SINGULARITY_WELL_RADIUS = 170;
  const SINGULARITY_WELL_PULL = 2.2, SINGULARITY_WELL_RANGE = 1.15;
  // Implosion: the crush scales with how many bodies were swallowed, so a full pile is
  // cleared instead of nudged. `CROWD` is how many extra bodies double the damage; `CORE`
  // is the radius saturated to max charge so the crush loop pays out immediately.
  const SINGULARITY_WELL_DAMAGE = 110, SINGULARITY_WELL_CROWD = 2, SINGULARITY_WELL_CORE = 60;
  // Effects feed one master gain. Mute and the volume slider act there, never by tearing
  // the graph down. There is no music.
  const AUDIO_DEFAULTS = { volume: 1, sound: true };
  // One knob for how loud every effect is before the player's slider. The slider still
  // scales the master on top of this.
  const SFX_LEVEL = 80;
  // One voice per volley, so a rank-5 nine-round volley costs one sound rather than nine.
  const SHOT_TONES = {
    blaster: [650, .025, 'triangle', .009],
    gravity: [360, .05, 'sine', .008],
    cryo: [700, .04, 'sine', .01],
    rad: [620, .03, 'triangle', .008]
  };
  // Per-key rate limits in seconds. A mass kill or a belted field must not stack a dozen
  // voices into one frame.
  const SFX_GAP = { shot: .04, kill: .03, hit: .09, ui: .08, shatter: .05, mine: .05, blast: .07 };
  const SFX_KILL_PITCH = { drone: 150, runner: 220, tank: 110, boss: 70 };
  // One unified weapon system. A run locks exactly one of six weapons; its rank lives in
  // state.build[weaponId] and its evolution replaces the base at max rank plus one paired
  // passive. Passives are shared by every weapon, so the level-up pool is passives plus
  // the locked weapon's next rank plus its evolution once the gate is met.
  const upgrades = {
    pierce: { name: 'Phase rounds', icon: '➶', max: 3, description: 'Each projectile passes through one more enemy and asteroid-belt rocks grind faster. Exclusive with Volatile rounds.' },
    blast: { name: 'Volatile rounds', icon: '◈', max: 3, description: 'Projectiles explode on impact and asteroid-belt rocks detonate on contact. Each rank increases the blast radius. Exclusive with Phase rounds.' },
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
      fire(weapon, target) {
        if (firePattern(weapon, target, 'blaster', fireInterval())) shotSound('blaster');
      }
    },
    gravity: {
      name: 'Gravity', icon: '◉', tag: 'GRAVITY', max: 5, interval: 1,
      description: 'Aimed rounds charge enemies; ranks widen the volley and add bursts. Charged enemies pull each other together, collide as solid bodies, and crush on contact.',
      fire(weapon, target) {
        if (!firePattern(weapon, target, 'gravity', 1)) return false;
        shotSound('gravity');
        return true;
      }
    },
    cryo: {
      name: 'Cryo', icon: '❆', tag: 'CRYO', max: 5, interval: .9,
      description: 'Aimed frost volleys (1×1, 1×2, 2×2, 2×3, 3×3 at ranks 1–5) that stack slow on impact and in a burst. Each stack slows less than the last. At speed 10 the target crawls; the shatter waits longer as threat and the volley grow. No direct damage.',
      fire(weapon, target) {
        if (firePattern(weapon, target, 'cryo', .9)) shotSound('cryo');
      }
    },
    rad: {
      name: 'Rad', icon: '☣', tag: 'RAD', max: 5, interval: 1,
      description: 'Aimed rounds add permanent radiation stacks; ranks widen the volley and add bursts. Damage ramps with every stack, and auto-aim targets the enemy about to leak.',
      fire(weapon, target) {
        if (firePattern(weapon, target, 'rad', 1)) shotSound('rad');
      }
    },
    orbit: {
      name: 'Asteroid belt', icon: '☄', tag: 'BELT', max: 5, interval: .25,
      description: 'Rocks orbit your defender and grind enemies they touch. Ranks add rocks. No aim required. Evolves into the Planetary ring.',
      fire(weapon) {
        const damage = orbitDamage(), rocks = orbitRockPositions(weapon);
        const interval = orbitHitInterval(), splash = orbitSplashRadius();
        for (const enemy of state.enemies) {
          if (enemy.hp <= 0 || enemy.y < 0 || (enemy.orbitClock || 0) > 0) continue;
          for (const rock of rocks) {
            if (Math.hypot(enemy.x - rock.x, enemy.y - rock.y) > ORBIT_ROCK_RADIUS + enemy.radius) continue;
            // Bigger bodies grind harder, so tanks and siege carriers stay relevant
            // without overkill on trash.
            hit(enemy, damage * (1 + enemy.radius / 20));
            enemy.orbitClock = interval;
            // Volatile rounds: the rock detonates on contact, chipping everything around it.
            if (splash) {
              state.effects.push({ x: rock.x, y: rock.y, radius: splash, life: .4, belt: true });
              for (const nearby of state.enemies) {
                if (nearby === enemy || nearby.hp <= 0 || distance(nearby, rock) > splash + nearby.radius) continue;
                hit(nearby, orbitSplashDamage() * (1 + nearby.radius / 20));
              }
            }
            state.particles.push({ x: rock.x, y: rock.y, vx: 0, vy: 0, life: .2, color: '#c9b6ff' });
            sfx('hit', 520, .02, 'square', .004);
            break;
          }
        }
      }
    },
    mines: {
      name: 'Mines', icon: '✸', tag: 'MINES', max: 5, interval: 1,
      description: 'Drops armed charges behind you that roll with your momentum. Enemies that touch a charge take blast damage. Phase rounds reach out, Volatile rounds leave the ground hot.',
      fire(weapon) {
        if (weapon.cooldown > 1e-9) return;
        const pilot = state.pilot, rankNow = mineRank();
        // Spread drops across a rear arc so a stationary build covers the whole lane.
        weapon.phase = ((weapon.phase || 0) + 1) % 5;
        // From rank 4 the layer drops two charges per cycle into mirrored slots, so the arc
        // fills twice as fast without changing the cadence.
        const slots = rankNow >= 4 ? [weapon.phase, (weapon.phase + 3) % 5] : [weapon.phase];
        for (const slot of slots) dropMine(mineAt(pilot, (slot - 2) * MINE_LATERAL, rankNow));
        weapon.cooldown = weapons.mines.interval; mineDropSound();
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
          hit(enemy, arcDamage());
        }
        state.effects.push({ x: pilot.x, y: pilot.y, angle, length: ARC_RANGE, life: .12, beam: true });
        weapon.cooldown = ARC_INTERVAL; sfx('shot', 900, .02, 'sawtooth', .004);
      }
    },
    singularity: {
      name: 'Singularity', icon: '◉', tag: 'SINGULARITY', max: 1, interval: 1, from: 'gravity', requires: 'blast',
      description: 'Gravity rounds gain a ' + SINGULARITY_PULL + '× pull force over a ' + SINGULARITY_RANGE + '× wider range, and every ' + SINGULARITY_WELL_EVERY + 'th volley opens a collapse well that drags the pile into a point and implodes it.',
      ready: () => evolutionReady('singularity', 'gravity', 'blast'),
      fire(weapon, target) {
        // The volley counter lives on the weapon instance, which syncWeapons() recreates on
        // evolution, so it starts at zero without any reset code.
        if (!weapons.gravity.fire(weapon, target)) return;
        weapon.volleys = (weapon.volleys || 0) + 1;
        if (weapon.volleys % SINGULARITY_WELL_EVERY === 0) openWell(target.x, target.y);
      }
    },
    absolute: {
      name: 'Absolute zero', icon: '❄', tag: 'ABSOLUTE ZERO', max: 1, interval: .9, from: 'cryo', requires: 'blast',
      description: 'When an enemy starts crawling, one slow stack spills onto nearby enemies.',
      ready: () => evolutionReady('absolute', 'cryo', 'blast'),
      fire(weapon, target) { weapons.cryo.fire(weapon, target); }
    },
    meltdown: {
      name: 'Meltdown', icon: '☢', tag: 'MELTDOWN', max: 1, interval: 1, from: 'rad', requires: 'pierce',
      description: 'Radiation ticks faster and spreads to nearby enemies when a host dies.',
      ready: () => evolutionReady('meltdown', 'rad', 'pierce'),
      fire(weapon, target) { weapons.rad.fire(weapon, target); }
    },
    twin: {
      name: 'Planetary ring', icon: '◍', tag: 'RING', max: 1, interval: .25, from: 'orbit', requires: 'blast',
      description: 'A full belt of six rocks encircles the defender, spinning faster and grinding harder.',
      ready: () => evolutionReady('twin', 'orbit', 'blast'),
      fire(weapon) { weapons.orbit.fire(weapon); }
    },
    cluster: {
      name: 'Cluster mines', icon: '✹', tag: 'CLUSTER MINES', max: 1, interval: 1, from: 'mines', requires: 'blast',
      description: 'Detonating a charge scatters two smaller sub-charges around the blast.',
      ready: () => evolutionReady('cluster', 'mines', 'blast'),
      fire(weapon) { weapons.mines.fire(weapon); }
    }
  };
  const EVOLUTION_IDS = Object.keys(evolutions);
  const upgradeData = id => upgrades[id] || weapons[id] || evolutions[id];
  const keys = new Set();
  let state, paused = false, pointer = null, last = 0, elapsed = 0, bannerTimer;
  let soundEnabled = AUDIO_DEFAULTS.sound, volume = AUDIO_DEFAULTS.volume;
  let best = 0;
  try { best = Number(localStorage.getItem('skyhold-survivor-best')) || 0; } catch { /* Storage is optional. */ }
  const SETTINGS_KEY = 'skyhold-survivor-settings';
  let autoFire = true;
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if (typeof saved.autoFire === 'boolean') autoFire = saved.autoFire;
    // Older saves may still carry `music`; it is ignored. Missing keys fall back to defaults.
    if (typeof saved.sound === 'boolean') soundEnabled = saved.sound;
    if (typeof saved.volume === 'number' && Number.isFinite(saved.volume)) volume = clamp(saved.volume, 0, 1);
  } catch { /* Settings are optional. */ }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ autoFire, sound: soundEnabled, volume })); } catch { /* Play without persistence. */ }
  }
  const stars = Array.from({ length: 65 }, (_, i) => ({ x: (i * 137.7) % W, y: (i * 83.3) % H, size: i % 4 === 0 ? 1.6 : .8 }));
  const rank = id => state.build[id] || 0;
  const nextLevelXP = level => 18 + (level - 1) * 12;
  const weaponDamage = () => 40;
  const fireInterval = () => 1;
  // The Arc laser ticks five times a second, so its per-tick damage is scaled down to land
  // in the same band as the other weapons while paying for its piercing line.
  const arcDamage = () => weaponDamage() * .5;
  const ARC_INTERVAL = .2, ARC_RANGE = 620, ARC_HALF_WIDTH = 12;
  const orbitDamage = () => (weaponDamage() * .9 + (weaponRank('orbit') - 1) * 12) * (rank('twin') > 0 ? 1.25 : 1);
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
  const moveSpeed = () => 270;
  const spawnDelay = threat => Math.max(.3, 1.2 - threat * .06);

  function reset() {
    state = { phase: 'ready', weaponId: null, health: 100, score: 0, kills: 0, level: 1, xp: 0, build: {},
      enemies: [], bullets: [], mines: [], burns: [], wells: [], particles: [], effects: [], spawnClock: .6,
      pilot: { x: 240, y: 545, hitTimer: 0, angle: -Math.PI / 2, vx: 0, vy: 0 },
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
    renderAudioUI();
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
    // Combat start is a gesture-driven event, so it is the safe place to open the audio graph.
    unlockAudio();
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
      case 'gravity': return gravityImpact().toFixed(0);
      case 'singularity': return 'PULL ×' + SINGULARITY_PULL + ' · RANGE ×' + SINGULARITY_RANGE;
      case 'cryo': case 'absolute': return 'SLOW';
      case 'rad': case 'meltdown': return radDpsPerStack().toFixed(1) + '/stack';
      case 'orbit': case 'twin': return orbitDamage().toFixed(0) + '/hit';
      case 'mines': case 'cluster': return mineDamage().toFixed(0);
      default: return '—';
    }
  }
  function shotLabel(id) {
    if (isBulletWeapon(id)) {
      const pattern = shotPattern(id);
      const cadence = pattern.bursts + '×' + pattern.parallel;
      // Singularity's cadence is the well: the pattern only says what the volley carries.
      return id === 'singularity' ? cadence + ' · WELL / ' + SINGULARITY_WELL_EVERY + 'th' : cadence;
    }
    return ({ arc: 'BEAM', orbit: 'BELT', twin: 'RING', mines: 'TRAP', cluster: 'TRAP' })[id] || '—';
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
        gravity: 'gravity rounds · charged enemies magnetise and collide',
        singularity: 'gravity rounds · ' + SINGULARITY_PULL + '× pull force over ' + SINGULARITY_RANGE
          + '× range · every ' + SINGULARITY_WELL_EVERY + 'th volley opens a ' + SINGULARITY_WELL_RADIUS
          + ' px well for ' + SINGULARITY_WELL_LIFE + 's, then implodes',
        rad: 'radiation rounds · stacks scale the burn',
        meltdown: 'radiation rounds · stacks scale the burn'
      }[id];
      return bullets + ' round' + (bullets === 1 ? '' : 's') + ' per cycle · bursts × parallel; ' + note;
    }
    return ({
      arc: 'arc laser · pierces every enemy in the aim line, 5 ticks per second',
      orbit: 'asteroid belt · ' + orbitRockCount() + ' rock' + (orbitRockCount() === 1 ? '' : 's') + ' in orbit, contact damage, no aiming',
      twin: 'planetary ring · ' + orbitRockCount() + ' rocks, faster spin, harder contact',
      mines: 'mine layer · ' + (mineRank() >= 4 ? '2 charges' : '1 charge') + ' per drop · cap ' + mineCap()
        + ' · charges roll with your momentum'
        + (rank('pierce') > 0 ? ' · phase fuse' : rank('blast') > 0 ? ' · volatile burn' : ''),
      cluster: 'cluster mines · detonations scatter sub-charges that inherit the blast'
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
      // A well evolution names its extra cadence on a second line, so the moment the run
      // evolves the build list itself says what changed.
      if (id === 'singularity') {
        const line = document.createElement('p'); line.className = 'loadout-detail';
        line.textContent = 'Collapse well every ' + SINGULARITY_WELL_EVERY + 'th volley · '
          + SINGULARITY_WELL_RADIUS + ' px · ' + SINGULARITY_WELL_LIFE + 's · implodes on expiry';
        loadout.append(line);
      }
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
    const blocked = id => {
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
    sfx('ui', 880, .16);
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
    // because x is recomputed from originX each frame. vx/vy are Gravity's collision
    // velocity, kept separate so drift semantics stay in place for the other weapons.
    state.enemies.push({ ...data, type, maxHp: data.hp, x, originX: x, y: -50, time: 0, flash: 0, attackClock: 2,
      chill: 0, cryoStacks: 0, cryoFreezeStacks: 0, frozen: false, rad: 0, charge: 0, chargeTimer: 0, driftX: 0, driftY: 0, vx: 0, vy: 0, impactClock: 0, orbitClock: 0 });
  }
  function aimTarget() {
    return state.enemies.reduce((nearest, enemy) => enemy.hp > 0 && enemy.y >= 0 && enemy.y < 623 &&
      (!nearest || distance(state.pilot, enemy) < distance(state.pilot, nearest)) ? enemy : nearest, null);
  }
  const BASE_LINE = 623;
  function advanceSpeed(enemy) {
    return enemy.speed * chillSpeedFactor(enemy);
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
  const ORBIT_ROCK_RADIUS = 11;
  // Per-enemy contact cooldown: a rock resting on a body cannot tick every frame.
  const ORBIT_HIT_INTERVAL = .25;
  const ORBIT_ROCKS_BY_RANK = [1, 2, 3, 4, 5];
  const ORBIT_EVOLVED_ROCKS = 6;
  // The belt orbits wide enough to cover the defender's own position, and ranks add rocks
  // rather than widening the lane. Positions are derived from the weapon phase so the
  // damage path and the draw path can never disagree.
  const orbitRadius = () => 52 + weaponRank('orbit') * 8;
  const orbitRockCount = () => rank('twin') > 0
    ? ORBIT_EVOLVED_ROCKS
    : ORBIT_ROCKS_BY_RANK[clamp(weaponRank('orbit'), 1, ORBIT_ROCKS_BY_RANK.length) - 1];
  const orbitSpin = () => 2.2 + weaponRank('orbit') * .5 + (rank('twin') > 0 ? 1.2 : 0);
  // Phase rounds make a phased rock strike the same body again sooner, so the belt's
  // damage passive is a real grind-rate upgrade instead of a dead projectile modifier.
  const orbitHitInterval = () => Math.max(.1, ORBIT_HIT_INTERVAL - rank('pierce') * .04);
  // Volatile rounds turn each contact into a small detonation, so blast gives the belt
  // area coverage; it is also the evolution gate, and now the card does something.
  const orbitSplashRadius = () => rank('blast') ? 30 + rank('blast') * 14 : 0;
  const orbitSplashDamage = () => orbitDamage() * .45;
  const ORBIT_ELLIPSE_X = 1.16, ORBIT_ELLIPSE_Y = .84;
  function orbitRockSpecs() {
    if (rank('twin') > 0) {
      // Planetary ring: two trios on nested elliptical lanes, spinning opposite ways.
      const outer = orbitRadius() + 10, inner = orbitRadius() - 14, specs = [];
      for (let index = 0; index < 3; index++) {
        specs.push({ dir: 1, rx: outer * ORBIT_ELLIPSE_X, ry: outer * ORBIT_ELLIPSE_Y, offset: index * Math.PI * 2 / 3 });
        specs.push({ dir: -1, rx: inner * ORBIT_ELLIPSE_X, ry: inner * ORBIT_ELLIPSE_Y, offset: index * Math.PI * 2 / 3 + Math.PI / 3 });
      }
      return specs;
    }
    const radius = orbitRadius(), count = orbitRockCount();
    return Array.from({ length: count }, (_, index) => ({ dir: 1, rx: radius, ry: radius, offset: index * Math.PI * 2 / count }));
  }
  function orbitLanes() {
    const seen = new Set(), lanes = [];
    for (const spec of orbitRockSpecs()) {
      const key = spec.rx.toFixed(2) + ':' + spec.ry.toFixed(2);
      if (seen.has(key)) continue;
      seen.add(key); lanes.push({ rx: spec.rx, ry: spec.ry });
    }
    return lanes;
  }
  function orbitRockPositions(weapon, phaseDelta = 0) {
    const phase = (weapon.phase || 0) + phaseDelta;
    return orbitRockSpecs().map(spec => {
      const angle = spec.offset + spec.dir * phase;
      return { x: state.pilot.x + Math.cos(angle) * spec.rx, y: state.pilot.y + Math.sin(angle) * spec.ry, angle };
    });
  }
  // Every frost round carries two slow stacks; rank widens the five-step volley pattern
  // instead of inflating each round. Slow potency is per-enemy, from cryoSlowPerStack.
  const cryoStacksPerHit = () => 2;
  const cryoBurstRadius = () => 56 + weaponRank('cryo') * 8;
  const mineRank = () => clamp(weaponRank('mines'), 1, MINE_RANKS.length);
  const mineStats = () => MINE_RANKS[mineRank() - 1];
  const mineDamage = () => mineStats().damage;
  const mineRadius = () => mineStats().radius;
  // A dropped charge inherits the pilot's velocity, scaled by rank, so a moving drop travels.
  // The roll speed is capped at the read site so an edge snap or reset cannot fling a charge.
  function mineAt(pilot, lateral, rankNow) {
    const rollScale = 1 + (rankNow - 1) * MINE_ROLL_RANK_BONUS;
    const speed = Math.min(MINE_ROLL_CAP, Math.hypot(pilot.vx || 0, pilot.vy || 0) * rollScale);
    const heading = speed > 1e-6 ? Math.atan2(pilot.vy, pilot.vx) : pilot.angle;
    return { x: clamp(pilot.x - Math.cos(pilot.angle) * 24 - Math.sin(pilot.angle) * lateral, 18, W - 18),
      y: clamp(pilot.y - Math.sin(pilot.angle) * 24 + Math.cos(pilot.angle) * lateral, 64, H - 70),
      vx: Math.cos(heading) * speed, vy: Math.sin(heading) * speed,
      radius: mineRadius(), damage: mineDamage(), arm: MINE_ARM, sub: false };
  }
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
  // Gravity bodies are solid. Separation removes a share of the overlap per second, so the
  // magnet's inward pull and this correction settle into a small residual squeeze instead of
  // collapsing every body onto one point. The squeeze is what deals the crush damage.
  const COLLISION_STIFFNESS = 45, COLLISION_BOUNCE = 7, COLLISION_DAMPING = 5;
  const COLLISION_MAX_SPEED = 320, COLLISION_SLOP = .5;
  // Mines are ground hazards. Every number the copy quotes lives here so tuning never
  // touches the mechanics: per-rank blast damage and radius, the drop arc width, the arming
  // delay, the live-charge cap, and the kinetic-roll constants.
  const MINE_RANKS = [
    { damage: 32, radius: 110 },
    { damage: 46, radius: 122 },
    { damage: 60, radius: 134 },
    { damage: 74, radius: 146 },
    { damage: 88, radius: 158 }
  ];
  const MINE_ARM = .45;
  const MINE_LATERAL = 40;
  // The cap rises once the five-rank track is complete, so a maxed layer keeps more traps live.
  const MINE_CAP = 6, MINE_CAP_MAXED = 9;
  // Kinetic roll: a charge dropped while moving inherits the pilot's velocity and skids to a
  // stop before it arms. Friction is a flat decel, and the cap keeps a full-sprint drop from
  // crossing the arena. Roll distance scales with rank so ranking the layer has a movement payoff.
  // At the 270 px/s walk speed this carries a charge roughly 90 px before it stops.
  const MINE_ROLL_FRICTION = 400, MINE_ROLL_CAP = 520, MINE_ROLL_RANK_BONUS = .18;
  // Phase rounds: a proximity fuse trips a charge before a body touches its core. Volatile
  // rounds: a wider blast plus a short burn patch left on the ground.
  const MINE_FUSE_BASE = 14, MINE_FUSE_PER_RANK = 10;
  const MINE_VOLATILE_RADIUS = 12;
  const MINE_BURN_SECONDS = 1.4, MINE_BURN_INTERVAL = .2;
  // Cluster mines: sub-charges inherit the parent's resolved blast instead of a fixed half.
  // Two per detonation, drawn smaller and hotter so a chained blast reads as a different object.
  const CLUSTER_SUBS = 2;
  const CLUSTER_RADIUS_FRACTION = .45, CLUSTER_DAMAGE_FRACTION = .5;
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
            if (cryoReadyToShatter(other)) hit(other, 0);
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
    burst(enemy.x, enemy.y, '#a6ceff', 20); sfx('shatter', 880, .08, 'triangle', .02);
    state.score += 30;
    return lethal;
  }
  // Chill multiplies movement. Once the crawl starts, speed floors at the threshold so
  // extra stacks do not stop the enemy.
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
  const radDpsPerStack = () => weaponDamage() * (rank('meltdown') > 0 ? .15 : .1);
  const radStacks = enemy => enemy.rad || 0;
  const radDps = enemy => radStacks(enemy) * radDpsPerStack();
  // Gravity pays no direct damage and no burn. Charge only pulls; the damage is the
  // crush when a charged enemy overlaps another. A lone charged enemy is harmless.
  const gravityImpact = () => weaponDamage() * 1.4;
  const gravityCrush = () => weaponDamage() * .9;
  // Singularity's evolution bonuses scale the pull; the constants live at the top of the IIFE
  // because the evolution registry above needs them too.
  const gravityPullForce = () => GRAVITY_PULL * (rank('singularity') > 0 ? SINGULARITY_PULL : 1);
  const gravityPullRange = () => GRAVITY_RANGE * (rank('singularity') > 0 ? SINGULARITY_RANGE : 1);
  const wellPullForce = () => gravityPullForce() * SINGULARITY_WELL_PULL;
  const wellPullRange = () => SINGULARITY_WELL_RADIUS * SINGULARITY_WELL_RANGE;
  // A well is a timed world entity, not an effect: effects decay in a draw-only loop and
  // cannot affect the simulation. It is opened by the Singularity fire path and lives in
  // state.wells so a restart clears it with the rest of the run.
  function openWell(x, y) {
    state.wells.push({ x, y, radius: SINGULARITY_WELL_RADIUS, life: SINGULARITY_WELL_LIFE,
      maxLife: SINGULARITY_WELL_LIFE, swallowed: new Set() });
    state.effects.push({ x, y, radius: SINGULARITY_WELL_RADIUS, life: .4, well: true });
    sfx('ui', 120, .2, 'sine', .02);
  }
  // While the well is alive it hauls every live body in on the sqrt falloff, harder and
  // wider than the ordinary magnet, and saturates the bodies it reaches so the crush loop
  // pays out at once. Expiry implodes through damageOverTime() so the single death guard
  // owns kill credit.
  function updateWells(dt) {
    if (!state.wells.length) return;
    // Wells exist only in a Singularity run, but the evolution is checked at the read site
    // so a stale well from another run can never pull or crush.
    const owned = rank('singularity') > 0;
    const force = wellPullForce(), range = wellPullRange();
    for (const well of state.wells.slice()) {
      well.life -= dt;
      if (well.life > 0) {
        if (!owned) continue;
        for (const enemy of state.enemies) {
          if (enemy.hp <= 0) continue;
          const dx = well.x - enemy.x, dy = well.y - enemy.y, span = Math.hypot(dx, dy);
          if (span > range) continue;
          well.swallowed.add(enemy);
          // Saturate the core so a swallowed body is already a magnet when the implosion lands.
          if (span <= SINGULARITY_WELL_CORE) { enemy.charge = GRAVITY_MAX; enemy.chargeTimer = GRAVITY_LIFE; }
          if (span < 1e-6) continue;
          const step = force * Math.sqrt(1 - span / range) * dt;
          enemy.originX += dx / span * step;
          enemy.y += dy / span * step * .55;
        }
        continue;
      }
      // Expiry is unconditional: the well leaves state.wells even with nobody inside it.
      state.wells.splice(state.wells.indexOf(well), 1);
      if (!owned) continue;
      state.effects.push({ x: well.x, y: well.y, radius: well.radius, life: .4, well: true });
      burst(well.x, well.y, '#c3a9ff', 24);
      sfx('ui', 90, .25, 'sawtooth', .03);
      // One radius pass, falling off with distance and scaled by the volume it swallowed,
      // so a full pile is cleared rather than nudged.
      const crush = SINGULARITY_WELL_DAMAGE * (1 + well.swallowed.size / SINGULARITY_WELL_CROWD);
      for (const enemy of state.enemies) {
        if (enemy.hp <= 0) continue;
        const span = distance(enemy, well), reach = well.radius + enemy.radius;
        if (span > reach) continue;
        damageOverTime(enemy, crush * (1 - span / reach) * (1 + enemy.radius / 20));
      }
    }
  }

  function applyGravity(enemy, charges) {
    enemy.charge = Math.min(GRAVITY_MAX, (enemy.charge || 0) + charges);
    enemy.chargeTimer = GRAVITY_LIFE;
  }
  // Gravity runs make every enemy a solid body. The pull keeps writing originX/y, so bodies
  // still gather; this pass stops them occupying one point by separating overlaps by mass
  // and turning a squeeze into a rebound. Damage keeps the old rule: at least one charged
  // participant, and only that participant's charge scales it.
  function resolveGravityCollisions(dt) {
    if (!(rank('gravity') > 0 || rank('singularity') > 0)) return;
    const approach = 1 - Math.exp(-COLLISION_STIFFNESS * dt);
    const damping = Math.exp(-COLLISION_DAMPING * dt);
    const enemies = state.enemies;
    for (let i = 0; i < enemies.length; i++) {
      const a = enemies[i];
      if (a.hp <= 0) continue;
      for (let j = i + 1; j < enemies.length; j++) {
        const b = enemies[j];
        if (b.hp <= 0) continue;
        const dx = b.x - a.x, dy = b.y - a.y, span = Math.hypot(dx, dy);
        const minDist = a.radius + b.radius;
        if (span > minDist) continue;
        // Exactly stacked bodies have no normal. Resolve deterministically, alternating by
        // index, because Math.random() ordering is part of the seeded test contract.
        const nx = span < 1e-6 ? ((i + j) & 1 ? 1 : -1) : dx / span;
        const ny = span < 1e-6 ? 0 : dy / span;
        const overlap = minDist - span;
        // Mass is an area proxy, so a boss shoves trash instead of being shoved by it.
        const ma = a.radius * a.radius, mb = b.radius * b.radius, total = ma + mb;
        if (overlap > COLLISION_SLOP) {
          const correction = Math.min(overlap - COLLISION_SLOP, 8) * approach;
          a.originX -= nx * correction * (mb / total); a.y -= ny * correction * (mb / total);
          b.originX += nx * correction * (ma / total); b.y += ny * correction * (ma / total);
        }
        // Only a magnet squeezes: bounce and crush both need a charged participant.
        const strength = Math.max(a.charge || 0, b.charge || 0);
        if (strength <= 0) continue;
        // Solid bodies cap how many pairs one body can touch, so a low charge must still
        // hurt; otherwise the pile spreads and a single charged round does nothing. The
        // same partial-charge curve as the pull keeps contact damage useful from 1 charge.
        const scale = .55 + .45 * (strength / GRAVITY_MAX);
        damageOverTime(a, gravityCrush() * scale * dt);
        damageOverTime(b, gravityCrush() * scale * dt);
        // The rebound is proportional to the squeeze, so a charged contact knocks its
        // neighbour and a chain of bodies spreads instead of stacking. Impulse is
        // mass-weighted: trash cannot shove a siege carrier toward the base.
        const push = Math.min(overlap, 6) * COLLISION_BOUNCE * scale;
        a.vx -= nx * push * (mb / total); a.vy -= ny * push * (mb / total);
        b.vx += nx * push * (ma / total); b.vy += ny * push * (ma / total);
        if (overlap > 1 && a.impactClock <= 0 && b.impactClock <= 0) {
          const impact = gravityImpact() * scale;
          hit(a, impact); hit(b, impact);
          a.impactClock = .5; b.impactClock = .5;
          state.particles.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, vx: 0, vy: 0, life: .25, color: '#c3a9ff' });
        }
      }
    }
    for (const enemy of enemies) {
      enemy.vx = clamp((enemy.vx || 0) * damping, -COLLISION_MAX_SPEED, COLLISION_MAX_SPEED);
      enemy.vy = clamp((enemy.vy || 0) * damping, -COLLISION_MAX_SPEED, COLLISION_MAX_SPEED);
    }
  }
  // Bullets carry their weapon id; the weapon decides what contact means.
  function applyBulletHit(enemy, bullet) {
    if (bullet.weaponId === 'rad') { applyRad(enemy, bullet.stacks || 1); enemy.flash = Math.max(enemy.flash, .05); }
    else if (bullet.weaponId === 'gravity') { applyGravity(enemy, bullet.charges || 1); enemy.flash = Math.max(enemy.flash, .05); }
    else if (bullet.weaponId === 'cryo') {
      // Frost rounds only add slow stacks. hit(0) is the execute check: it shatters only
      // when this round fills the stack gap past the crawl.
      applyChill(enemy, bullet.stacks || 1);
      hit(enemy, 0);
    }
    else hit(enemy, bullet.damage);
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
    const predicted = { x: target.x, y: target.y + target.speed * flightTime };
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
        pierce: options.pierce || 0,
        hitEnemies: new Set(), color: options.color,
        radius: options.radius || 3, life: 2, enemy: false });
    }
  }
  // One sound per volley, owned by the weapon that fired it. The old shared tone here doubled
  // up with the per-weapon tones, so Gravity, Cryo, and Rad played twice on every shot.
  function shotSound(id) {
    const [frequency, duration, type, gain] = SHOT_TONES[id] || [650, .025, 'triangle', .009];
    sfx('shot', frequency, duration, type, gain);
  }
  // A drop is a clack, not a shot: one low thud and a short arming tick, even when rank 4
  // lays two charges. The boom is separate, so a blast is audible when it kills nothing.
  // A sub-charge pops higher and shorter than the parent.
  function mineDropSound() {
    if (!admit('mine')) return;
    tone(120, .07, 'square', .009);
    tone(480, .028, 'triangle', .004, .04);
  }
  function mineBlastSound(mine) {
    if (!admit('blast')) return;
    const sub = !!(mine && mine.sub);
    tone(sub ? 150 : 72, sub ? .09 : .2, sub ? 'square' : 'sawtooth', sub ? .005 : .009);
    noiseBurst(sub ? .07 : .16, sub ? .003 : .005, sub ? 1800 : 640);
  }
  function fireVolley(target, parallel) {
    fireRounds(target, { weaponId: 'blaster', parallel, damage: weaponDamage(),
      splash: rank('blast') ? 28 + rank('blast') * 12 : 0,
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
      radius: 4, pierce: rank('pierce'),
      splash: 34 + rankNow * 8 + (rank('blast') ? 28 + rank('blast') * 12 : 0) });
  }
  function fireRadVolley(target, parallel) {
    fireRounds(target, { weaponId: 'rad', parallel, stacks: 2 + Math.min(weaponRank('rad'), 3), color: '#a9e08a',
      radius: 4, pierce: rank('pierce'),
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
  // Mines are ground hazards. A charge rolls to a stop, then arms; only an armed charge can
  // detonate, and detonation routes through hit()/damageOverTime() so the death guard owns
  // kill credit. Phase adds a proximity fuse, Volatile adds blast and a burn patch, Cluster
  // scatters one generation of sub-charges through the same drop path.
  const mineCap = () => mineRank() >= weapons.mines.max ? MINE_CAP_MAXED : MINE_CAP;
  const mineFuse = () => rank('pierce') > 0 ? MINE_FUSE_BASE + rank('pierce') * MINE_FUSE_PER_RANK : 0;
  // Sub-charges carry their radius baked from the parent's resolved blast, so Volatile is
  // applied exactly once (at the parent) instead of being added again per sub.
  const mineBlastRadius = mine => mine.radius + (mine.sub || rank('blast') <= 0 ? 0 : MINE_VOLATILE_RADIUS * rank('blast'));
  function dropMine(mine) {
    if (state.mines.length >= mineCap()) detonateMine(state.mines[0]);
    state.mines.push(mine);
  }
  function detonateMine(mine) {
    const index = state.mines.indexOf(mine);
    if (index >= 0) state.mines.splice(index, 1);
    const blast = mineBlastRadius(mine);
    state.effects.push({ x: mine.x, y: mine.y, radius: blast, life: .4, mine: !mine.cluster, cluster: !!mine.cluster });
    for (const enemy of state.enemies) {
      if (enemy.hp > 0 && distance(enemy, mine) < blast + enemy.radius) {
        // Bigger bodies take more of the blast, which keeps mines relevant against tanks
        // and siege carriers without overkill on trash.
        hit(enemy, mine.damage * (1 + enemy.radius / 10));
      }
    }
    // Volatile rounds leave the ground hot; the patch ticks through DoT so it never strobes.
    // Only a full charge seeds the patch — a cluster's subs would otherwise stack four of them.
    if (rank('blast') > 0 && !mine.sub) state.burns.push({ x: mine.x, y: mine.y, radius: blast * .8,
      damage: mine.damage * .2, life: MINE_BURN_SECONDS, clock: 0 });
    if (!mine.sub && rank('cluster') > 0) {
      for (let i = 0; i < CLUSTER_SUBS; i++) {
        const angle = i * Math.PI * 2 / CLUSTER_SUBS + Math.PI / 4;
        dropMine({ x: mine.x + Math.cos(angle) * 34, y: mine.y + Math.sin(angle) * 34,
          vx: 0, vy: 0, radius: blast * CLUSTER_RADIUS_FRACTION,
          damage: mine.damage * CLUSTER_DAMAGE_FRACTION, arm: .2, sub: true, cluster: true });
      }
    }
    mineBlastSound(mine);
  }
  // Ground hazards tick as world entities. Rolling charges spend their momentum before they
  // arm, so a charge is harmless (and inert) until it stops.
  function updateMines(dt) {
    for (const mine of state.mines.slice()) {
      // Roll to a stop before arming.
      const speed = Math.hypot(mine.vx || 0, mine.vy || 0);
      if (speed > 0) {
        const next = Math.max(0, speed - MINE_ROLL_FRICTION * dt);
        const scale = next / speed;
        mine.vx = (mine.vx || 0) * scale; mine.vy = (mine.vy || 0) * scale;
        mine.x = clamp(mine.x + (mine.vx || 0) * dt, 18, W - 18);
        mine.y = clamp(mine.y + (mine.vy || 0) * dt, 64, H - 70);
        if (mine.x <= 18 || mine.x >= W - 18) mine.vx = 0;
        if (mine.y <= 64 || mine.y >= H - 70) mine.vy = 0;
      }
      if (Math.hypot(mine.vx || 0, mine.vy || 0) > 1e-6) continue;
      mine.arm = Math.max(0, mine.arm - dt);
      if (mine.arm > 0) continue;
      // Phase: trip on a proximity fuse outside the body, spending the blast on the front rank.
      const reach = mineBlastRadius(mine) + mineFuse();
      for (const enemy of state.enemies) {
        if (enemy.hp > 0 && distance(enemy, mine) < reach + enemy.radius) { detonateMine(mine); break; }
      }
    }
    for (const burn of state.burns.slice()) {
      burn.life -= dt; burn.clock -= dt;
      if (burn.clock <= 0) {
        burn.clock = MINE_BURN_INTERVAL;
        for (const enemy of state.enemies) {
          if (enemy.hp > 0 && distance(enemy, burn) < burn.radius + enemy.radius) damageOverTime(enemy, burn.damage);
        }
      }
      if (burn.life <= 0) state.burns.splice(state.burns.indexOf(burn), 1);
    }
  }
  function burst(x, y, color, count = 10) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, speed = 25 + Math.random() * 100;
      state.particles.push({ x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, life: .3 + Math.random() * .35, color });
    }
  }
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
    sfx('kill', SFX_KILL_PITCH[enemy.type] || 150, .06, 'triangle', .025); updateUI();
  }
  function hit(enemy, damage) {
    if (enemy.hp <= 0) return;
    // The crawl is not a kill. Shatter only when the stacks owed past the freeze are filled.
    if (cryoReadyToShatter(enemy)) damage += shatter(enemy);
    enemy.hp -= damage; enemy.flash = .09;
    if (enemy.hp <= 0) killEnemy(enemy);
  }
  // Damage over time bypasses flash so per-frame ticks do not strobe enemies.
  function damageOverTime(enemy, damage) {
    if (enemy.hp <= 0 || damage <= 0) return;
    enemy.hp -= damage;
    if (enemy.hp <= 0) killEnemy(enemy);
  }
  function damageBase(amount) {
    state.health = Math.max(0, state.health - amount);
    burst(240, 636, '#ff687e', 15); sfx('hit', 70, .16, 'sawtooth', .04); updateUI();
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
    sfx('ui', 220, .5, 'triangle', .03);
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
    const prevX = pilot.x, prevY = pilot.y;
    pilot.x = clamp(pilot.x + mx / magnitude * moveSpeed() * dt, 30, 450);
    pilot.y = clamp(pilot.y + my / magnitude * moveSpeed() * dt, 85, 593);
    if (pointer) {
      const dx = pointer.x - pilot.x, dy = pointer.y - pilot.y;
      const step = Math.min(1, moveSpeed() * dt / Math.max(1, Math.hypot(dx, dy)));
      pilot.x = clamp(pilot.x + dx * step, 30, 450); pilot.y = clamp(pilot.y + dy * step, 85, 593);
    }
    // Derive momentum from the position delta rather than the input vector, so keyboard,
    // pointer drag, and clamped edges all produce the velocity a rolling charge inherits.
    pilot.vx = dt > 0 ? (pilot.x - prevX) / dt : 0;
    pilot.vy = dt > 0 ? (pilot.y - prevY) / dt : 0;
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
      if (weapon.id === 'orbit' || weapon.id === 'twin') weapon.phase = (weapon.phase || 0) + dt * orbitSpin();
      // Area weapons ignore aim; the reticle and facing only move for aimed weapons.
      if (target && weaponAims(weapon.id)) pilot.angle = Math.atan2(target.y - pilot.y, target.x - pilot.x);
      const autoFireOn = $('auto-fire').checked || keys.has('Space');
      if (autoFireOn) upgradeData(weapon.id).fire(weapon, target);
    }
    // Ground hazards: charges roll, arm, and detonate; Volatile burn patches tick alongside.
    updateMines(dt);
    // Singularity: timed collapse wells pull the pile inward and implode on expiry. This
    // runs ahead of the gravity pull so a well's displacement is the last word on the frame.
    updateWells(dt);
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
    // Gravity collisions: bodies are solid, a magnet's squeeze crushes, and the rebound
    // pushes neighbours apart. Other weapons skip this pass entirely.
    resolveGravityCollisions(dt);
    for (const enemy of state.enemies) {
      if (enemy.hp <= 0) continue;
      // Frozen enemies keep swaying and creep at the crawl speed. They are a pile, not
      // statues: the shatter is a stack goal, so forward motion never hard-stops.
      enemy.time += dt;
      enemy.flash = Math.max(0, enemy.flash - dt);
      enemy.orbitClock = Math.max(0, (enemy.orbitClock || 0) - dt);
      enemy.y += enemy.speed * chillSpeedFactor(enemy) * dt;
      // Collision velocity is written by resolveGravityCollisions; non-gravity runs leave
      // it at zero, so this is a no-op for every other weapon. The x clamp keeps a rebound
      // from pushing a body out of the arena.
      if (enemy.vx) enemy.originX = clamp(enemy.originX + enemy.vx * dt, enemy.radius, W - enemy.radius);
      if (enemy.vy) enemy.y += enemy.vy * dt;
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
        hit(enemy, 30); burst(pilot.x, pilot.y, '#65e5dd', 12);
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
    // then irradiated enemies glow acid green, then charged ones violet.
    ctx.fillStyle = enemy.flash > 0 ? '#fff'
      : enemy.frozen ? '#d8f3ff'
      : enemy.chill > 0 ? '#a6d4ff'
      : enemy.rad > 0 ? '#a9e08a'
      : enemy.charge > 0 ? '#c3a9ff'
      : enemy.color;
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
    for (const burn of state.burns) {
      ctx.globalAlpha = Math.max(0, Math.min(1, burn.life / MINE_BURN_SECONDS)) * .5;
      ctx.fillStyle = '#ff9a4d'; ctx.beginPath(); ctx.arc(burn.x, burn.y, burn.radius, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    // A live collapse well draws as a violet ring spiralling inward, so the swallow is
    // legible: the spiral tightens as the well nears its implosion.
    for (const well of state.wells) {
      const progress = 1 - well.life / well.maxLife;
      ctx.globalAlpha = .25 + progress * .55;
      ctx.strokeStyle = '#c3a9ff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(well.x, well.y, well.radius * (1 - progress * .55), 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 1;
      const turns = 3, arms = 4;
      for (let arm = 0; arm < arms; arm++) {
        ctx.beginPath();
        for (let step = 0; step <= 24; step++) {
          const t = step / 24, angle = arm * Math.PI * 2 / arms + t * turns * Math.PI * 2 + elapsed;
          const radius = well.radius * (1 - t) * (1 - progress * .4);
          const pointX = well.x + Math.cos(angle) * radius, pointY = well.y + Math.sin(angle) * radius;
          if (step === 0) ctx.moveTo(pointX, pointY); else ctx.lineTo(pointX, pointY);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    for (const mine of state.mines) {
      const rolling = Math.hypot(mine.vx || 0, mine.vy || 0) > 1e-6;
      const armed = !rolling && mine.arm <= 0;
      // A rolling charge drags a short trail so the momentum is visible.
      if (rolling) {
        ctx.strokeStyle = '#ffcb7855'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(mine.x - mine.vx * .06, mine.y - mine.vy * .06); ctx.lineTo(mine.x, mine.y); ctx.stroke();
      }
      if (mine.sub) {
        // Sub-charges read as a different object: smaller, diamond-shaped, and hotter.
        ctx.strokeStyle = armed ? '#ff7a3d' : '#ff7a3d66'; ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(mine.x, mine.y - 4); ctx.lineTo(mine.x + 4, mine.y);
        ctx.lineTo(mine.x, mine.y + 4); ctx.lineTo(mine.x - 4, mine.y); ctx.closePath(); ctx.stroke();
        if (armed) {
          ctx.fillStyle = '#ffb066'; ctx.beginPath();
          ctx.moveTo(mine.x, mine.y - 2); ctx.lineTo(mine.x + 2, mine.y);
          ctx.lineTo(mine.x, mine.y + 2); ctx.lineTo(mine.x - 2, mine.y); ctx.closePath(); ctx.fill();
        }
        continue;
      }
      ctx.strokeStyle = armed ? '#ffcb78' : '#ffcb7866'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(mine.x, mine.y, 6, 0, Math.PI * 2); ctx.stroke();
      if (armed) {
        ctx.fillStyle = '#ffcb78'; ctx.beginPath(); ctx.arc(mine.x, mine.y, 2.5, 0, Math.PI * 2); ctx.fill();
      } else if (!rolling) {
        ctx.strokeStyle = '#ffcb7855';
        ctx.beginPath(); ctx.arc(mine.x, mine.y, mine.radius * (1 - Math.min(1, mine.arm / MINE_ARM)), 0, Math.PI * 2); ctx.stroke();
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
      const evolved = rank('twin') > 0, rocks = orbitRockPositions(weapon);
      // Base belt lanes are circles; the Planetary ring draws two broken ellipses.
      ctx.strokeStyle = evolved ? '#cbbcff40' : '#b59dff2e'; ctx.lineWidth = 1; ctx.setLineDash([3, 7]);
      for (const lane of orbitLanes()) { ctx.beginPath(); ctx.ellipse(pilot.x, pilot.y, lane.rx, lane.ry, 0, 0, Math.PI * 2); ctx.stroke(); }
      ctx.setLineDash([]);
      // Two ghost samples behind each rock sell the sweep without extra simulation.
      const trails = [orbitRockPositions(weapon, -.12), orbitRockPositions(weapon, -.24)];
      for (const [index, rock] of rocks.entries()) {
        trails.forEach((trail, trailIndex) => {
          const ghost = trail[index];
          ctx.globalAlpha = trailIndex === 0 ? .11 : .06; ctx.fillStyle = '#b59dff';
          ctx.beginPath(); ctx.arc(ghost.x, ghost.y, ORBIT_ROCK_RADIUS * .7, 0, Math.PI * 2); ctx.fill();
        });
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#b59dff26'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(rock.x, rock.y, ORBIT_ROCK_RADIUS, 0, Math.PI * 2); ctx.stroke();
        // An irregular asteroid, rotated by its orbit angle. Vertices are derived from the
        // index rather than Math.random() so draw never disturbs the seeded RNG stream.
        ctx.save(); ctx.translate(rock.x, rock.y); ctx.rotate(rock.angle * 2 + index);
        ctx.fillStyle = evolved ? '#cbbcff' : '#b59dff';
        ctx.shadowColor = '#b59dff'; ctx.shadowBlur = 8;
        ctx.beginPath();
        const facets = 7;
        for (let vertex = 0; vertex < facets; vertex++) {
          const spread = ORBIT_ROCK_RADIUS * (vertex % 2 === 0 ? 1 : .76);
          const angle = vertex / facets * Math.PI * 2;
          if (vertex === 0) ctx.moveTo(Math.cos(angle) * spread, Math.sin(angle) * spread);
          else ctx.lineTo(Math.cos(angle) * spread, Math.sin(angle) * spread);
        }
        ctx.closePath(); ctx.fill(); ctx.shadowBlur = 0; ctx.restore();
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
      else { ctx.strokeStyle = effect.cluster ? '#ff9a4d' : effect.mine ? '#ffcb78' : effect.cryo ? '#a6d4ff' : effect.belt ? '#b59dff' : effect.well ? '#c3a9ff' : '#65e5dd'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(effect.x, effect.y, effect.radius * (1 - effect.life / .4), 0, Math.PI * 2); ctx.stroke(); }
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
  // ---- Audio ------------------------------------------------------------------------------
  // One graph, built lazily on the first user gesture: effect voices -> masterGain.
  // Muting ramps the master to zero instead of tearing the graph down, so toggling during
  // a run never re-creates an oscillator graph.
  const audio = { ctx: null, master: null, noise: null };
  const sfxClock = { shot: -1e9, kill: -1e9, hit: -1e9, ui: -1e9, shatter: -1e9, mine: -1e9, blast: -1e9 };
  // Effects stay silent until a gesture creates the context; the sandbox has no AudioContext,
  // so every entry point below is a no-op there.
  function ensureAudio() {
    if (audio.ctx) return true;
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return false;
    try {
      const ctx = new Audio();
      const master = ctx.createGain();
      master.gain.value = 0; master.connect(ctx.destination);
      audio.ctx = ctx; audio.master = master;
      applyAudioGain();
      return true;
    } catch { return false; }
  }
  // Master is mute × volume. The ramp keeps a toggle mid-run from clicking.
  function applyAudioGain() {
    if (!audio.ctx) return;
    audio.master.gain.setTargetAtTime(soundEnabled ? volume : 0, audio.ctx.currentTime, .02);
  }
  // Effects share one destination and one per-key rate limit. `key` is required so a mass
  // kill cannot stack a wall of voices.
  function admit(key) {
    if (!audio.ctx) return false;
    const now = audio.ctx.currentTime, gap = SFX_GAP[key] ?? .05;
    if (now - sfxClock[key] < gap) return false;
    sfxClock[key] = now;
    return true;
  }
  function sfx(key, frequency, duration, type = 'sine', gain = .03) {
    if (!admit(key)) return;
    tone(frequency, duration, type, gain);
  }
  function tone(frequency, duration, type = 'sine', gain = .03, delay = 0) {
    if (!soundEnabled || !audio.ctx || audio.ctx.state !== 'running') return;
    const ctx = audio.ctx, oscillator = ctx.createOscillator(), envelope = ctx.createGain(), now = ctx.currentTime + delay;
    const peak = Math.min(1, gain * SFX_LEVEL);
    oscillator.type = type; oscillator.frequency.setValueAtTime(frequency, now);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(30, frequency / 2), now + duration);
    // Set the live value as well as the scheduled one. A setValueAtTime exactly at
    // currentTime can be dropped, which left every effect decaying from full scale
    // and made level changes inaudible.
    envelope.gain.value = peak;
    envelope.gain.setValueAtTime(peak, now);
    envelope.gain.exponentialRampToValueAtTime(.001, now + duration);
    oscillator.connect(envelope); envelope.connect(audio.master);
    oscillator.start(now); oscillator.stop(now + duration);
  }
  // One cached crackle buffer. A private mixer fills it so the run's random sequence
  // is never advanced by a blast.
  function noiseBuffer() {
    if (audio.noise) return audio.noise;
    const ctx = audio.ctx;
    const length = Math.max(1, Math.floor(ctx.sampleRate * .2));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let n = 0x9e3779b9;
    for (let i = 0; i < length; i++) {
      n = Math.imul(n ^ (n >>> 15), 0x85ebca6b);
      n = Math.imul(n ^ (n >>> 13), 0xc2b2ae35);
      data[i] = ((n >>> 0) / 4294967296) * 2 - 1;
    }
    audio.noise = buffer;
    return buffer;
  }
  function noiseBurst(duration, gain, cutoff) {
    if (!soundEnabled || !audio.ctx || audio.ctx.state !== 'running') return;
    const ctx = audio.ctx, now = ctx.currentTime, source = ctx.createBufferSource();
    source.buffer = noiseBuffer();
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass'; filter.frequency.setValueAtTime(cutoff, now);
    const envelope = ctx.createGain(), peak = Math.min(1, gain * SFX_LEVEL);
    envelope.gain.value = peak;
    envelope.gain.setValueAtTime(peak, now);
    envelope.gain.exponentialRampToValueAtTime(.001, now + duration);
    source.connect(filter); filter.connect(envelope); envelope.connect(audio.master);
    source.start(now); source.stop(now + duration);
  }
  // Audio must be created inside a user gesture, and must be resumed if the tab was hidden.
  function unlockAudio() {
    if (!ensureAudio()) return;
    if (audio.ctx.state !== 'running') audio.ctx.resume().catch(() => {});
  }
  // The markup and the JS disagree until this runs, so it runs on boot and on every change.
  // `Sound` is the mute for effects. The slider is their volume.
  function renderAudioUI() {
    const soundButton = $('sound'), slider = $('volume');
    if (soundButton) {
      soundButton.textContent = soundEnabled ? 'Sound on' : 'Sound off';
      soundButton.setAttribute('aria-pressed', String(soundEnabled));
    }
    if (slider) slider.value = String(Math.round(volume * 100));
  }
  const bindAudioToggles = () => {
    if ($('volume')) {
      $('volume').addEventListener('input', event => {
        volume = clamp(Number(event.target.value) / 100 || 0, 0, 1); applyAudioGain(); saveSettings();
      });
    }
    if ($('sound')) $('sound').addEventListener('click', () => {
      unlockAudio(); soundEnabled = !soundEnabled; applyAudioGain(); saveSettings(); renderAudioUI(); sfx('ui', 500, .08);
    });
  };
  bindAudioToggles(); renderAudioUI();
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
  // Hiding the tab releases held inputs. Coming back resumes the audio context so effects
  // can play again after the browser suspended it.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) releaseInputs();
    else if (audio.ctx && audio.ctx.state === 'suspended') audio.ctx.resume().catch(() => {});
  });
  function canvasPoint(event) { const rect = canvas.getBoundingClientRect(); return { x: (event.clientX - rect.left) / rect.width * W, y: (event.clientY - rect.top) / rect.height * H }; }
  // Audio can only be created inside a gesture, so the first interaction anywhere on the page
  // opens the graph. Both handlers are idempotent once the context exists.
  window.addEventListener('pointerdown', unlockAudio, { passive: true });
  window.addEventListener('keydown', unlockAudio);
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
