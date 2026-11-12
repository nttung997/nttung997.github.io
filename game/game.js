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
    repair: { name: 'Emergency repair', icon: '+', max: Infinity, description: 'Restore 25 base integrity immediately, up to 100.' }
  };
  const keys = new Set();
  let state, paused = false, pointer = null, last = 0, elapsed = 0, bannerTimer;
  let soundEnabled = false, audioContext, best = 0;
  try { best = Number(localStorage.getItem('skyhold-survivor-best')) || 0; } catch { /* Storage is optional. */ }
  const stars = Array.from({ length: 65 }, (_, i) => ({ x: (i * 137.7) % W, y: (i * 83.3) % H, size: i % 4 === 0 ? 1.6 : .8 }));
  const rank = id => state.build[id] || 0;
  const nextLevelXP = level => 18 + (level - 1) * 12;
  const weaponDamage = () => 40 * (1 + rank('damage') * .25);
  const fireInterval = () => 1;
  const shotPattern = () => ({ bursts: clamp(1 + rank('burst'), 1, 3), parallel: clamp(1 + rank('multishot'), 1, 3) });
  const enemySpeedFactor = enemy => enemy.slow > 0 ? chillFactor() : 1;
  const moveSpeed = () => 270 * (1 + rank('speed') * .12);
  const spawnDelay = threat => Math.max(.3, 1.2 - threat * .06);

  function reset() {
    state = { phase: 'ready', health: 100, score: 0, kills: 0, level: 1, xp: 0, build: {},
      enemies: [], bullets: [], particles: [], effects: [], spawnClock: .6,
      pilot: { x: 240, y: 545, cooldown: 0, pendingBursts: [], hitTimer: 0, angle: -Math.PI / 2, auraClock: 0 },
      runTime: 0, threat: 1, choices: [] };
    paused = false; keys.clear(); pointer = null;
    clearTimeout(bannerTimer); $('banner').classList.remove('visible');
    $('auto-fire').checked = true; closeUpgrade();
    overlay('ONE PILOT. ENDLESS POTENTIAL.', 'Start small.<br>Hit harder.',
      'Your blasters aim and fire automatically. Dodge enemies, earn XP, and choose your upgrades. Hostiles never stop coming. Keep the base alive.',
      'Start surviving', 'AUTO AIM · LEVEL-UP CHOICES · NO TWO RUNS ALIKE');
    message('Focus on movement. Your weapons handle the aiming.');
    renderLoadout(); updateUI();
  }

  function overlay(kicker, title, text, action, note) {
    $('overlay-kicker').textContent = kicker; $('overlay-title').innerHTML = title;
    $('overlay-text').textContent = text; $('overlay-action').innerHTML = action + ' <span>→</span>';
    $('overlay-note').textContent = note; $('overlay').hidden = false;
  }
  function message(text) { $('status').textContent = text; }
  function announce(text) {
    $('banner').textContent = text; $('banner').classList.add('visible');
    clearTimeout(bannerTimer); bannerTimer = setTimeout(() => $('banner').classList.remove('visible'), 1500);
  }
  function beginRun() { $('overlay').hidden = true; state.phase = 'combat'; state.spawnClock = .6; announce('HOSTILES INBOUND'); message('Weapons locked on. Defeat enemies to earn XP and evolve your build.'); updateUI(); canvas.focus({ preventScroll: true }); }
  function updateUI() {
    $('health').innerHTML = Math.ceil(state.health) + '<span>%</span>';
    $('health-bar').style.width = state.health + '%';
    $('health-bar').style.background = state.health <= 30 ? '#ff7984' : '#65e5dd';
    $('wave').innerHTML = '∞<span> THREAT ' + state.threat + '</span>';
    $('level').textContent = 'LV ' + state.level;
    $('xp-label').textContent = 'XP ' + state.xp + ' / ' + nextLevelXP(state.level);
    $('xp-bar').style.width = Math.min(100, state.xp / nextLevelXP(state.level) * 100) + '%';
    $('next-level').textContent = Math.max(0, nextLevelXP(state.level) - state.xp) + ' XP';
    $('kills').textContent = state.kills;
    $('wave-progress').textContent = state.enemies.filter(enemy => enemy.hp > 0).length + ' ON FIELD';
    $('score').textContent = 'SCORE ' + state.score; $('best').textContent = best;
    $('phase').textContent = paused ? 'OPERATIONS PAUSED' : ({ ready: 'AWAITING PILOT', combat: 'SURVIVAL ACTIVE', upgrade: 'CHOOSE AN UPGRADE', lost: 'BASE LOST' })[state.phase];
    $('phase-tag').textContent = paused ? 'PAUSED' : ({ ready: 'READY', combat: 'LIVE', upgrade: 'LEVEL UP', lost: 'LOST' })[state.phase];
    $('pause').disabled = state.phase !== 'combat';
    $('pause').innerHTML = paused ? 'Resume <span>▷</span>' : 'Pause <span>Ⅱ</span>';
    $('damage-stat').textContent = weaponDamage().toFixed(0);
    const pattern = shotPattern();
    $('shot-stat').textContent = pattern.bursts + '×' + pattern.parallel;
    const bullets = pattern.bursts * pattern.parallel;
    $('shot-total').textContent = bullets + ' bullet' + (bullets === 1 ? '' : 's') + ' per cycle · bursts × parallel bullets';
    $('rate-stat').textContent = '1 Hz';
    $('armor-stat').textContent = rank('armor') * 10 + '%';
    $('auto-fire').disabled = state.phase === 'upgrade';
    $('build-count').textContent = Object.values(state.build).reduce((sum, count) => sum + count, 0) + ' UPGRADES';
  }
  function renderLoadout() {
    const loadout = $('loadout'); loadout.replaceChildren();
    const owned = Object.entries(state.build).filter(([, count]) => count > 0);
    if (!owned.length) {
      const empty = document.createElement('p'); empty.className = 'empty-build';
      empty.textContent = 'Start with 1 burst of 1 bullet. Upgrade to 3 bursts of 3 parallel bullets. Your upgrades will appear here.'; loadout.append(empty); return;
    }
    for (const [id, count] of owned) {
      const row = document.createElement('div'); row.className = 'loadout-item';
      const icon = document.createElement('span'); icon.className = 'loadout-icon'; icon.textContent = upgrades[id].icon;
      const name = document.createElement('strong'); name.textContent = upgrades[id].name;
      const badge = document.createElement('span'); badge.className = 'loadout-rank';
      badge.textContent = id === 'repair' ? count + ' USED' : 'RANK ' + count + ' / ' + upgrades[id].max;
      row.append(icon, name, badge); loadout.append(row);
    }
  }

  function gainXP(amount) { state.xp += amount; }
  function requestUpgrade() {
    if (paused || state.phase !== 'combat' || state.xp < nextLevelXP(state.level)) return false;
    state.xp -= nextLevelXP(state.level); state.level++; state.phase = 'upgrade';
    keys.clear(); pointer = null;
    const available = Object.keys(upgrades).filter(id => rank(id) < upgrades[id].max && (id !== 'repair' || state.health < 100));
    // Shuffle without replacement: choices are distinct, and capped upgrades cannot appear.
    for (let i = available.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1)); [available[i], available[j]] = [available[j], available[i]];
    }
    state.choices = available.slice(0, 3);
    // Late runs with a fully capped build still offer useful restoration.
    if (!state.choices.length) state.choices = ['repair'];
    $('upgrade-kicker').textContent = 'LEVEL ' + state.level + ' UNLOCKED';
    const container = $('upgrade-choices'); container.replaceChildren();
    state.choices.forEach((id, index) => {
      const data = upgrades[id], card = document.createElement('button'); card.className = 'upgrade-card'; card.dataset.upgrade = id;
      const icon = document.createElement('span'); icon.className = 'upgrade-icon'; icon.textContent = data.icon;
      const badge = document.createElement('span'); badge.className = 'upgrade-rank'; badge.textContent = id === 'repair' ? 'INSTANT RECOVERY' : 'RANK ' + (rank(id) + 1) + ' / ' + data.max;
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
  function spawnOne() {
    state.spawnClock = spawnDelay(state.threat);
    if (state.enemies.filter(enemy => enemy.hp > 0).length >= MAX_ALIVE) return;
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
    state.enemies.push({ ...data, type, maxHp: data.hp, x, originX: x, y: -50, time: 0, slow: 0, flash: 0, attackClock: 2 });
  }
  function aimTarget() {
    return state.enemies.reduce((nearest, enemy) => enemy.hp > 0 && enemy.y >= 0 && enemy.y < 623 &&
      (!nearest || distance(state.pilot, enemy) < distance(state.pilot, nearest)) ? enemy : nearest, null);
  }
  function firePilot(target) {
    const pilot = state.pilot, pattern = shotPattern();
    if (pilot.cooldown > 1e-9 || pilot.pendingBursts.length) return;
    // Simulation delays freeze with pause and level-up choices; the cycle finishes within one second.
    for (let burstIndex = 0; burstIndex < pattern.bursts; burstIndex++) {
      const delay = burstIndex * .30;
      if (delay === 0) fireVolley(target, pattern.parallel);
      else pilot.pendingBursts.push({ delay, parallel: pattern.parallel });
    }
    pilot.cooldown = fireInterval();
  }
  function fireVolley(target, parallel) {
    const pilot = state.pilot, flightTime = distance(pilot, target) / 560;
    const predicted = { x: target.x, y: target.y + target.speed * enemySpeedFactor(target) * flightTime };
    const angle = Math.atan2(predicted.y - pilot.y, predicted.x - pilot.x);
    pilot.angle = angle;
    for (let barrel = 0; barrel < parallel; barrel++) {
      const offset = (barrel - (parallel - 1) / 2) * 8;
      state.bullets.push({ x: pilot.x + Math.cos(angle) * 18 - Math.sin(angle) * offset,
        y: pilot.y + Math.sin(angle) * 18 + Math.cos(angle) * offset,
        vx: Math.cos(angle) * 560, vy: Math.sin(angle) * 560,
        damage: weaponDamage(), splash: rank('blast') ? 28 + rank('blast') * 12 : 0,
        slow: rank('frost') > 0, pierce: rank('pierce'), hitEnemies: new Set(),
        color: rank('frost') ? '#a6baff' : '#9cfff1', radius: rank('blast') ? 4 : 3, life: 2, enemy: false });
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
  function hit(enemy, damage, slow) {
    if (enemy.hp <= 0) return;
    enemy.hp -= damage; enemy.flash = .09;
    if (slow) enemy.slow = 1.3 + rank('frost') * .35;
    if (enemy.hp <= 0) {
      state.score += enemy.xp * 20; state.kills++; gainXP(enemy.xp);
      burst(enemy.x, enemy.y, enemy.color, enemy.type === 'boss' ? 50 : 12);
      state.effects.push({ x: enemy.x, y: enemy.y, life: .8, xp: enemy.xp });
      tone(150, .06, 'triangle', .025); updateUI();
    }
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
    state.pilot.pendingBursts = [];
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
    pilot.cooldown = Math.max(0, pilot.cooldown - dt);
    pilot.pendingBursts.forEach(volley => { volley.delay -= dt; });
    while (pilot.pendingBursts.length && pilot.pendingBursts[0].delay <= 1e-9) {
      const volley = pilot.pendingBursts.shift(), burstTarget = aimTarget();
      if (burstTarget) fireVolley(burstTarget, volley.parallel);
    }
    const target = aimTarget();
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
    for (const enemy of state.enemies) {
      if (enemy.hp <= 0) continue;
      enemy.time += dt; enemy.slow = Math.max(0, enemy.slow - dt); enemy.flash = Math.max(0, enemy.flash - dt);
      enemy.y += enemy.speed * enemySpeedFactor(enemy) * dt;
      enemy.x = enemy.originX + Math.sin(enemy.time * (enemy.type === 'runner' ? 2 : .8)) * (enemy.type === 'boss' ? 45 : 16);
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
          for (const nearby of state.enemies) if (nearby.hp > 0 && distance(nearby, enemy) < bullet.splash + nearby.radius) hit(nearby, bullet.damage, bullet.slow);
        } else { hit(enemy, bullet.damage, bullet.slow); burst(bullet.x, bullet.y, bullet.color, 3); }
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
    ctx.fillStyle = enemy.flash > 0 ? '#fff' : enemy.slow > 0 ? '#a6ceff' : enemy.color;
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
    const target = aimTarget();
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
    for (const p of state.particles) { ctx.globalAlpha = Math.max(0, p.life / .65); ctx.fillStyle = p.color; ctx.fillRect(p.x - 2, p.y - 2, 3, 3); }
    ctx.globalAlpha = 1;
    for (const effect of state.effects) {
      ctx.globalAlpha = Math.min(1, effect.life * 2);
      if (effect.xp) { ctx.fillStyle = '#ffcb78'; ctx.font = 'bold 11px system-ui'; ctx.fillText('+' + effect.xp + ' XP', effect.x, effect.y - (1 - effect.life / .8) * 28); }
      else { ctx.strokeStyle = '#65e5dd'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(effect.x, effect.y, effect.radius * (1 - effect.life / .4), 0, Math.PI * 2); ctx.stroke(); }
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
      await audioContext.resume(); soundEnabled = !soundEnabled;
      $('sound').textContent = soundEnabled ? 'Sound on' : 'Sound off'; $('sound').setAttribute('aria-pressed', String(soundEnabled)); tone(500, .08);
    } catch { $('sound').textContent = 'Sound unavailable'; }
  });
  $('overlay-action').addEventListener('click', () => { if (paused) togglePause(); else { if (state.phase !== 'ready') reset(); beginRun(); } });
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
  const autoPause = () => { keys.clear(); pointer = null; if (!paused && state.phase === 'combat') togglePause(); };
  window.addEventListener('blur', autoPause);
  document.addEventListener('visibilitychange', () => { if (document.hidden) autoPause(); });
  function canvasPoint(event) { const rect = canvas.getBoundingClientRect(); return { x: (event.clientX - rect.left) / rect.width * W, y: (event.clientY - rect.top) / rect.height * H }; }
  canvas.addEventListener('pointerdown', event => {
    if (paused || state.phase !== 'combat' || pointer) return;
    event.preventDefault(); canvas.focus({ preventScroll: true }); pointer = { ...canvasPoint(event), id: event.pointerId }; canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', event => { if (pointer && pointer.id === event.pointerId) pointer = { ...canvasPoint(event), id: event.pointerId }; });
  const release = event => { if (pointer && pointer.id === event.pointerId) pointer = null; };
  canvas.addEventListener('pointerup', release); canvas.addEventListener('pointercancel', release); canvas.addEventListener('lostpointercapture', release);
  function frame(now) {
    const dt = Math.min(.033, Math.max(0, (now - (last || now)) / 1000)); last = now;
    if (!paused && state.phase !== 'upgrade') elapsed += dt;
    update(dt); draw(); requestAnimationFrame(frame);
  }
  reset(); requestAnimationFrame(frame);
})();
