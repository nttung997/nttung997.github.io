'use strict';

(() => {

    /* ------------------------------------------------------------- geometry */

    // Toyota Vios (XP150, the sedan used for hạng B): 4425 × 1730 mm, wheelbase 2550 mm,
    // rear overhang 965 mm. Body centre sits that far ahead of the rear axle.
    const CAR = { len: 4.425, wid: 1.730, wheelbase: 2.550, rearOverhang: 0.965 };
    CAR.half = CAR.len / 2;
    CAR.halfW = CAR.wid / 2;
    CAR.center = CAR.half - CAR.rearOverhang;

    const MAX_STEER = 33 * Math.PI / 180;
    const WHEEL_LOCK = 540;
    const WHEEL_RPM = 60;
    const STEER_RATE = (WHEEL_RPM / 60) * MAX_STEER / (WHEEL_LOCK / 360);
    const WHEEL_TRAVEL = 1080 * Math.PI / 180;
    const WHEEL_VISUAL = WHEEL_TRAVEL / (2 * MAX_STEER);
    const V_FORWARD = 3.0;
    const V_REVERSE = 1.8;
    const TAU_ACCEL = 0.36;
    const TAU_DECEL = 0.11;
    const TAU_BRAKE = 0.045;

    // QCVN 40:2024 hạng B, clause 2.1.15.8 (Hình 13): Lg = 3a/2, Rg = 5b/4.
    // For the Vios below that is 6.64 x 2.16 m, the size of the real test bay.
    const BAY_LEN = 3 * CAR.len / 2;
    const BAY_DEPTH = 5 * CAR.wid / 4;
    const CURB_BAND = 0.25;
    const REAR_MARK = 1.0;
    // Asphalt strip between the painted bay and the kerb face (measured 0.25-0.33 m),
    // and the contact tolerance before a hit is scored.
    const KERB_GAP = 0.25;
    const KERB_TOL = 0.02;
    // Vios front track 1470 mm, tyre 185 mm. TRACK is the wheel-centre offset.
    const TRACK = 1.470 / 2;
    const TIRE_HALF = 0.185 / 2;
    const TIRE_R = 0.302;
    const ROAD_BOTTOM = 9;
    const SIDEWALK = 2.5;
    const CENTRE_LINE = (ROAD_BOTTOM - BAY_DEPTH) / 2;
    const LANE_Y = ROAD_BOTTOM - 3.7;
    const EDGE_LINE = 0.2;
    const EDGE_HIT = EDGE_LINE + 0.06;
    const LOT_EDGE = ROAD_BOTTOM - BAY_DEPTH;
    const PAVE_RISE = 0.14;

    const EYE = { fwd: 0.25, up: 1.24, side: -0.26 };
    const DRIVER_Z = -0.42;
    const PITCH = -0.07;
    const FOV = 64;

    const PLAYER_PAINT = { body: 0xf2f5f8 };

    const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
    const rand = (a, b) => a + Math.random() * (b - a);

    /* -------------------------------------------------------------- elements */

    const canvas = document.getElementById('game');
    const elHits = document.getElementById('hits');
    const elTime = document.getElementById('time');
    const elGear = document.getElementById('gear');
    const elResult = document.getElementById('result');
    const elTitle = document.getElementById('result-title');
    const elSub = document.getElementById('result-sub');
    const elRetry = document.getElementById('retry');
    const elLook = document.getElementById('look');
    const elFlash = document.getElementById('flash');
    const elCamLeft = document.getElementById('cam-left');
    const elCamRear = document.getElementById('cam-rear');
    const elCamRight = document.getElementById('cam-right');
    const elNoGL = document.getElementById('nogl');

    let W = 0, H = 0;

    const state = {
        bay: { x0: 0, x1: 0, y0: 0, y1: BAY_DEPTH },
        car: null,
        hits: 0,
        time: 0,
        done: false,
        flash: 0,
        contacts: new Map(),
        lastHit: new Map(),
    };

    /* ---------------------------------------------------------------- helpers */

    function cornersAt(cx, cy, h) {
        const c = Math.cos(h), s = Math.sin(h);
        const hl = CAR.half, hw = CAR.halfW;
        const local = [[hl, hw], [-hl, hw], [-hl, -hw], [hl, -hw]];
        return local.map(([lx, ly]) => ({ x: cx + c * lx - s * ly, y: cy + s * lx + c * ly }));
    }

    function playerCorners(car) {
        const c = Math.cos(car.h), s = Math.sin(car.h);
        return cornersAt(car.x + c * CAR.center, car.y + s * CAR.center, car.h);
    }

    // car.x/car.y is the rear axle. lateral > 0 is local +y, which faces the kerb at heading 0.
    function axlePoint(car, forward, lateral) {
        const c = Math.cos(car.h), s = Math.sin(car.h);
        return {
            x: car.x + c * forward - s * lateral,
            y: car.y + s * forward + c * lateral,
        };
    }

    function tireOuter(car, forward, side) {
        return axlePoint(car, forward, side * (TRACK + TIRE_HALF));
    }

    // Yard beep for ghép ngang: stopped, body and tyres inside the bay, both
    // kerb-side tyres within 25 cm of the kerb (not on it), both rear wheels
    // past the yellow line 1 m in from the back wall.
    function parkedInSpec(car) {
        if (Math.abs(car.v) >= 0.12) return false;
        const b = state.bay;
        const inside = p => p.x > b.x0 && p.x < b.x1 && p.y > b.y0 && p.y < b.y1;
        if (!playerCorners(car).every(inside)) return false;

        const sideOf = sign => ({
            front: tireOuter(car, CAR.wheelbase, sign),
            rear: tireOuter(car, 0, sign),
        });
        const left = sideOf(1);
        const right = sideOf(-1);
        const curb = (left.front.y + left.rear.y) >= (right.front.y + right.rear.y) ? left : right;
        if (b.y1 - curb.front.y > CURB_BAND || b.y1 - curb.rear.y > CURB_BAND) return false;

        const rearL = axlePoint(car, 0, TRACK);
        const rearR = axlePoint(car, 0, -TRACK);
        if (rearL.x > b.x0 + REAR_MARK || rearR.x > b.x0 + REAR_MARK) return false;

        return [left.front, left.rear, right.front, right.rear].every(inside);
    }

    /* ------------------------------------------------------------ level init */

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
            if (onRoad) return car;
        }
        return { x: baseX, y: LANE_Y, h: 0, v: 0, steer: 0 };
    }

    function buildLevel() {
        const half = BAY_LEN / 2;

        state.bay = { x0: -half, x1: half, y0: ROAD_BOTTOM - BAY_DEPTH, y1: ROAD_BOTTOM };

        state.car = spawnCar(half);
    }

    function start() {
        state.hits = 0;
        state.time = 0;
        state.done = false;
        state.flash = 0;
        state.contacts.clear();
        state.lastHit.clear();
        buildLevel();

        syncLevelMeshes();

        elResult.classList.add('hidden');
        hud = { hits: -1, time: '', gear: '' };
    }

    /* ------------------------------------------------------------ three.js */

    let renderer, scene, camera;
    let rearCamera, leftCamera, rightCamera;
    let cockpit, playerCar, bayGroup;
    let playerFrontWheels = [];
    let carGeo = null;
    const carMats = new Map();

    const views = {
        left: { x: 0, top: 70, w: 0, h: 0 },
        rear: { x: 0, top: 70, w: 0, h: 0 },
        right: { x: 0, top: 70, w: 0, h: 0 },
    };

    /* --------------------------------------------------------- asset pipeline */

    const TEX_DIR = 'assets/tex/';
    const SFX_DIR = 'assets/sfx/';

    // A "surface" is one physical material source (asphalt, concrete) made of
    // three maps. The procedural canvas textures stay live until every JPEG of
    // the surface has decoded; a failed load (file:// CORS, 404, decode error)
    // simply leaves the procedural maps in place, so rendering never breaks.
    const SURFACES = {
        asphalt: {
            files: [
                ['map', 'asphalt_diff.jpg', true],
                ['normalMap', 'asphalt_nor.jpg', false],
                ['roughnessMap', 'asphalt_rough.jpg', false],
            ],
            maps: null,
            users: [],
        },
        concrete: {
            files: [
                ['map', 'concrete_diff.jpg', true],
                ['normalMap', 'concrete_nor.jpg', false],
                ['roughnessMap', 'concrete_rough.jpg', false],
            ],
            maps: null,
            users: [],
        },
    };

    const texLoader = new THREE.TextureLoader();
    const surfaceUsers = new WeakMap();
    let maxAniso = 1;

    function loadSurfaces() {
        maxAniso = renderer.capabilities.getMaxAnisotropy();
        loadSurface(SURFACES.asphalt);
        loadSurface(SURFACES.concrete);
    }

    function loadSurface(surf) {
        const out = {};
        let pending = surf.files.length;
        let dead = false;

        for (const entry of surf.files) {
            const slot = entry[0];
            const srgb = entry[2];
            texLoader.load(
                TEX_DIR + entry[1],
                tex => {
                    if (dead) return;
                    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
                    tex.anisotropy = maxAniso;
                    tex.encoding = srgb ? THREE.sRGBEncoding : THREE.LinearEncoding;
                    out[slot] = tex;
                    if (--pending > 0) return;
                    surf.maps = out;
                    for (const user of surf.users) applySurface(user);
                    surf.users.length = 0;
                },
                undefined,
                () => { dead = true; }   // keep the procedural fallback
            );
        }
    }

    // Cloned per user only because the repeat differs; a clone shares the
    // decoded image with the original, so only one download/upload happens.
    function applySurface(user) {
        if (!user.live) return;
        const maps = SURFACES[user.name].maps;
        if (!maps) return;

        const m = user.mat;
        for (const slot in maps) {
            const tex = maps[slot].clone();
            tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
            tex.anisotropy = maxAniso;
            tex.repeat.set(user.rx, user.ry);
            const old = m[slot];
            if (old && old !== tex && old.userData && old.userData.procedural) old.dispose();
            m[slot] = tex;
        }
        m.roughness = 1.0;          // roughness now comes from roughnessMap
        m.needsUpdate = true;
    }

    function useSurface(mat, name, rx, ry) {
        const user = { mat, name, rx, ry, live: true };
        surfaceUsers.set(mat, user);
        const surf = SURFACES[name];
        if (surf.maps) applySurface(user);
        else surf.users.push(user);
        return user;
    }

    // Called when a level-owned material goes away so the swap never touches
    // (or keeps alive) a dead material.
    function dropSurfaceUser(mat) {
        const user = surfaceUsers.get(mat);
        if (!user) return;
        user.live = false;
        const list = SURFACES[user.name].users;
        const i = list.indexOf(user);
        if (i >= 0) list.splice(i, 1);
        surfaceUsers.delete(mat);
    }

    /* ------------------------------------------------------------- sound effects */

    // Small pre-created pools: rapid hits reuse a different voice instead of
    // cutting the previous one off. Everything is local, loaded once.
    const sfxPools = {};
    let muted = false;

    function initSfx() {
        buildPool('hit', 0.5, 3);
        buildPool('click', 0.4, 2);
        buildPool('success', 0.55, 2);
    }

    function buildPool(name, volume, voices) {
        const list = [];
        for (let i = 0; i < voices; i++) {
            const a = new Audio(SFX_DIR + name + '.wav');
            a.preload = 'auto';
            a.volume = volume;
            list.push(a);
        }
        sfxPools[name] = { list, next: 0 };
    }

    function playSfx(name) {
        if (muted) return;
        const pool = sfxPools[name];
        if (!pool) return;
        const a = pool.list[pool.next];
        pool.next = (pool.next + 1) % pool.list.length;
        try { a.currentTime = 0; } catch (_) { }
        const p = a.play();
        if (p && typeof p.catch === 'function') p.catch(() => { });   // autoplay policy
    }

    function initThree() {
        if (THREE.ColorManagement) {
            if ('legacyMode' in THREE.ColorManagement) THREE.ColorManagement.legacyMode = false;
            THREE.ColorManagement.enabled = true;
        }

        try {
            renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
        } catch (err) {
            elNoGL.hidden = false;
            return false;
        }

        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        renderer.outputEncoding = THREE.sRGBEncoding;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.0;
        renderer.autoClear = false;
        renderer.setClearColor(0x0a0d12, 1);

        scene = new THREE.Scene();
        scene.fog = new THREE.Fog(0x101822, 30, 120);

        camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 260);
        camera.rotation.order = 'YXZ';
        scene.add(camera);

        rearCamera = new THREE.PerspectiveCamera(58, 3, 0.1, 220);
        scene.add(rearCamera);
        leftCamera = new THREE.PerspectiveCamera(38, 2.4, 0.05, 220);
        scene.add(leftCamera);
        rightCamera = new THREE.PerspectiveCamera(38, 2.4, 0.05, 220);
        scene.add(rightCamera);

        scene.add(new THREE.HemisphereLight(0x9dc0ea, 0x151a21, 0.5));

        const keyLight = new THREE.DirectionalLight(0xc7d9f5, 1.2);
        keyLight.position.set(-13, 26, -12);
        keyLight.target.position.set(0, 0, 6);
        keyLight.castShadow = true;
        keyLight.shadow.mapSize.set(1024, 1024);
        keyLight.shadow.camera.left = -24;
        keyLight.shadow.camera.right = 24;
        keyLight.shadow.camera.top = 24;
        keyLight.shadow.camera.bottom = -24;
        keyLight.shadow.camera.near = 1;
        keyLight.shadow.camera.far = 70;
        keyLight.shadow.bias = -0.0008;
        scene.add(keyLight);
        scene.add(keyLight.target);

        addStreetLights();

        buildSky();
        buildGround();
        buildBuildings();
        buildLamps();

        initCarAssets();
        bayGroup = new THREE.Group();
        scene.add(bayGroup);

        playerCar = makePlayerCar();
        scene.add(playerCar);

        cockpit = buildCockpit();
        const cabinLight = new THREE.PointLight(0xbcd2ee, 0.7, 3.2, 1.4);
        cabinLight.position.set(0.35, 1.45, -0.15);
        cockpit.add(cabinLight);
        playerCar.add(cockpit);

        // Start fetching the real textures last: every material that wants one
        // has been registered by now, and the first frame never waits on I/O.
        loadSurfaces();

        return true;
    }

    function addStreetLights() {
        for (const x of [-12, 0, 12]) {
            const road = new THREE.PointLight(0xffd6a0, 0.45, 26, 1.6);
            road.position.set(x, 6.1, 1.2);
            scene.add(road);

            const kerb = new THREE.SpotLight(0xffd2a0, 3.2, 20, 0.5, 0.75, 1.2);
            kerb.position.set(x, 6.2, 9.1);
            kerb.target.position.set(x, 0, 8);
            scene.add(kerb);
            scene.add(kerb.target);
        }
    }

    function buildSky() {
        const c = document.createElement('canvas');
        c.width = 8;
        c.height = 256;
        const g = c.getContext('2d');
        const grad = g.createLinearGradient(0, 0, 0, 256);
        grad.addColorStop(0, '#04060b');
        grad.addColorStop(0.52, '#08111b');
        grad.addColorStop(0.74, '#132030');
        grad.addColorStop(1, '#101822');

        g.fillStyle = grad;
        g.fillRect(0, 0, 8, 256);
        const tex = new THREE.CanvasTexture(c);
        tex.encoding = THREE.sRGBEncoding;

        const sky = new THREE.Mesh(
            new THREE.SphereGeometry(190, 32, 16),
            new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false, depthWrite: false })
        );
        sky.renderOrder = -10;
        scene.add(sky);
    }

    function buildGround() {
        const asphalt = makeAsphaltTexture();
        const roadMat = new THREE.MeshStandardMaterial({ map: asphalt, roughness: 1.0, metalness: 0.02 });
        useSurface(roadMat, 'asphalt', 64, 3);
        const road = new THREE.Mesh(new THREE.PlaneGeometry(240, ROAD_BOTTOM), roadMat);
        road.rotation.x = -Math.PI / 2;
        road.position.set(0, 0, ROAD_BOTTOM / 2);
        road.receiveShadow = true;
        scene.add(road);

        const paveMat = new THREE.MeshStandardMaterial({ map: makePavementTexture(), roughness: 1.0, metalness: 0.02 });
        useSurface(paveMat, 'concrete', 80, 1.6);
        for (const z of [-SIDEWALK / 2, ROAD_BOTTOM + SIDEWALK / 2]) {
            const walk = new THREE.Mesh(new THREE.BoxGeometry(240, 0.14, SIDEWALK), paveMat);
            walk.position.set(0, 0.07, z);
            walk.receiveShadow = true;
            scene.add(walk);
        }

        const kerbMat = new THREE.MeshStandardMaterial({ color: 0x66758a, roughness: 0.75, metalness: 0.05 });
        const kerb = new THREE.Mesh(new THREE.BoxGeometry(240, 0.17, 0.16), kerbMat);
        kerb.position.set(0, 0.085, 0.08);
        kerb.receiveShadow = true;
        scene.add(kerb);

        const paintMat = new THREE.MeshStandardMaterial({ color: 0xdfe9f5, roughness: 0.6, metalness: 0.05 });
        for (let x = -110; x < 110; x += 3.2) {
            const dash = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.02, 0.12), paintMat);
            dash.position.set(x, 0.02, CENTRE_LINE);
            scene.add(dash);
        }

        const edge = new THREE.Mesh(new THREE.BoxGeometry(240, 0.02, 0.12), paintMat);
        edge.position.set(0, 0.022, EDGE_LINE);
        scene.add(edge);
    }

    function addRaisedPavement(group, xFrom, xTo) {
        const len = xTo - xFrom;
        if (len < 0.05) return;

        const tex = makePavementTexture();
        const rx = Math.max(1, len / 3);
        tex.repeat.set(rx, 1.6);

        const top = new THREE.MeshStandardMaterial({ map: tex, roughness: 1.0, metalness: 0.02 });
        useSurface(top, 'concrete', rx, 1.6);
        const side = new THREE.MeshStandardMaterial({ color: 0x4a5462, roughness: 0.85, metalness: 0.05 });
        top.userData.levelOwned = true;
        side.userData.levelOwned = true;

        const mesh = new THREE.Mesh(
            new THREE.BoxGeometry(len, PAVE_RISE, BAY_DEPTH),
            [side, side, top, side, side, side]
        );
        mesh.position.set((xFrom + xTo) / 2, PAVE_RISE / 2, LOT_EDGE + BAY_DEPTH / 2);
        mesh.receiveShadow = true;
        group.add(mesh);
    }

    let lotMat = null;
    let paintMat = null;
    let fillMat = null;
    let markMat = null;

    function lotMaterial() {
        if (!lotMat) {
            const tex = makeAsphaltTexture();
            tex.repeat.set(2, 0.8);
            lotMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 1.0, metalness: 0.02 });
            useSurface(lotMat, 'asphalt', 2, 0.8);
        }
        return lotMat;
    }

    function bayPaint() {
        if (!paintMat) {
            paintMat = new THREE.MeshStandardMaterial({ color: 0xf2f7ff, roughness: 0.55, metalness: 0.05 });
        }
        return paintMat;
    }

    function markPaint() {
        if (!markMat) {
            markMat = new THREE.MeshStandardMaterial({ color: 0xf0c040, roughness: 0.5, metalness: 0.05 });
        }
        return markMat;
    }

    function bayFill() {
        if (!fillMat) {
            fillMat = new THREE.MeshStandardMaterial({
                color: 0x4aa8ff, transparent: true, opacity: 0.16, depthWrite: false, roughness: 1,
            });
        }
        return fillMat;
    }

    function makeAsphaltTexture() {
        const s = 256;
        const c = document.createElement('canvas');
        c.width = s;
        c.height = s;
        const g = c.getContext('2d');
        g.fillStyle = '#313a46';
        g.fillRect(0, 0, s, s);
        for (let i = 0; i < 9000; i++) {
            const v = Math.random();
            g.fillStyle = v < 0.5
                ? 'rgba(12,16,22,' + (0.05 + Math.random() * 0.18).toFixed(3) + ')'
                : 'rgba(150,168,188,' + (0.02 + Math.random() * 0.09).toFixed(3) + ')';
            g.fillRect(Math.random() * s, Math.random() * s, 1.4, 1.4);
        }
        const t = new THREE.CanvasTexture(c);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(64, 3);
        t.encoding = THREE.sRGBEncoding;
        t.anisotropy = renderer.capabilities.getMaxAnisotropy();
        t.userData.procedural = true;
        return t;
    }

    function makePavementTexture() {
        const s = 128;
        const c = document.createElement('canvas');
        c.width = s;
        c.height = s;
        const g = c.getContext('2d');
        g.fillStyle = '#232c37';
        g.fillRect(0, 0, s, s);
        g.strokeStyle = 'rgba(10,14,20,.55)';
        g.lineWidth = 2;
        for (let i = 0; i <= s; i += 32) {
            g.beginPath();
            g.moveTo(i, 0);
            g.lineTo(i, s);
            g.moveTo(0, i);
            g.lineTo(s, i);
            g.stroke();
        }
        for (let i = 0; i < 1400; i++) {
            g.fillStyle = 'rgba(255,255,255,' + (Math.random() * 0.035).toFixed(3) + ')';
            g.fillRect(Math.random() * s, Math.random() * s, 1.5, 1.5);
        }
        const t = new THREE.CanvasTexture(c);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(80, 1.6);
        t.encoding = THREE.sRGBEncoding;
        t.userData.procedural = true;
        return t;
    }

    function buildBuildings() {
        let seed = 70613;
        const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

        const rows = [
            { z: -10.5, depth: 12 },
            { z: 19.5, depth: 12 },
        ];

        for (const row of rows) {
            let x = -95;
            while (x < 95) {
                const w = 6 + rnd() * 12;
                const h = 7 + rnd() * 13;
                const cols = Math.max(2, Math.round(w / 2.6));
                const levels = Math.max(3, Math.round(h / 2.8));
                const tex = facadeTexture(cols, levels, rnd);
                const mat = new THREE.MeshStandardMaterial({
                    map: tex,
                    color: 0x9aa7b8,
                    emissive: 0xffffff,
                    emissiveMap: tex,
                    emissiveIntensity: 0.5,
                    roughness: 0.92,
                    metalness: 0,
                });
                const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, row.depth), mat);
                b.position.set(x + w / 2, h / 2, row.z);
                scene.add(b);
                x += w + 0.5 + rnd() * 1.8;
            }
        }
    }

    function facadeTexture(cols, rows, rnd) {
        const cw = 32, ch = 32;
        const c = document.createElement('canvas');
        c.width = cols * cw;
        c.height = rows * ch;
        const g = c.getContext('2d');

        g.fillStyle = '#11161e';
        g.fillRect(0, 0, c.width, c.height);

        for (let x = 0; x < cols; x++) {
            for (let y = 0; y < rows; y++) {
                const px = x * cw + 7, py = y * ch + 8;
                const lit = rnd() < 0.32;
                if (lit) {
                    g.fillStyle = 'rgba(255,206,132,.28)';
                    g.fillRect(px - 3, py - 3, cw - 8, ch - 10);
                }
                g.fillStyle = lit ? (rnd() < 0.78 ? '#ffd79a' : '#a9d8ff') : '#1a2230';
                g.fillRect(px, py, cw - 14, ch - 16);
            }
        }

        const t = new THREE.CanvasTexture(c);
        t.encoding = THREE.sRGBEncoding;
        return t;
    }

    function buildLamps() {
        const poleMat = new THREE.MeshStandardMaterial({ color: 0x2b3441, roughness: 0.6, metalness: 0.55 });
        const bulbMat = new THREE.MeshStandardMaterial({
            color: 0xffe6bb,
            emissive: 0xffc978,
            emissiveIntensity: 2.4,
            roughness: 0.35,
        });
        const poleGeo = new THREE.CylinderGeometry(0.07, 0.1, 6.4, 8);
        const armGeo = new THREE.CylinderGeometry(0.05, 0.05, 1.9, 8);
        const headGeo = new THREE.BoxGeometry(0.5, 0.14, 0.3);

        for (const row of [{ z: -0.6, dir: 1 }, { z: 10.4, dir: -1 }]) {
            for (let x = -36; x <= 36; x += 12) {
                const pole = new THREE.Mesh(poleGeo, poleMat);
                pole.position.set(x, 3.2, row.z);
                scene.add(pole);

                const arm = new THREE.Mesh(armGeo, poleMat);
                arm.rotation.x = Math.PI / 2;
                arm.position.set(x, 6.25, row.z + row.dir * 0.9);
                scene.add(arm);

                const head = new THREE.Mesh(headGeo, bulbMat);
                head.position.set(x, 6.2, row.z + row.dir * 1.75);
                scene.add(head);
            }
        }
    }

    function initCarAssets() {
        const wheel = new THREE.CylinderGeometry(TIRE_R, TIRE_R, TIRE_HALF * 2, 18);
        wheel.rotateX(Math.PI / 2);
        const light = new THREE.BoxGeometry(0.1, 0.14, 0.3);

        const lower = new THREE.BoxGeometry(CAR.len, 0.52, CAR.wid);
        lower.translate(0, 0.26, 0);
        const hood = new THREE.BoxGeometry(0.85, 0.38, CAR.wid);
        hood.translate(CAR.half - 0.425, 0.71, 0);
        const trunk = new THREE.BoxGeometry(0.9, 0.38, CAR.wid);
        trunk.translate(-CAR.half + 0.45, 0.71, 0);

        carGeo = { wheel, light, lower, hood, trunk };
    }

    function makePlayerCar() {
        const g = new THREE.Group();
        const m = carMaterials(PLAYER_PAINT);
        const floorMat = new THREE.MeshStandardMaterial({ color: 0x1a212b, roughness: 0.92, metalness: 0.05 });

        const seatMat = new THREE.MeshStandardMaterial({ color: 0x232b36, roughness: 0.95, metalness: 0.02 });
        const seatGeo = new THREE.BoxGeometry(0.34, 0.44, 1.62);
        const rearSeat = new THREE.Mesh(seatGeo, seatMat);
        rearSeat.position.set(-1.12, 0.73, 0);

        const headGeo = new THREE.BoxGeometry(0.2, 0.17, 0.3);

        const parts = [
            new THREE.Mesh(carGeo.lower, floorMat),
            new THREE.Mesh(carGeo.hood, m.body),
            new THREE.Mesh(carGeo.trunk, m.body),
            rearSeat,
        ];

        for (const s of [-1, 1]) {
            const head = new THREE.Mesh(headGeo, seatMat);
            head.position.set(-1.12, 1.03, s * 0.4);
            parts.push(head);
        }
        for (const p of parts) {
            p.castShadow = true;
            p.receiveShadow = true;
            g.add(p);
        }

        const front = [];
        for (const sx of [-1, 1]) {
            for (const sz of [-1, 1]) {
                const wheel = new THREE.Mesh(carGeo.wheel, m.tyre);
                const axleX = sx > 0 ? CAR.wheelbase - CAR.center : -CAR.center;
                wheel.position.set(axleX, TIRE_R, sz * TRACK);
                wheel.castShadow = true;
                g.add(wheel);
                if (sx > 0) front.push(wheel);
            }
        }

        for (const sz of [-1, 1]) {
            const head = new THREE.Mesh(carGeo.light, m.head);
            head.position.set(CAR.half - 0.02, 0.74, sz * 0.56);
            g.add(head);
            const tail = new THREE.Mesh(carGeo.light, m.tail);
            tail.position.set(-CAR.half + 0.02, 0.74, sz * 0.56);
            g.add(tail);
        }

        g.userData.front = front;
        return g;
    }

    function carMaterials(p) {
        let m = carMats.get(p.body);
        if (!m) {
            m = {
                body: new THREE.MeshStandardMaterial({ color: p.body, roughness: 0.42, metalness: 0.28 }),
                tyre: new THREE.MeshStandardMaterial({ color: 0x0a0c10, roughness: 0.95, metalness: 0 }),
                head: new THREE.MeshStandardMaterial({
                    color: 0xfff0c8, emissive: 0xffd489, emissiveIntensity: 1.5, roughness: 0.35,
                }),
                tail: new THREE.MeshStandardMaterial({
                    color: 0xc22f36, emissive: 0xc02329, emissiveIntensity: 0.55, roughness: 0.45,
                }),
            };
            carMats.set(p.body, m);
        }
        return m;
    }

    function buildCockpit() {
        const g = new THREE.Group();

        const dashMat = new THREE.MeshStandardMaterial({ color: 0x232c38, roughness: 0.9, metalness: 0.1 });
        const trimMat = new THREE.MeshStandardMaterial({ color: 0x2c3846, roughness: 0.72, metalness: 0.2 });
        const darkMat = new THREE.MeshStandardMaterial({ color: 0x1a1f27, roughness: 0.92, metalness: 0.05 });
        const doorMat = new THREE.MeshStandardMaterial({ color: 0x1b222c, roughness: 0.9, metalness: 0.06 });
        const glowMat = new THREE.MeshStandardMaterial({
            color: 0x2f8ccf, emissive: 0x1f79bd, emissiveIntensity: 0.32, roughness: 0.5,
        });

        const dash = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.26, CAR.wid - 0.16), dashMat);
        dash.position.set(1.115, 0.795, 0);
        g.add(dash);

        const lip = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.05, CAR.wid - 0.2), trimMat);
        lip.position.set(1.355, 0.905, 0);
        g.add(lip);

        const binnacle = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.14, 0.46), darkMat);
        binnacle.position.set(1.0, 0.855, DRIVER_Z);
        g.add(binnacle);

        const cluster = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.07, 0.3), glowMat);
        cluster.position.set(0.915, 0.855, DRIVER_Z);
        g.add(cluster);

        const strip = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.012, 0.92), glowMat);
        strip.position.set(0.95, 0.931, 0.12);
        g.add(strip);

        const col = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.42, 10), darkMat);
        col.rotation.z = Math.PI / 2;
        col.position.set(0.99, 0.86, DRIVER_Z);
        g.add(col);

        const tilt = new THREE.Group();
        tilt.position.set(0.86, 0.97, DRIVER_Z);
        tilt.rotation.z = -0.36;
        g.add(tilt);

        const spin = new THREE.Group();
        tilt.add(spin);

        const face = new THREE.Group();
        face.rotation.y = -Math.PI / 2;
        spin.add(face);

        const rim = new THREE.Mesh(new THREE.TorusGeometry(0.165, 0.025, 10, 32), darkMat);
        face.add(rim);

        const spokeH = new THREE.Mesh(new THREE.BoxGeometry(0.305, 0.026, 0.022), darkMat);
        face.add(spokeH);

        const spokeD = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.15, 0.022), darkMat);
        spokeD.position.set(0, -0.068, 0);
        face.add(spokeD);

        const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.03, 16), darkMat);
        hub.rotation.x = Math.PI / 2;
        face.add(hub);

        for (const s of [-1, 1]) {
            const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.66, 0.07), trimMat);
            pillar.position.set(1.24, 1.16, s * (CAR.halfW - 0.07));
            pillar.rotation.z = 0.22;
            g.add(pillar);

            const door = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.52, 0.06), doorMat);
            door.position.set(0.15, 0.8, s * (CAR.halfW - 0.03));
            g.add(door);

            const sill = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.03, 0.1), trimMat);
            sill.position.set(0.15, 1.07, s * (CAR.halfW - 0.03));
            g.add(sill);
        }

        const header = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.09, CAR.wid), darkMat);
        header.position.set(1.2, 1.64, 0);
        header.rotation.z = 0.08;
        g.add(header);

        g.traverse(o => {
            o.castShadow = false;
            o.receiveShadow = false;
        });

        g.userData.spin = spin;
        return g;
    }

    function clearGroup(group) {
        for (const child of [...group.children]) {
            group.remove(child);
            if (child.geometry) child.geometry.dispose();
            const mats = Array.isArray(child.material) ? child.material : (child.material ? [child.material] : []);
            for (const m of mats) {
                if (m.userData && m.userData.levelOwned) {
                    dropSurfaceUser(m);
                    if (m.map && m.map.userData && m.map.userData.procedural) m.map.dispose();
                    if (m.normalMap && m.normalMap.userData && m.normalMap.userData.procedural) m.normalMap.dispose();
                    if (m.roughnessMap && m.roughnessMap.userData && m.roughnessMap.userData.procedural) m.roughnessMap.dispose();
                    m.dispose();
                }
            }
        }
    }

    function addLine(group, x1, z1, x2, z2, mat, width, lift) {
        const dx = x2 - x1, dz = z2 - z1;
        const len = Math.hypot(dx, dz);
        if (len < 1e-4) return;
        const m = new THREE.Mesh(new THREE.BoxGeometry(len, 0.02, width), mat);
        m.position.set((x1 + x2) / 2, lift || 0.022, (z1 + z2) / 2);
        m.rotation.y = -Math.atan2(dz, dx);
        group.add(m);
    }

    function syncLevelMeshes() {
        if (!scene) return;

        clearGroup(bayGroup);

        const b = state.bay;
        const paint = bayPaint();

        addRaisedPavement(bayGroup, -120, b.x0 - KERB_GAP);
        addRaisedPavement(bayGroup, b.x1 + KERB_GAP, 120);

        const lot = new THREE.Mesh(
            new THREE.PlaneGeometry(b.x1 - b.x0, b.y1 - b.y0),
            lotMaterial()
        );
        lot.rotation.x = -Math.PI / 2;
        lot.position.set((b.x0 + b.x1) / 2, 0.006, (b.y0 + b.y1) / 2);
        lot.receiveShadow = true;
        bayGroup.add(lot);

        const fill = new THREE.Mesh(
            new THREE.PlaneGeometry(b.x1 - b.x0, b.y1 - b.y0),
            bayFill()
        );
        fill.rotation.x = -Math.PI / 2;
        fill.position.set((b.x0 + b.x1) / 2, 0.008, (b.y0 + b.y1) / 2);
        bayGroup.add(fill);

        addLine(bayGroup, b.x0, b.y0, b.x0, b.y1, paint, 0.16);
        addLine(bayGroup, b.x1, b.y0, b.x1, b.y1, paint, 0.16);
        addLine(bayGroup, b.x0, b.y0, b.x1, b.y0, paint, 0.16);

        const mark = markPaint();
        addLine(bayGroup, b.x0, b.y1 - CURB_BAND, b.x1, b.y1 - CURB_BAND, mark, 0.08, 0.03);
        addLine(bayGroup, b.x0 + REAR_MARK, b.y0, b.x0 + REAR_MARK, b.y1, mark, 0.08, 0.03);

        addLine(bayGroup, -120, LOT_EDGE - 0.06, b.x0, LOT_EDGE - 0.06, paint, 0.12);
        addLine(bayGroup, b.x1, LOT_EDGE - 0.06, 120, LOT_EDGE - 0.06, paint, 0.12);

        const car = state.car;
        const bx = car.x + Math.cos(car.h) * CAR.center;
        const bz = car.y + Math.sin(car.h) * CAR.center;
        playerCar.position.set(bx, 0, bz);
        playerCar.rotation.y = -car.h;
        playerFrontWheels = playerCar.userData.front;
    }

    /* ------------------------------------------------------------------- input */

    const keys = new Set();
    const BLOCKED = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

    const LOOK_LIMIT = 2.8;
    const MAX_PITCH = 0.5;

    let yaw = 0, pitch = 0;
    let yawTarget = 0, pitchTarget = 0;
    let dragging = false;
    let lastPX = 0, lastPY = 0;
    let recenterAt = Infinity;
    let snapLook = false;

    addEventListener('keydown', e => {
        if (BLOCKED.has(e.code)) e.preventDefault();
        if (e.repeat) return;
        if (e.code === 'KeyR') { start(); return; }
        if (e.code === 'KeyC') { setLookBack(!snapLook); return; }
        if (e.code === 'KeyM') { muted = !muted; return; }
        keys.add(e.code);
    });
    addEventListener('keyup', e => { keys.delete(e.code); });
    addEventListener('blur', () => keys.clear());

    elRetry.addEventListener('click', () => { playSfx('click'); start(); });

    function setLookBack(on) {
        snapLook = on;
        yawTarget = on ? Math.PI : 0;
        pitchTarget = 0;
        dragging = false;
        recenterAt = Infinity;
        elLook.setAttribute('aria-pressed', String(on));
    }

    elLook.addEventListener('click', e => {
        e.preventDefault();
        playSfx('click');
        setLookBack(!snapLook);
    });

    canvas.addEventListener('pointerdown', e => {
        dragging = true;
        lastPX = e.clientX;
        lastPY = e.clientY;
        recenterAt = Infinity;
        if (canvas.setPointerCapture) {
            try { canvas.setPointerCapture(e.pointerId); } catch (_) { }
        }
    });

    canvas.addEventListener('pointermove', e => {
        if (!dragging) return;
        yawTarget = clamp(yawTarget - (e.clientX - lastPX) * 0.0055, -LOOK_LIMIT, LOOK_LIMIT);
        pitchTarget = clamp(pitchTarget - (e.clientY - lastPY) * 0.0035, -MAX_PITCH, MAX_PITCH);
        lastPX = e.clientX;
        lastPY = e.clientY;
        if (snapLook) {
            snapLook = false;
            elLook.setAttribute('aria-pressed', 'false');
        }
    });

    function endDrag() {
        if (!dragging) return;
        dragging = false;
        recenterAt = performance.now() + 1100;
    }

    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    /* ----------------------------------------------------------------- update */

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
            const back = STEER_RATE * dt;
            car.steer = Math.abs(car.steer) <= back ? 0 : car.steer - Math.sign(car.steer) * back;
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
        const b = state.bay;

        const topLine = quad.some(c => c.y < EDGE_HIT);
        const pavement = quad.some(c => c.y > LOT_EDGE + KERB_TOL
            && (c.x < b.x0 - KERB_GAP - KERB_TOL || c.x > b.x1 + KERB_GAP + KERB_TOL));
        const backWall = quad.some(c => c.y > ROAD_BOTTOM - KERB_TOL);
        bump('kerb', topLine || pavement || backWall);

        if (state.done) return;

        if (parkedInSpec(car)) finish();
    }

    function bump(id, touching) {
        const was = state.contacts.get(id) || false;
        if (touching && !was) {
            const last = state.lastHit.get(id);
            if (last === undefined || state.time - last > 0.4) {
                state.hits++;
                state.lastHit.set(id, state.time);
                state.flash = 1;
                playSfx('hit');
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
        playSfx('success');
    }

    /* --------------------------------------------------------------- camera */

    function updateCamera(dt) {
        if (!dragging && !snapLook && performance.now() > recenterAt) {
            const k = 1 - Math.exp(-dt / 0.45);
            yawTarget -= yawTarget * k;
            pitchTarget -= pitchTarget * k;
            if (Math.abs(yawTarget) < 0.002) yawTarget = 0;
            if (Math.abs(pitchTarget) < 0.002) pitchTarget = 0;
        }

        const ks = 1 - Math.exp(-dt / 0.07);
        yaw += (yawTarget - yaw) * ks;
        pitch += (pitchTarget - pitch) * ks;

        const car = state.car;
        const fx = Math.cos(car.h), fz = Math.sin(car.h);
        const rx = -fz, rz = fx;

        const bx = car.x + fx * CAR.center;
        const bz = car.y + fz * CAR.center;

        const ex = bx + fx * EYE.fwd + rx * EYE.side;
        const ez = bz + fz * EYE.fwd + rz * EYE.side;

        camera.position.set(ex, EYE.up, ez);

        const ca = Math.cos(yaw), sa = Math.sin(yaw);
        const dx = fx * ca + fz * sa;
        const dz = -fx * sa + fz * ca;

        camera.lookAt(ex + dx * 6, EYE.up + Math.tan(PITCH + pitch) * 6, ez + dz * 6);

        playerCar.position.set(bx, 0, bz);
        playerCar.rotation.y = -car.h;
        for (const w of playerFrontWheels) w.rotation.y = -car.steer;
        if (cockpit.userData.spin) cockpit.userData.spin.rotation.x = car.steer * WHEEL_VISUAL;

        cockpit.visible = Math.abs(yaw) < 1.5;

        const rearX = bx - fx * (CAR.half - 0.05);
        const rearZ = bz - fz * (CAR.half - 0.05);
        rearCamera.position.set(rearX, 0.82, rearZ);
        rearCamera.up.set(0, 1, 0);
        rearCamera.lookAt(rearX - fx * 6, -0.5, rearZ - fz * 6);

        placeSideMirror(leftCamera, bx, bz, fx, fz, rx, rz, -0.97, -0.34);
        placeSideMirror(rightCamera, bx, bz, fx, fz, rx, rz, 0.97, 0.34);
    }

    function placeSideMirror(cam, bx, bz, fx, fz, rx, rz, sideZ, outward) {
        const mx = bx + fx * 0.8 + rx * sideZ;
        const mz = bz + fz * 0.8 + rz * sideZ;
        let dx = -fx + rx * outward;
        let dz = -fz + rz * outward;
        const len = Math.hypot(dx, dz) || 1;
        dx /= len;
        dz /= len;
        cam.position.set(mx, 1.02, mz);
        cam.up.set(0, 1, 0);
        cam.lookAt(mx + dx * 6, 1.02 - 1.05, mz + dz * 6);
    }

    /* -------------------------------------------------------------- rendering */

    function render() {
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, W, H);
        renderer.clear();
        renderer.render(scene, camera);

        const wasVisible = cockpit.visible;
        cockpit.visible = false;
        renderer.shadowMap.autoUpdate = false;

        renderMirror(leftCamera, views.left);
        renderMirror(rearCamera, views.rear);
        renderMirror(rightCamera, views.right);

        renderer.shadowMap.autoUpdate = true;
        cockpit.visible = wasVisible;
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, W, H);
    }

    function renderMirror(cam, v) {
        if (v.w < 8 || v.h < 8) return;
        const y = H - v.top - v.h;
        cam.aspect = v.w / v.h;
        cam.updateProjectionMatrix();
        renderer.setScissorTest(true);
        renderer.setViewport(v.x, y, v.w, v.h);
        renderer.setScissor(v.x, y, v.w, v.h);
        renderer.clearDepth();
        renderer.render(scene, cam);
    }

    /* ------------------------------------------------------------------- hud */

    let hud = { hits: -1, time: '', gear: '', flash: -1 };

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
        const f = Math.round(state.flash * 100) / 100;
        if (f !== hud.flash) {
            elFlash.style.opacity = (f * 0.6).toFixed(2);
            hud.flash = f;
        }
    }

    function layoutCameras() {
        const margin = Math.round(clamp(W * 0.016, 10, 22));
        const sideW = Math.round(clamp(W * 0.17, 104, 190));
        const sideH = Math.round(sideW * 0.42);
        const rearW = Math.round(clamp(W * 0.24, 130, 260));
        const rearH = Math.round(rearW * 0.34);
        const top = 70;

        placeView(views.left, elCamLeft, margin, top, sideW, sideH);
        placeView(views.right, elCamRight, W - margin - sideW, top, sideW, sideH);
        placeView(views.rear, elCamRear, Math.round((W - rearW) / 2), top, rearW, rearH);
    }

    function placeView(v, el, x, top, w, h) {
        v.x = x;
        v.top = top;
        v.w = w;
        v.h = h;
        el.style.left = x + 'px';
        el.style.top = top + 'px';
        el.style.width = w + 'px';
        el.style.height = h + 'px';
        el.hidden = false;
    }

    /* ------------------------------------------------------------------ boot */

    const IS_TOUCH = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;

    if (!initThree()) return;

    initSfx();

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
        W = canvas.clientWidth;
        H = canvas.clientHeight;
        if (!W || !H) return;
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(W, H, false);
        renderer.setViewport(0, 0, W, H);
        camera.aspect = W / H;
        camera.updateProjectionMatrix();
        layoutCameras();
    }

    let last = 0;
    function frame(t) {
        const dt = last ? Math.min(0.033, (t - last) / 1000) : 0.016;
        last = t;
        update(dt);
        updateCamera(dt);
        render();
        updateHud();
        requestAnimationFrame(frame);
    }

    addEventListener('resize', resize);
    addEventListener('orientationchange', () => setTimeout(resize, 150));
    if (window.visualViewport) visualViewport.addEventListener('resize', resize);
    if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas);

    resize();
    start();
    requestAnimationFrame(frame);

})();
