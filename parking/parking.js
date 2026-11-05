'use strict';

(() => {

    if (!CanvasRenderingContext2D.prototype.roundRect) {
        CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
            const rr = Math.max(0, Math.min(r, w / 2, h / 2));
            this.moveTo(x + rr, y);
            this.arcTo(x + w, y, x + w, y + h, rr);
            this.arcTo(x + w, y + h, x, y + h, rr);
            this.arcTo(x, y + h, x, y, rr);
            this.arcTo(x, y, x + w, y, rr);
            this.closePath();
            return this;
        };
    }

    // ------------------------------------------------------------- geometry

    const CAR = { len: 4.5, wid: 1.8, wheelbase: 2.7 };
    CAR.half = CAR.len / 2;
    CAR.halfW = CAR.wid / 2;
    CAR.axle = CAR.wheelbase / 2;
    CAR.rearOverhang = CAR.half - CAR.axle;

    const MAX_STEER = 33 * Math.PI / 180;
    const WHEEL_LOCK = 540;
    const STEER_RATE = 90 * Math.PI / 180;
    const TAU_STEER_RETURN = 0.22;
    const V_FORWARD = 3.0;
    const V_REVERSE = 1.8;
    const TAU_ACCEL = 0.36;
    const TAU_DECEL = 0.11;
    const TAU_BRAKE = 0.045;

    const BAY_DEPTH = 2.4;
    const ROAD_BOTTOM = 9;
    const SIDEWALK = 2.5;
    const WORLD_H = ROAD_BOTTOM + SIDEWALK;
    const CENTRE_LINE = (ROAD_BOTTOM - BAY_DEPTH) / 2;
    const CARS_Y = ROAD_BOTTOM - 1.0;
    const LANE_Y = ROAD_BOTTOM - 3.7;
    const PASS_ANGLE = 8 * Math.PI / 180;
    const EDGE_MARGIN = 2.0;
    const VIEW_H_MIN = ROAD_BOTTOM + 0.8;

    const LEVELS = [
        { key: 'easy', gap: 1.70, label: 'Easy' },
        { key: 'normal', gap: 1.50, label: 'Normal' },
        { key: 'hard', gap: 1.30, label: 'Hard' },
    ];

    const C = {
        sky: '#0a0d12',
        walk: '#1c2530',
        road: '#333d4a',
        kerb: '#5b6878',
        lane: 'rgba(255,255,255,.10)',
        paint: 'rgba(226,238,250,.68)',
        bayFill: 'rgba(120,190,255,.05)',
        parked: { body: '#2b3341', roof: '#333d4d', glass: '#161d27', tyre: '#0a0d11', head: '#39434f', tail: '#3d2f35' },
        player: { body: '#dbe4ef', roof: '#f2f6fb', glass: '#26333f', tyre: '#0a0d11', head: '#fff2c4', tail: '#e05252', edge: 'rgba(10,15,22,.55)' },
        bad: 'rgba(255,72,72,',
    };

    const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
    const norm = a => Math.atan2(Math.sin(a), Math.cos(a));
    const rand = (a, b) => a + Math.random() * (b - a);

    // -------------------------------------------------------------- elements

    const canvas = document.getElementById('game');
    const ctx = canvas.getContext('2d');
    const elHits = document.getElementById('hits');
    const elTime = document.getElementById('time');
    const elGear = document.getElementById('gear');
    const elResult = document.getElementById('result');
    const elTitle = document.getElementById('result-title');
    const elSub = document.getElementById('result-sub');
    const elRetry = document.getElementById('retry');
    const elNext = document.getElementById('next');
    const elWheel = document.getElementById('wheel-rim');
    const levelBtns = [...document.querySelectorAll('[data-level]')];

    let W = 0, H = 0, dpr = 1;
    const view = { scale: 1, halfVisible: 1, visH: 1 };

    const state = {
        levelIndex: 1,
        bay: { x0: 0, x1: 0, y0: 0, y1: BAY_DEPTH },
        parked: [],
        car: null,
        hits: 0,
        time: 0,
        done: false,
        flash: 0,
        contacts: new Map(),
        lastHit: new Map(),
        halfW: 0,
    };

    // --------------------------------------------------------------- helpers

    function cornersAt(cx, cy, h) {
        const c = Math.cos(h), s = Math.sin(h);
        const hl = CAR.half, hw = CAR.halfW;
        const local = [[hl, hw], [-hl, hw], [-hl, -hw], [hl, -hw]];
        return local.map(([lx, ly]) => ({ x: cx + c * lx - s * ly, y: cy + s * lx + c * ly }));
    }

    function playerCorners(car) {
        const c = Math.cos(car.h), s = Math.sin(car.h);
        return cornersAt(car.x + c * CAR.axle, car.y + s * CAR.axle, car.h);
    }

    function axesOf(quad) {
        const out = [];
        for (let i = 0; i < 2; i++) {
            const a = quad[i], b = quad[i + 1];
            const ex = b.x - a.x, ey = b.y - a.y;
            const len = Math.hypot(ex, ey) || 1;
            out.push({ x: -ey / len, y: ex / len });
        }
        return out;
    }

    function project(quad, ax) {
        let min = Infinity, max = -Infinity;
        for (const p of quad) {
            const d = p.x * ax.x + p.y * ax.y;
            if (d < min) min = d;
            if (d > max) max = d;
        }
        return [min, max];
    }

    function overlaps(a, b) {
        const axes = axesOf(a).concat(axesOf(b));
        for (const ax of axes) {
            const [a0, a1] = project(a, ax);
            const [b0, b1] = project(b, ax);
            if (a1 <= b0 || b1 <= a0) return false;
        }
        return true;
    }

    // ------------------------------------------------------------ level init

    function spawnCar(half) {
        const baseX = half + CAR.rearOverhang;
        for (let i = 0; i < 80; i++) {
            const car = {
                x: baseX + rand(-1.2, 2.4),
                y: LANE_Y + rand(-0.7, 0.1),
                h: rand(-4, 4) * Math.PI / 180,
                v: 0,
                steer: 0,
            };
            const quad = playerCorners(car);
            const onRoad = quad.every(c => c.y > 0.15 && c.y < state.bay.y0 - 0.08);
            const clear = state.parked.every(p => !overlaps(quad, p.corners));
            if (onRoad && clear) return car;
        }
        return { x: baseX, y: LANE_Y, h: 0, v: 0, steer: 0 };
    }

    function buildLevel(index) {
        state.levelIndex = index;
        const level = LEVELS[index];
        const gap = CAR.len * level.gap;
        const half = gap / 2;

        state.bay = { x0: -half, x1: half, y0: ROAD_BOTTOM - BAY_DEPTH, y1: ROAD_BOTTOM };
        state.halfW = half + CAR.len + EDGE_MARGIN;

        state.parked = [
            { id: 'ahead', cx: half + CAR.half, cy: CARS_Y, h: 0 },
            { id: 'behind', cx: -half - CAR.half, cy: CARS_Y, h: 0 },
        ];
        for (const p of state.parked) p.corners = cornersAt(p.cx, p.cy, p.h);

        state.car = spawnCar(half);
    }

    function start(index) {
        state.hits = 0;
        state.time = 0;
        state.done = false;
        state.flash = 0;
        state.contacts.clear();
        state.lastHit.clear();
        buildLevel(index);

        elResult.classList.add('hidden');
        hud = { hits: -1, time: '', gear: '' };
        for (const b of levelBtns) b.setAttribute('aria-pressed', String(Number(b.dataset.level === LEVELS[index].key)));

        const nextIndex = index + 1;
        elNext.disabled = nextIndex >= LEVELS.length;
    }

    // ----------------------------------------------------------------- input

    const keys = new Set();
    const BLOCKED = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

    addEventListener('keydown', e => {
        if (BLOCKED.has(e.code)) e.preventDefault();
        if (e.code === 'KeyR') { start(state.levelIndex); return; }
        keys.add(e.code);
    });
    addEventListener('keyup', e => { keys.delete(e.code); });
    addEventListener('blur', () => keys.clear());

    for (const b of levelBtns) {
        b.addEventListener('click', () => start(LEVELS.findIndex(l => l.key === b.dataset.level)));
    }
    elRetry.addEventListener('click', () => start(state.levelIndex));
    elNext.addEventListener('click', () => {
        if (state.levelIndex + 1 < LEVELS.length) start(state.levelIndex + 1);
    });

    // ---------------------------------------------------------------- update

    function update(dt) {
        const car = state.car;
        state.flash = Math.max(0, state.flash - dt * 2.2);

        if (IS_TOUCH && W < H && W < 620) { car.v = 0; return; }
        if (state.done) { car.v = 0; return; }

        const left = keys.has('KeyA') || keys.has('ArrowLeft');
        const right = keys.has('KeyD') || keys.has('ArrowRight');
        const fwd = keys.has('KeyW') || keys.has('ArrowUp');
        const rev = keys.has('KeyS') || keys.has('ArrowDown');
        const brake = keys.has('Space');

        const dir = (right ? 1 : 0) - (left ? 1 : 0);
        if (dir !== 0) {
            car.steer = clamp(car.steer + dir * STEER_RATE * dt, -MAX_STEER, MAX_STEER);
        } else {
            car.steer *= Math.exp(-dt / TAU_STEER_RETURN);
            if (Math.abs(car.steer) < 0.002) car.steer = 0;
        }

        let target = 0;
        if (fwd && !rev) target = V_FORWARD;
        else if (rev && !fwd) target = -V_REVERSE;

        let tau = Math.abs(target) < Math.abs(car.v) ? TAU_DECEL : TAU_ACCEL;
        if (brake) { target = 0; tau = TAU_BRAKE; }

        car.v += (target - car.v) * (1 - Math.exp(-dt / tau));
        if (Math.abs(car.v) < 0.006) car.v = 0;

        car.h += (car.v / CAR.wheelbase) * Math.tan(car.steer) * dt;
        car.x += Math.cos(car.h) * car.v * dt;
        car.y += Math.sin(car.h) * car.v * dt;

        state.time += dt;

        const quad = playerCorners(car);

        for (const p of state.parked) bump(p.id, overlaps(quad, p.corners));
        bump('kerb', quad.some(c => c.y < 0 || c.y > ROAD_BOTTOM));

        if (state.done) return;

        const b = state.bay;
        const inside = quad.every(c => c.x > b.x0 && c.x < b.x1 && c.y > b.y0 && c.y < b.y1);
        if (inside && Math.abs(norm(car.h)) < PASS_ANGLE && Math.abs(car.v) < 0.12) finish();
    }

    function bump(id, touching) {
        const was = state.contacts.get(id) || false;
        if (touching && !was) {
            const last = state.lastHit.get(id);
            if (last === undefined || state.time - last > 0.4) {
                state.hits++;
                state.lastHit.set(id, state.time);
                state.flash = 1;
            }
        }
        state.contacts.set(id, touching);
    }

    function finish() {
        state.done = true;
        state.car.v = 0;
        state.car.steer = 0;

        elTitle.textContent = state.hits === 0 ? 'Clean park' : 'Parked';
        elSub.textContent = `${state.hits} hit${state.hits === 1 ? '' : 's'} · ${state.time.toFixed(1)}s`;
        elResult.classList.remove('hidden');
    }

    // ------------------------------------------------------------- rendering

    function layout() {
        const worldW = state.halfW * 2;
        const s = Math.min(W / worldW, H / VIEW_H_MIN);
        view.scale = s;
        view.halfVisible = W / (2 * s);
        view.visH = H / s;
    }

    function render() {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = C.sky;
        ctx.fillRect(0, 0, W, H);

        layout();

        ctx.save();
        ctx.translate(W / 2, 0);
        ctx.scale(view.scale, view.scale);

        drawGround();
        drawBay();
        for (const p of state.parked) drawCar(p.cx, p.cy, p.h, 0, C.parked);

        const car = state.car;
        const cos = Math.cos(car.h), sin = Math.sin(car.h);
        drawCar(car.x + cos * CAR.axle, car.y + sin * CAR.axle, car.h, car.steer, C.player);

        ctx.restore();

        if (state.flash > 0) {
            const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.72);
            g.addColorStop(0, C.bad + '0)');
            g.addColorStop(1, C.bad + (0.5 * state.flash).toFixed(3) + ')');
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, W, H);
        }
    }

    function drawGround() {
        const hw = view.halfVisible;
        const w = hw * 2;
        const bottom = Math.max(view.visH, WORLD_H);

        ctx.fillStyle = C.road;
        ctx.fillRect(-hw, 0, w, ROAD_BOTTOM);

        ctx.fillStyle = C.walk;
        ctx.fillRect(-hw, ROAD_BOTTOM, w, bottom - ROAD_BOTTOM);

        ctx.strokeStyle = 'rgba(255,255,255,.045)';
        ctx.lineWidth = 0.035;
        ctx.beginPath();
        for (let x = -hw; x <= hw; x += 1.2) {
            ctx.moveTo(x, ROAD_BOTTOM + 0.1);
            ctx.lineTo(x, bottom);
        }
        ctx.stroke();

        ctx.fillStyle = C.kerb;
        ctx.fillRect(-hw, 0, w, 0.2);
        ctx.fillRect(-hw, ROAD_BOTTOM - 0.2, w, 0.2);

        ctx.save();
        ctx.setLineDash([1.7, 1.5]);
        ctx.lineWidth = 0.11;
        ctx.strokeStyle = C.lane;
        ctx.beginPath();
        ctx.moveTo(-hw, CENTRE_LINE);
        ctx.lineTo(hw, CENTRE_LINE);
        ctx.stroke();
        ctx.restore();
    }

    function drawBay() {
        const b = state.bay;

        ctx.fillStyle = C.bayFill;
        ctx.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);

        ctx.save();
        ctx.strokeStyle = C.paint;
        ctx.lineWidth = 0.12;
        ctx.lineCap = 'square';
        ctx.setLineDash([0.42, 0.3]);
        ctx.beginPath();
        ctx.moveTo(b.x0, b.y0);
        ctx.lineTo(b.x0, b.y1 - 0.05);
        ctx.moveTo(b.x1, b.y0);
        ctx.lineTo(b.x1, b.y1 - 0.05);
        ctx.moveTo(b.x0, b.y0);
        ctx.lineTo(b.x1, b.y0);
        ctx.stroke();
        ctx.restore();
    }

    function drawCar(cx, cy, h, steer, look) {
        const hl = CAR.half, hw = CAR.halfW, ax = CAR.axle;
        const tw = 0.62, th = 0.26;

        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(h);

        ctx.fillStyle = look.tyre;
        for (const s of [-1, 1]) {
            ctx.beginPath();
            ctx.roundRect(-ax - tw / 2, s * (hw - 0.02) - th / 2, tw, th, 0.09);
            ctx.fill();
        }
        for (const s of [-1, 1]) {
            ctx.save();
            ctx.translate(ax, s * (hw - 0.02));
            ctx.rotate(steer);
            ctx.beginPath();
            ctx.roundRect(-tw / 2, -th / 2, tw, th, 0.09);
            ctx.fill();
            ctx.restore();
        }

        ctx.beginPath();
        ctx.roundRect(-hl, -hw, CAR.len, CAR.wid, 0.42);
        ctx.fillStyle = look.body;
        ctx.fill();
        if (look.edge) {
            ctx.strokeStyle = look.edge;
            ctx.lineWidth = 0.055;
            ctx.stroke();
        }

        ctx.fillStyle = look.glass;
        ctx.beginPath();
        ctx.moveTo(-1.20, -hw + 0.18);
        ctx.lineTo(1.30, -hw + 0.22);
        ctx.lineTo(1.30, hw - 0.22);
        ctx.lineTo(-1.20, hw - 0.18);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = look.roof;
        ctx.beginPath();
        ctx.roundRect(-0.70, -hw + 0.30, 1.40, CAR.wid - 0.60, 0.20);
        ctx.fill();

        ctx.fillStyle = look.head;
        ctx.beginPath();
        ctx.roundRect(hl - 0.17, -hw + 0.16, 0.15, 0.32, 0.06);
        ctx.roundRect(hl - 0.17, hw - 0.48, 0.15, 0.32, 0.06);
        ctx.fill();

        ctx.fillStyle = look.tail;
        ctx.beginPath();
        ctx.roundRect(-hl + 0.02, -hw + 0.16, 0.15, 0.32, 0.06);
        ctx.roundRect(-hl + 0.02, hw - 0.48, 0.15, 0.32, 0.06);
        ctx.fill();

        ctx.restore();
    }

    // ------------------------------------------------------------------- hud

    let hud = { hits: -1, time: '', gear: '', wheel: null };

    function updateHud() {
        if (state.hits !== hud.hits) {
            elHits.textContent = String(state.hits);
            hud.hits = state.hits;
        }
        const t = state.time.toFixed(1) + 's';
        if (t !== hud.time) {
            elTime.textContent = t;
            hud.time = t;
        }
        const v = state.car ? state.car.v : 0;
        const g = v < -0.05 ? 'R' : v > 0.05 ? 'D' : 'N';
        if (g !== hud.gear) {
            elGear.textContent = g;
            elGear.dataset.gear = g;
            hud.gear = g;
        }
        const w = state.car ? (state.car.steer / MAX_STEER) * WHEEL_LOCK : 0;
        if (w !== hud.wheel) {
            elWheel.style.transform = `rotate(${w.toFixed(1)}deg)`;
            hud.wheel = w;
        }
    }

    // ------------------------------------------------------------------ boot

    const IS_TOUCH = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;

    if (IS_TOUCH) {
        document.body.classList.add('touch');

        for (const el of document.querySelectorAll('[data-key]')) {
            const code = el.dataset.key;
            const release = () => { el.classList.remove('on'); keys.delete(code); };
            const engage = e => {
                e.preventDefault();
                el.classList.add('on');
                keys.add(code);
                if (el.setPointerCapture) {
                    try { el.setPointerCapture(e.pointerId); } catch (_) { }
                }
            };
            el.addEventListener('pointerdown', engage);
            el.addEventListener('pointerup', release);
            el.addEventListener('pointercancel', release);
            el.addEventListener('lostpointercapture', release);
            el.addEventListener('contextmenu', e => e.preventDefault());
        }
    }

    function resize() {
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        W = canvas.clientWidth;
        H = canvas.clientHeight;
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
    }

    let last = 0;
    function frame(t) {
        const dt = last ? Math.min(0.033, (t - last) / 1000) : 0.016;
        last = t;
        update(dt);
        render();
        updateHud();
        requestAnimationFrame(frame);
    }

    addEventListener('resize', resize);
    addEventListener('orientationchange', () => setTimeout(resize, 150));
    if (window.visualViewport) visualViewport.addEventListener('resize', resize);
    if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas);
    resize();
    start(1);
    requestAnimationFrame(frame);

})();
