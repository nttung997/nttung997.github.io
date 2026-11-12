(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const canvas = $('field');
  const ctx = canvas.getContext('2d');
  const W = 480, H = 680, TOTAL_WAVES = 10;
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const types = {
    pulse: { name: 'Pulse turret', cost: 60, damage: 13, interval: .38, range: 190, speed: 450, color: '#65e5dd' },
    cannon: { name: 'Heavy cannon', cost: 90, damage: 34, interval: 1.05, range: 210, speed: 300, color: '#ffcb78', splash: 54 },
    frost: { name: 'Frost relay', cost: 75, damage: 7, interval: .65, range: 175, speed: 380, color: '#a6baff', slow: true }
  };
  const slots = [{ x: 60, y: 200 }, { x: 420, y: 200 }, { x: 60, y: 345 }, { x: 420, y: 345 }, { x: 60, y: 490 }, { x: 420, y: 490 }];
  let state, chosen = 'pulse', selected = -1, paused = false, last = 0, elapsed = 0;
  let keys = new Set(), pointer = null, soundEnabled = false, audioContext;
  let best = 0;
  try { best = Number(localStorage.getItem('skyhold-best')) || 0; } catch { /* Storage is optional. */ }
  const stars = Array.from({ length: 65 }, (_, i) => ({ x: (i * 137.7) % W, y: (i * 83.3) % H, size: i % 4 === 0 ? 1.6 : .8 }));
  let bannerTimer;

  function reset() {
    state = { phase: 'ready', health: 100, credits: 180, wave: 0, score: 0, kills: 0,
      towers: Array(6).fill(null), enemies: [], bullets: [], particles: [], spawnQueue: [], spawnClock: 0,
      pilot: { x: 240, y: 565, level: 1, cooldown: 0, hitTimer: 0 }, waveTime: 0 };
    paused = false; chosen = 'pulse'; selected = -1; keys.clear(); pointer = null;
    clearTimeout(bannerTimer); $('banner').classList.remove('visible');
    $('auto-fire').checked = true;
    overlay('THE LAST OUTPOST', 'Your watch<br>starts here.', 'Pilot your defender and let your towers cover the flanks. Keep enemies away from the base.', 'Enter the battlefield', '10 WAVES · 3 TOWER TYPES · ONE LAST STAND');
    updateUI();
    message('Take your position. Build your defenses. Make every shot count.');
  }

  function overlay(kicker, title, text, action, note) {
    $('overlay-kicker').textContent = kicker;
    $('overlay-title').innerHTML = title;
    $('overlay-text').textContent = text;
    $('overlay-action').innerHTML = `${action} <span>→</span>`;
    $('overlay-note').textContent = note;
    $('overlay').hidden = false;
  }

  function announce(text) {
    $('banner').textContent = text;
    $('banner').classList.add('visible');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => $('banner').classList.remove('visible'), 1800);
  }

  function message(text) { $('status').textContent = text; }

  function prepare() {
    state.phase = 'build';
    $('overlay').hidden = true;
    updateUI();
    message('Spend your 180 credits on towers. Select a tower, tap a glowing pad, then launch wave 1.');
    canvas.focus({ preventScroll: true });
  }

  function updateUI() {
    const build = state.phase === 'build' && !paused;
    $('health').innerHTML = `${Math.ceil(state.health)}<span>%</span>`;
    $('health-bar').style.width = `${state.health}%`;
    $('health-bar').style.background = state.health <= 30 ? '#ff7984' : '#65e5dd';
    $('wave').innerHTML = `${String(Math.max(1, state.wave)).padStart(2, '0')}<span> / 10</span>`;
    $('credits').textContent = state.credits;
    $('score').textContent = `SCORE ${state.score}`;
    $('best').textContent = best;
    $('phase').textContent = paused ? 'OPERATIONS PAUSED' : ({ ready: 'AWAITING PILOT', build: 'BUILD PHASE', combat: 'DEFENSE ACTIVE', lost: 'BASE LOST', won: 'SECTOR SECURED' })[state.phase];
    $('phase-tag').textContent = paused ? 'PAUSED' : ({ ready: 'READY', build: 'BUILD', combat: 'LIVE', lost: 'LOST', won: 'CLEAR' })[state.phase];
    $('next-wave').disabled = !build;
    $('next-wave').innerHTML = `Launch wave ${Math.min(TOTAL_WAVES, state.wave + 1)} <span>→</span>`;
    $('pause').disabled = !['build', 'combat'].includes(state.phase);
    $('pause').innerHTML = paused ? 'Resume <span>▷</span>' : 'Pause <span>Ⅱ</span>';
    $('pilot-level').textContent = `LV ${state.pilot.level}`;
    $('pilot-upgrade').textContent = state.pilot.level >= 4 ? 'MAX' : `${state.pilot.level * 100} ◇`;
    $('pilot-upgrade').disabled = !build || state.pilot.level >= 4 || state.credits < state.pilot.level * 100;
    document.querySelectorAll('.tower-choice').forEach(button => {
      button.disabled = !build;
      button.classList.toggle('selected', button.dataset.tower === chosen);
      button.setAttribute('aria-pressed', String(button.dataset.tower === chosen));
    });
    const tower = state.towers[selected];
    $('tower-actions').hidden = !tower;
    if (tower) {
      const type = types[tower.type], cost = upgradeCost(tower);
      $('selection-title').textContent = `${type.name} · Level ${tower.level}`;
      $('selection-text').textContent = `Damage ${Math.round(type.damage * power(tower))} · Range ${Math.round(range(tower))}. ${build ? 'Upgrade or sell this tower.' : 'Modifications available between waves.'}`;
      $('upgrade').textContent = tower.level >= 3 ? 'Max level' : `Upgrade · ${cost} ◇`;
      $('upgrade').disabled = !build || tower.level >= 3 || state.credits < cost;
      $('sell').textContent = `Sell · ${Math.floor(tower.spent * .65)} ◇`;
      $('sell').disabled = !build;
    } else {
      $('selection-title').textContent = `${types[chosen].name} · ${types[chosen].cost} credits`;
      $('selection-text').textContent = build ? 'Tap a glowing pad to build. Tap an existing tower to see its range and upgrades.' : 'Build and upgrade between waves. Your towers aim and fire automatically.';
    }
  }

  const power = tower => 1 + (tower.level - 1) * .7;
  const range = tower => types[tower.type].range + (tower.level - 1) * 20;
  const upgradeCost = tower => Math.round(types[tower.type].cost * tower.level * .8);

  function selectPad(index) {
    if (paused || !['build', 'combat'].includes(state.phase)) return;
    selected = index;
    if (!state.towers[index] && state.phase === 'build') {
      const type = types[chosen];
      if (state.credits < type.cost) message(`You need ${type.cost - state.credits} more credits for a ${type.name.toLowerCase()}.`);
      else {
        state.credits -= type.cost;
        state.towers[index] = { ...slots[index], type: chosen, level: 1, spent: type.cost, cooldown: .1, angle: -Math.PI / 2 };
        burst(slots[index].x, slots[index].y, type.color, 16);
        tone(460, .1, 'sine');
        message(`${type.name} online. Add more defenses or launch the next wave.`);
      }
    }
    updateUI();
  }

  function launchWave() {
    if (state.phase !== 'build' || paused) return;
    state.wave++;
    state.phase = 'combat'; state.waveTime = 0; state.spawnClock = .8;
    const count = 8 + state.wave * 3;
    state.spawnQueue = Array.from({ length: count }, (_, i) => {
      if (state.wave >= 3 && i % 6 === 4) return 'tank';
      if (state.wave >= 2 && i % 4 === 2) return 'runner';
      return 'drone';
    });
    if (state.wave === TOTAL_WAVES) state.spawnQueue.push('boss');
    state.enemies = []; state.bullets = [];
    announce(state.wave === TOTAL_WAVES ? 'FINAL WAVE' : `WAVE ${String(state.wave).padStart(2, '0')}`);
    updateUI();
    message(state.wave === TOTAL_WAVES ? 'The siege carrier is approaching. Keep moving and concentrate your fire.' : 'Incoming hostiles. Move your defender to cover the gaps in your tower fire.');
    canvas.focus({ preventScroll: true });
    if (window.matchMedia?.('(max-width: 760px)')?.matches) canvas.scrollIntoView({ block: 'center', behavior: 'instant' });
  }

  function spawn(type) {
    const scale = 1 + (state.wave - 1) * .18;
    const config = {
      drone: { hp: 35 * scale, speed: 28 + state.wave * 2, radius: 13, reward: 9, damage: 8, color: '#ef829b' },
      runner: { hp: 23 * scale, speed: 51 + state.wave * 2.8, radius: 10, reward: 10, damage: 6, color: '#ffbd78' },
      tank: { hp: 130 * scale, speed: 20 + state.wave, radius: 19, reward: 19, damage: 16, color: '#b59dff' },
      boss: { hp: 2400, speed: 14, radius: 40, reward: 150, damage: 100, color: '#ff687e' }
    }[type];
    const x = type === 'boss' ? 240 : 115 + Math.random() * 250;
    state.enemies.push({ ...config, type, maxHp: config.hp, x, originX: x, y: -50, time: 0, slow: 0, flash: 0, attackClock: 2 });
  }

  function shoot(source, target, data) {
    const angle = Math.atan2(target.y - source.y, target.x - source.x);
    state.bullets.push({ x: source.x, y: source.y, vx: Math.cos(angle) * data.speed, vy: Math.sin(angle) * data.speed,
      damage: data.damage, color: data.color, splash: data.splash || 0, slow: data.slow || false,
      target: data.homing ? target : null, enemy: false, radius: data.splash ? 5 : 3, life: 3 });
  }

  function burst(x, y, color, count = 10) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, speed = 25 + Math.random() * 100;
      state.particles.push({ x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, life: .3 + Math.random() * .35, maxLife: .65, color });
    }
  }

  function hit(enemy, damage, slow) {
    if (enemy.hp <= 0) return;
    enemy.hp -= damage; enemy.flash = .09;
    if (slow) enemy.slow = 1.8;
    if (enemy.hp <= 0) {
      state.credits += enemy.reward; state.score += enemy.reward * 10; state.kills++;
      burst(enemy.x, enemy.y, enemy.color, enemy.type === 'boss' ? 50 : 12);
      tone(enemy.type === 'boss' ? 90 : 150, .06, 'triangle', .025);
      updateUI();
    }
  }

  function damageBase(amount) {
    state.health = Math.max(0, state.health - amount);
    burst(240, 636, '#ff687e', 15);
    tone(70, .16, 'sawtooth', .04);
    updateUI();
    if (state.health <= 0) finish(false);
  }

  function saveBest() {
    best = Math.max(best, state.score);
    try { localStorage.setItem('skyhold-best', String(best)); } catch { /* Play without persistence. */ }
  }

  function finish(won) {
    state.phase = won ? 'won' : 'lost'; paused = false; keys.clear(); pointer = null;
    if (won) state.score += Math.ceil(state.health) * 25;
    saveBest(); updateUI();
    message(won ? 'All ten waves defeated. The outpost is still standing.' : 'The base has fallen. Rebuild your defenses and try again.');
    overlay(won ? 'SECTOR SECURED' : 'SIGNAL LOST', won ? 'You held<br>the line.' : 'An outpost.<br>Not forgotten.',
      won ? `All 10 waves cleared with ${Math.ceil(state.health)}% base integrity. Final score: ${state.score}.` : `You reached wave ${state.wave} and defeated ${state.kills} hostiles. Final score: ${state.score}.`,
      'Play again', `PERSONAL BEST ${best.toLocaleString()}`);
  }

  function endWave() {
    if (state.wave === TOTAL_WAVES) { finish(true); return; }
    const bonus = 40 + state.wave * 8;
    state.credits += bonus;
    state.health = Math.min(100, state.health + 5);
    state.phase = 'build'; state.bullets = [];
    saveBest(); updateUI();
    announce('WAVE CLEAR');
    message(`Wave ${state.wave} cleared. +${bonus} credits and +5 base integrity (up to 100). Build or upgrade before the next wave.`);
  }

  function update(dt) {
    if (paused || !['build', 'combat'].includes(state.phase)) return;
    const pilot = state.pilot;
    let mx = (keys.has('ArrowRight') || keys.has('KeyD') ? 1 : 0) - (keys.has('ArrowLeft') || keys.has('KeyA') ? 1 : 0);
    let my = (keys.has('ArrowDown') || keys.has('KeyS') ? 1 : 0) - (keys.has('ArrowUp') || keys.has('KeyW') ? 1 : 0);
    const magnitude = Math.hypot(mx, my) || 1;
    pilot.x = clamp(pilot.x + mx / magnitude * 270 * dt, 103, 377);
    pilot.y = clamp(pilot.y + my / magnitude * 270 * dt, 375, 593);
    if (pointer) {
      const dx = pointer.x - pilot.x, dy = pointer.y - pilot.y, d = Math.hypot(dx, dy);
      const step = Math.min(1, 700 * dt / Math.max(1, d));
      pilot.x = clamp(pilot.x + dx * step, 103, 377);
      pilot.y = clamp(pilot.y + dy * step, 375, 593);
    }
    pilot.hitTimer = Math.max(0, pilot.hitTimer - dt);
    state.particles.forEach(p => { p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt; });
    state.particles = state.particles.filter(p => p.life > 0);
    if (state.phase !== 'combat') return;
    state.waveTime += dt;
    state.spawnClock -= dt;
    if (state.spawnQueue.length && state.spawnClock <= 0) {
      spawn(state.spawnQueue.shift());
      state.spawnClock = Math.max(.38, 1.15 - state.wave * .055);
    }
    pilot.cooldown -= dt;
    if (($('auto-fire').checked || keys.has('Space')) && pilot.cooldown <= 0) {
      for (const offset of [-9, 9]) shoot({ x: pilot.x + offset, y: pilot.y - 18 }, { x: pilot.x + offset, y: -100 },
        { damage: 9 + (pilot.level - 1) * 5, speed: 540, color: '#9cfff1' });
      pilot.cooldown = .23 - (pilot.level - 1) * .035;
      tone(650, .025, 'triangle', .009);
    }
    for (const tower of state.towers) {
      if (!tower) continue;
      tower.cooldown -= dt;
      const targets = state.enemies.filter(e => e.hp > 0 && e.y > 0 && distance(tower, e) < range(tower));
      const target = targets.reduce((front, e) => !front || e.y > front.y ? e : front, null);
      if (target) {
        tower.angle = Math.atan2(target.y - tower.y, target.x - tower.x);
        if (tower.cooldown <= 0) {
          const type = types[tower.type];
          shoot(tower, target, { ...type, damage: type.damage * power(tower), homing: true });
          tower.cooldown = type.interval / (1 + (tower.level - 1) * .12);
        }
      }
    }
    for (const enemy of state.enemies) {
      if (enemy.hp <= 0) continue;
      enemy.time += dt; enemy.slow = Math.max(0, enemy.slow - dt); enemy.flash = Math.max(0, enemy.flash - dt);
      enemy.y += enemy.speed * (enemy.slow > 0 ? .48 : 1) * dt;
      enemy.x = enemy.originX + Math.sin(enemy.time * (enemy.type === 'runner' ? 2 : .8)) * (enemy.type === 'boss' ? 45 : 16);
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
        pilot.hitTimer = 1; damageBase(5); hit(enemy, 30, false);
        burst(pilot.x, pilot.y, '#65e5dd', 12);
        if (state.phase !== 'combat') return;
      }
      if (enemy.y > 623) {
        enemy.hp = 0; damageBase(enemy.damage);
        if (state.phase !== 'combat') return;
      }
    }
    for (const bullet of state.bullets) {
      // Homing keeps tower shots useful against fast and weaving targets.
      if (bullet.target && bullet.target.hp > 0) {
        const speed = Math.hypot(bullet.vx, bullet.vy), angle = Math.atan2(bullet.target.y - bullet.y, bullet.target.x - bullet.x);
        bullet.vx = Math.cos(angle) * speed; bullet.vy = Math.sin(angle) * speed;
      }
      bullet.x += bullet.vx * dt; bullet.y += bullet.vy * dt; bullet.life -= dt;
      if (bullet.enemy) {
        if (distance(bullet, pilot) < bullet.radius + 13 && pilot.hitTimer <= 0) {
          pilot.hitTimer = .6; bullet.life = 0; damageBase(bullet.damage); burst(pilot.x, pilot.y, '#ff687e');
          if (state.phase !== 'combat') return;
        }
        continue;
      }
      const target = state.enemies.find(e => e.hp > 0 && distance(bullet, e) < e.radius + bullet.radius);
      if (target) {
        bullet.life = 0;
        if (bullet.splash) {
          burst(bullet.x, bullet.y, bullet.color, 18);
          for (const e of state.enemies) if (e.hp > 0 && distance(e, target) < bullet.splash + e.radius) hit(e, bullet.damage, false);
        } else { hit(target, bullet.damage, bullet.slow); burst(bullet.x, bullet.y, bullet.color, 3); }
      }
    }
    state.bullets = state.bullets.filter(b => b.life > 0 && b.y > -60 && b.y < H + 40 && b.x > -30 && b.x < W + 30);
    state.enemies = state.enemies.filter(e => e.hp > 0);
    if (!state.spawnQueue.length && !state.enemies.length) endWave();
  }

  function roundedRect(x, y, w, h, r, color) {
    ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill();
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0b1426'; ctx.fillRect(0, 0, W, H);
    const gradient = ctx.createLinearGradient(0, 0, 0, H); gradient.addColorStop(0, '#17223a'); gradient.addColorStop(1, '#0b1a29');
    ctx.fillStyle = gradient; ctx.fillRect(91, 0, 298, H);
    ctx.strokeStyle = '#27375055'; ctx.lineWidth = 1;
    for (let y = -40 + (elapsed * 14) % 40; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(92, y); ctx.lineTo(388, y); ctx.stroke(); }
    for (let x = 120; x < 389; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (const star of stars) { ctx.fillStyle = '#9ab6d43a'; ctx.fillRect(star.x, (star.y + elapsed * 8) % H, star.size, star.size); }
    ctx.fillStyle = '#65e5dd14'; ctx.fillRect(90, 0, 2, H); ctx.fillRect(388, 0, 2, H);
    for (let y = 28; y < 600; y += 44) { ctx.fillStyle = '#65e5dd40'; ctx.fillRect(89, y, 4, 12); ctx.fillRect(387, y, 4, 12); }
    ctx.textAlign = 'center'; ctx.font = '9px system-ui'; ctx.fillStyle = '#93a6c066'; ctx.fillText('INCOMING HOSTILES', 240, 29);
    ctx.strokeStyle = '#93a6c033'; ctx.beginPath(); ctx.moveTo(230, 40); ctx.lineTo(240, 46); ctx.lineTo(250, 40); ctx.stroke();
    const active = state.towers[selected];
    if (active) {
      ctx.beginPath(); ctx.arc(active.x, active.y, range(active), 0, Math.PI * 2);
      ctx.fillStyle = `${types[active.type].color}09`; ctx.fill(); ctx.strokeStyle = `${types[active.type].color}40`;
      ctx.setLineDash([5, 5]); ctx.stroke(); ctx.setLineDash([]);
    }
    slots.forEach((slot, i) => {
      const tower = state.towers[i];
      roundedRect(slot.x - 26, slot.y - 26, 52, 52, 9, '#152339');
      ctx.strokeStyle = selected === i ? '#65e5dd' : '#344862'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(slot.x - 26, slot.y - 26, 52, 52, 9); ctx.stroke();
      if (tower) {
        const color = types[tower.type].color;
        ctx.save(); ctx.translate(tower.x, tower.y); ctx.rotate(tower.angle);
        ctx.fillStyle = '#293b51'; ctx.beginPath(); ctx.arc(0, 0, 17, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = color; ctx.stroke();
        roundedRect(-8, -8, 25, 16, 3, color); roundedRect(7, -4, 19, 8, 2, '#c9e5eb');
        if (tower.type === 'cannon') roundedRect(3, -7, 23, 14, 2, color);
        if (tower.type === 'frost') { ctx.strokeStyle = '#d4ddff'; ctx.beginPath(); ctx.moveTo(-8, -12); ctx.lineTo(10, 12); ctx.moveTo(-8, 12); ctx.lineTo(10, -12); ctx.stroke(); }
        ctx.restore();
        for (let j = 0; j < tower.level; j++) roundedRect(slot.x - tower.level * 4 + j * 8, slot.y + 20, 5, 3, 1, color);
      } else {
        ctx.strokeStyle = state.phase === 'build' ? '#65e5dd99' : '#53637a';
        ctx.beginPath(); ctx.moveTo(slot.x - 7, slot.y); ctx.lineTo(slot.x + 7, slot.y); ctx.moveTo(slot.x, slot.y - 7); ctx.lineTo(slot.x, slot.y + 7); ctx.stroke();
        ctx.fillStyle = '#8ba2bc88'; ctx.font = '7px system-ui'; ctx.fillText(`PAD 0${i + 1}`, slot.x, slot.y + 40);
      }
    });
    for (const enemy of state.enemies) {
      ctx.save(); ctx.translate(enemy.x, enemy.y);
      ctx.fillStyle = enemy.flash > 0 ? '#fff' : enemy.slow > 0 ? '#a6ceff' : enemy.color;
      ctx.strokeStyle = enemy.color; ctx.lineWidth = 2;
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
    for (const bullet of state.bullets) {
      ctx.fillStyle = bullet.color; ctx.shadowColor = bullet.color; ctx.shadowBlur = 7;
      ctx.beginPath(); ctx.ellipse(bullet.x, bullet.y, bullet.radius, bullet.enemy || bullet.splash ? bullet.radius : 7, Math.atan2(bullet.vy, bullet.vx) + Math.PI / 2, 0, Math.PI * 2); ctx.fill();
    }
    ctx.shadowBlur = 0;
    const pilot = state.pilot;
    ctx.save(); ctx.translate(pilot.x, pilot.y);
    if (pilot.hitTimer > 0 && Math.floor(elapsed * 14) % 2) ctx.globalAlpha = .45;
    const flame = 9 + Math.sin(elapsed * 35) * 4;
    ctx.fillStyle = '#65e5dd55'; ctx.beginPath(); ctx.moveTo(-6, 14); ctx.lineTo(0, 14 + flame); ctx.lineTo(6, 14); ctx.fill();
    ctx.fillStyle = '#65e5dd'; ctx.beginPath(); ctx.moveTo(0, -24); ctx.lineTo(10, -3); ctx.lineTo(22, 15); ctx.lineTo(7, 12); ctx.lineTo(0, 17); ctx.lineTo(-7, 12); ctx.lineTo(-22, 15); ctx.lineTo(-10, -3); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#cafff7'; ctx.beginPath(); ctx.moveTo(0, -15); ctx.lineTo(5, 3); ctx.lineTo(-5, 3); ctx.closePath(); ctx.fill();
    roundedRect(-13, -12, 4, 17, 1, '#defffa'); roundedRect(9, -12, 4, 17, 1, '#defffa'); ctx.restore();
    for (const p of state.particles) { ctx.globalAlpha = Math.max(0, p.life / p.maxLife); ctx.fillStyle = p.color; ctx.fillRect(p.x - 2, p.y - 2, 3, 3); }
    ctx.globalAlpha = 1;
    const baseColor = state.health <= 30 ? '#ff687e' : '#65e5dd';
    roundedRect(99, 622, 282, 46, 6, '#132c39');
    ctx.fillStyle = `${baseColor}90`; ctx.fillRect(104, 622, 272, 3);
    for (let x = 108; x < 375; x += 24) roundedRect(x, 634, 16, 9, 2, '#65e5dd22');
    ctx.textAlign = 'center'; ctx.fillStyle = '#9eb9c6'; ctx.font = '8px system-ui'; ctx.fillText('S K Y H O L D   /   L A S T   O U T P O S T', 240, 659);
    if (state.phase === 'build') { ctx.fillStyle = '#b3e0e8'; ctx.font = '9px system-ui'; ctx.fillText('BUILD YOUR DEFENSES · LAUNCH WHEN READY', 240, 83); }
  }

  function togglePause() {
    if (!['build', 'combat'].includes(state.phase)) return;
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
      $('sound').textContent = soundEnabled ? 'Sound on' : 'Sound off';
      $('sound').setAttribute('aria-pressed', String(soundEnabled));
      tone(500, .08);
    } catch { $('sound').textContent = 'Sound unavailable'; }
  });
  $('overlay-action').addEventListener('click', () => {
    if (paused) togglePause();
    else if (state.phase === 'ready') prepare();
    else { reset(); prepare(); }
  });
  $('next-wave').addEventListener('click', launchWave);
  $('pause').addEventListener('click', togglePause);
  $('restart').addEventListener('click', () => { reset(); });
  document.querySelectorAll('.tower-choice').forEach(button => button.addEventListener('click', () => {
    if (state.phase !== 'build' || paused) return;
    chosen = button.dataset.tower; selected = -1; updateUI();
  }));
  $('upgrade').addEventListener('click', () => {
    const tower = state.towers[selected];
    if (!tower || state.phase !== 'build' || paused || tower.level >= 3 || state.credits < upgradeCost(tower)) return;
    const cost = upgradeCost(tower); state.credits -= cost; tower.spent += cost; tower.level++;
    burst(tower.x, tower.y, types[tower.type].color, 20); tone(700, .1); updateUI(); message(`${types[tower.type].name} upgraded to level ${tower.level}.`);
  });
  $('sell').addEventListener('click', () => {
    const tower = state.towers[selected];
    if (!tower || state.phase !== 'build' || paused) return;
    state.credits += Math.floor(tower.spent * .65); state.towers[selected] = null; selected = -1; updateUI(); message('Tower sold. Pad available for a new defense.');
  });
  $('pilot-upgrade').addEventListener('click', () => {
    if (state.phase !== 'build' || paused || state.pilot.level >= 4 || state.credits < state.pilot.level * 100) return;
    state.credits -= state.pilot.level * 100; state.pilot.level++; tone(850, .1); updateUI(); message(`Twin blasters upgraded to level ${state.pilot.level}.`);
  });
  const gameKeys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'KeyP', 'Escape'];
  window.addEventListener('keydown', event => {
    if (!gameKeys.includes(event.code) || !['build', 'combat'].includes(state.phase)) return;
    // Preserve space activation and arrow behavior for focused form controls.
    if (event.target.closest('button, input, a') && !['KeyP', 'Escape'].includes(event.code)) return;
    event.preventDefault();
    if (event.code === 'KeyP' || event.code === 'Escape') { if (!event.repeat) togglePause(); }
    else keys.add(event.code);
  });
  window.addEventListener('keyup', event => keys.delete(event.code));
  window.addEventListener('blur', () => { keys.clear(); pointer = null; if (!paused && state.phase === 'combat') togglePause(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && !paused && state.phase === 'combat') togglePause(); });
  function canvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width * W, y: (event.clientY - rect.top) / rect.height * H };
  }
  canvas.addEventListener('pointerdown', event => {
    if (paused || !['build', 'combat'].includes(state.phase) || pointer) return;
    event.preventDefault(); canvas.focus({ preventScroll: true });
    const point = canvasPoint(event), index = slots.findIndex(slot => distance(slot, point) < 33);
    if (index >= 0) { selectPad(index); return; }
    selected = -1; updateUI();
    pointer = { ...point, id: event.pointerId }; canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', event => { if (pointer && pointer.id === event.pointerId) pointer = { ...canvasPoint(event), id: event.pointerId }; });
  const release = event => { if (pointer && pointer.id === event.pointerId) pointer = null; };
  canvas.addEventListener('pointerup', release); canvas.addEventListener('pointercancel', release); canvas.addEventListener('lostpointercapture', release);

  function frame(now) {
    const dt = Math.min(.033, Math.max(0, (now - (last || now)) / 1000)); last = now;
    if (!paused) elapsed += dt;
    update(dt); draw(); requestAnimationFrame(frame);
  }
  reset(); requestAnimationFrame(frame);
})();
