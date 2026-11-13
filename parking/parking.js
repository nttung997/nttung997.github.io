'use strict';

(() => {

    /* ------------------------------------------------------------- geometry */

    // The yard maths lives in geometry.js, shared with the 2D sa hình page, so
    // the Node tests exercise exactly what both pages run. This file owns only
    // the road layout and the 3D scene.
    const GEO = window.ParkingGeometry;

    const CAR = GEO.CAR;
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

    // Hạng B, clause 2.1.15.8 (Hình 13): Lg = 3a/2, Rg = 5b/4,
    // which for the Vios is 6.64 x 2.16 m — the size of the real test bay.
    const BAY = GEO.bayAcross(CAR);
    const BAY_LEN = BAY.len;
    const BAY_DEPTH = BAY.depth;
    // Asphalt strip between the painted bay and the kerb face, and the contact
    // tolerance before a hit is scored.
    const KERB_GAP = 0.25;
    const KERB_TOL = 0.02;
    // Vios tyre 185 mm.
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

    // Two neighbours parked against the kerb either side of the bay. The
    // pavement is pulled back to the outer edge of that parking strip.
    const PARKED_GAP = 0.35;
    const PARKED_X = BAY_LEN / 2 + PARKED_GAP + CAR.len / 2;
    const PARKED_Y = ROAD_BOTTOM - CAR.wid / 2 - 0.05;
    const STRIP_HALF = BAY_LEN / 2 + PARKED_GAP + CAR.len + 0.30;
    const PARKED_CARS = [
        { id: 'parked-rear', paint: 0x35618f, x: -PARKED_X, y: PARKED_Y, h: 0 },
        { id: 'parked-front', paint: 0x8f3d3d, x: PARKED_X, y: PARKED_Y, h: 0 },
    ];

    // Quaternius NormalCar1 is 4.221 x 1.177 x 1.807 m as exported. Fit it to
    // the Vios footprint in plan and let the height follow the length scale:
    // the model is a lower, wider sedan than the Vios, so the cabin below is
    // built to the scaled model, not to the real car.
    const MODEL_SCALE = {
        x: CAR.len / 4.221,
        y: CAR.len / 4.221,
        z: CAR.wid / 1.807,
    };

    // Cabin anchors measured from the scaled glazing: window sill 0.80,
    // windshield base (0.90, 0.80), header (0.23, 1.18), headliner 1.19.
    const CABIN = {
        belt: 0.80,
        roof: 1.19,
        cowl: 0.90,
        headerX: 0.23,
        rearGlass: -1.41,
        pillarZ: 0.705,
    };

    const EYE = { fwd: -0.15, up: 1.00, side: -0.34 };
    const DRIVER_Z = -0.34;
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

    function playerCorners(car) {
        return GEO.axleQuad(car, CAR);
    }

    // Same ghép ngang rule as the 2D page: body inside the painted bay, heading
    // within 8° of the kerb, and stopped. No extra kerb-band or rear-line checks.
    function parkedInSpec(car) {
        return GEO.parkedAcross(playerCorners(car), car.h, car.v, state.bay);
    }

    function bodyRect(car) {
        return {
            x: car.x + Math.cos(car.h) * CAR.center,
            y: car.y + Math.sin(car.h) * CAR.center,
            h: car.h,
            half: CAR.half,
            halfW: CAR.halfW,
        };
    }

    function rectCorners(r) {
        const c = Math.cos(r.h), s = Math.sin(r.h);
        return [
            [-r.half, -r.halfW], [r.half, -r.halfW],
            [r.half, r.halfW], [-r.half, r.halfW],
        ].map(([x, y]) => ({
            x: r.x + c * x - s * y,
            y: r.y + s * x + c * y,
        }));
    }

    function separated(a, b, ax, ay) {
        let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
        for (const p of a) {
            const d = p.x * ax + p.y * ay;
            if (d < amin) amin = d;
            if (d > amax) amax = d;
        }
        for (const p of b) {
            const d = p.x * ax + p.y * ay;
            if (d < bmin) bmin = d;
            if (d > bmax) bmax = d;
        }
        return amax < bmin || bmax < amin;
    }

    function rectsOverlap(a, b) {
        const ca = rectCorners(a), cb = rectCorners(b);
        const axes = [
            [1, 0], [0, 1],
            [Math.cos(a.h), Math.sin(a.h)], [-Math.sin(a.h), Math.cos(a.h)],
        ];
        for (const [ax, ay] of axes) if (separated(ca, cb, ax, ay)) return false;
        return true;
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

        state.bay = GEO.makeBay(ROAD_BOTTOM);

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
    let cockpit, playerCar, parkedGroup, bayGroup;
    let playerFrontWheels = [];
    let carModel = null;
    let carModelFrontWheels = [];
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
        // Chrome refuses cross-origin JPEGs on file://, so keep the procedural
        // maps there instead of logging a failed request for every texture.
        if (location.protocol === 'file:') return;
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
        renderer.toneMappingExposure = 1.05;
        renderer.autoClear = false;
        renderer.setClearColor(0xbcd6e8, 1);

        scene = new THREE.Scene();
        scene.fog = new THREE.Fog(0xc7dcec, 45, 160);

        camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 260);
        camera.rotation.order = 'YXZ';
        scene.add(camera);

        rearCamera = new THREE.PerspectiveCamera(58, 3, 0.1, 220);
        scene.add(rearCamera);
        leftCamera = new THREE.PerspectiveCamera(38, 2.4, 0.05, 220);
        scene.add(leftCamera);
        rightCamera = new THREE.PerspectiveCamera(38, 2.4, 0.05, 220);
        scene.add(rightCamera);

        scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x5e6b57, 1.0));

        const keyLight = new THREE.DirectionalLight(0xfff2da, 2.4);
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

        buildSky();
        buildGround();
        buildBuildings();
        buildLamps();
        buildTrees();

        initCarAssets();
        bayGroup = new THREE.Group();
        scene.add(bayGroup);

        playerCar = makePlayerCar();
        scene.add(playerCar);

        parkedGroup = new THREE.Group();
        scene.add(parkedGroup);

        cockpit = buildCockpit();
        const cabinLight = new THREE.PointLight(0xd6e4ff, 0.5, 3.4, 1.2);
        cabinLight.position.set(0.05, 1.12, -0.05);
        cockpit.add(cabinLight);
        playerCar.add(cockpit);

        // Start fetching the real textures last: every material that wants one
        // has been registered by now, and the first frame never waits on I/O.
        loadSurfaces();
        loadCarModel();

        return true;
    }

    function buildSky() {
        const c = document.createElement('canvas');
        c.width = 8;
        c.height = 256;
        const g = c.getContext('2d');
        const grad = g.createLinearGradient(0, 0, 0, 256);
        grad.addColorStop(0, '#4f8fca');
        grad.addColorStop(0.52, '#8ec0e6');
        grad.addColorStop(0.74, '#cfe6f7');
        grad.addColorStop(1, '#e6f2fb');

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

        // Kerb along the back of the parking strip, between the asphalt and
        // the raised pavement behind it.
        const stripKerb = new THREE.Mesh(new THREE.BoxGeometry(240, 0.18, 0.22), kerbMat);
        stripKerb.position.set(0, 0.09, ROAD_BOTTOM + 0.11);
        stripKerb.castShadow = true;
        stripKerb.receiveShadow = true;
        scene.add(stripKerb);
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
        g.fillStyle = '#6f7783';
        g.fillRect(0, 0, s, s);
        for (let i = 0; i < 9000; i++) {
            const v = Math.random();
            g.fillStyle = v < 0.5
                ? 'rgba(48,54,62,' + (0.05 + Math.random() * 0.16).toFixed(3) + ')'
                : 'rgba(238,242,246,' + (0.02 + Math.random() * 0.08).toFixed(3) + ')';
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
        g.fillStyle = '#b9bcc0';
        g.fillRect(0, 0, s, s);
        g.strokeStyle = 'rgba(118,122,128,.4)';
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
            g.fillStyle = 'rgba(60,64,70,' + (Math.random() * 0.05).toFixed(3) + ')';
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
        ];

        for (const row of rows) {
            let x = -95;
            while (x < 95) {
                const w = 6 + rnd() * 12;
                const h = 7 + rnd() * 13;
                const cols = Math.max(2, Math.round(w / 2.6));
                const levels = Math.max(3, Math.round(h / 2.8));
                const tex = facadeTexture(cols, levels);
                const mat = new THREE.MeshStandardMaterial({
                    map: tex,
                    color: 0xb8c1cc,
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

    function facadeTexture(cols, rows) {
        const cw = 32, ch = 32;
        const c = document.createElement('canvas');
        c.width = cols * cw;
        c.height = rows * ch;
        const g = c.getContext('2d');

        g.fillStyle = '#8d96a3';
        g.fillRect(0, 0, c.width, c.height);

        for (let x = 0; x < cols; x++) {
            for (let y = 0; y < rows; y++) {
                const px = x * cw + 7, py = y * ch + 8;
                g.fillStyle = '#5f7488';
                g.fillRect(px, py, cw - 14, ch - 16);
                g.fillStyle = 'rgba(255,255,255,.18)';
                g.fillRect(px, py, cw - 14, 2);
            }
        }

        const t = new THREE.CanvasTexture(c);
        t.encoding = THREE.sRGBEncoding;
        return t;
    }

    function buildLamps() {
        const poleMat = new THREE.MeshStandardMaterial({ color: 0x59626f, roughness: 0.6, metalness: 0.55 });
        const bulbMat = new THREE.MeshStandardMaterial({
            color: 0xdfe6ea,
            emissive: 0xffc978,
            emissiveIntensity: 0.05,
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

    function buildTrees() {
        let seed = 40917;
        const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

        const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 0.95 });
        const leafMats = [
            new THREE.MeshStandardMaterial({ color: 0x3e6b3a, roughness: 0.9 }),
            new THREE.MeshStandardMaterial({ color: 0x4f7d45, roughness: 0.9 }),
        ];
        const trunkGeo = new THREE.CylinderGeometry(0.10, 0.14, 2.2, 8);
        trunkGeo.translate(0, 1.1, 0);
        const leafGeo = new THREE.IcosahedronGeometry(1, 1);

        for (const x of [-14, -5, 5, 14]) {
            const tree = new THREE.Group();
            tree.position.set(x, PAVE_RISE, ROAD_BOTTOM + SIDEWALK / 2);
            tree.rotation.y = rnd() * Math.PI * 2;
            const s = 0.9 + rnd() * 0.35;

            const trunk = new THREE.Mesh(trunkGeo, trunkMat);
            trunk.castShadow = true;
            trunk.receiveShadow = true;
            tree.add(trunk);

            for (const blob of [
                [0, 2.7, 0, 1.0],
                [-0.55, 2.35, 0.2, 0.66],
                [0.5, 2.4, -0.25, 0.72],
            ]) {
                const leaf = new THREE.Mesh(leafGeo, leafMats[rnd() < 0.5 ? 0 : 1]);
                leaf.position.set(blob[0], blob[1], blob[2]);
                leaf.scale.setScalar(blob[3] * s);
                leaf.castShadow = true;
                tree.add(leaf);
            }

            tree.scale.setScalar(s);
            scene.add(tree);
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

    function makePlayerCar(paint) {
        const g = new THREE.Group();
        const m = carMaterials(paint || PLAYER_PAINT);
        const floorMat = new THREE.MeshStandardMaterial({ color: 0x1a212b, roughness: 0.92, metalness: 0.05 });

        const seatMat = new THREE.MeshStandardMaterial({ color: 0x232b36, roughness: 0.95, metalness: 0.02 });
        const seatGeo = new THREE.BoxGeometry(0.34, 0.44, 1.62);
        const rearSeat = new THREE.Mesh(seatGeo, seatMat);
        rearSeat.position.set(-1.12, 0.73, 0);
        rearSeat.castShadow = true;
        rearSeat.receiveShadow = true;

        const headGeo = new THREE.BoxGeometry(0.2, 0.17, 0.3);
        const cabin = new THREE.Group();
        cabin.add(rearSeat);
        for (const s of [-1, 1]) {
            const head = new THREE.Mesh(headGeo, seatMat);
            head.position.set(-1.12, 1.03, s * 0.4);
            head.castShadow = true;
            head.receiveShadow = true;
            cabin.add(head);
        }
        g.add(cabin);
        g.userData.cabin = cabin;

        const shellMats = [m.body, m.body, floorMat, floorMat, m.body, m.body];
        const shell = new THREE.Group();

        const parts = [
            new THREE.Mesh(carGeo.lower, shellMats),
            new THREE.Mesh(carGeo.hood, m.body),
            new THREE.Mesh(carGeo.trunk, m.body),
        ];
        for (const p of parts) {
            p.castShadow = true;
            p.receiveShadow = true;
            shell.add(p);
        }

        const front = [];
        for (const sx of [-1, 1]) {
            for (const sz of [-1, 1]) {
                const wheel = new THREE.Mesh(carGeo.wheel, m.tyre);
                const axleX = sx > 0 ? CAR.wheelbase - CAR.center : -CAR.center;
                wheel.position.set(axleX, TIRE_R, sz * (CAR.halfW - TIRE_HALF + 0.015));
                wheel.castShadow = true;
                shell.add(wheel);
                if (sx > 0) front.push(wheel);
            }
        }

        for (const sz of [-1, 1]) {
            const head = new THREE.Mesh(carGeo.light, m.head);
            head.position.set(CAR.half - 0.02, 0.74, sz * 0.56);
            shell.add(head);
            const tail = new THREE.Mesh(carGeo.light, m.tail);
            tail.position.set(-CAR.half + 0.02, 0.74, sz * 0.56);
            shell.add(tail);
        }

        g.add(shell);
        g.userData.front = front;
        g.userData.shell = shell;
        return g;
    }

    function cloneParkedCar(paint) {
        const clone = carModel.clone(true);
        clone.visible = true;
        clone.traverse(o => {
            if (!o.isMesh) return;
            const src = Array.isArray(o.material) ? o.material : [o.material];
            const mats = src.map(m => {
                if (!m) return m;
                const c = m.clone();
                if (c.name === 'Blue') c.color.set(paint);
                return c;
            });
            o.material = Array.isArray(o.material) ? mats : mats[0];
        });
        return clone;
    }

    // Two static neighbours either side of the bay, using the same GLB as the
    // mirrors when it is available and the procedural body as a fallback.
    function addParkedCars() {
        if (!parkedGroup || parkedGroup.children.length) return;
        for (const spec of PARKED_CARS) {
            const holder = new THREE.Group();
            holder.position.set(spec.x, 0, spec.y);
            holder.add(carModel ? cloneParkedCar(spec.paint) : makePlayerCar({ body: spec.paint }));
            parkedGroup.add(holder);
        }
    }

    function pivotWheel(node) {
        const parent = node.parent;
        const box = new THREE.Box3().setFromObject(node);
        const centre = box.getCenter(new THREE.Vector3());
        const pivot = new THREE.Group();
        parent.add(pivot);
        pivot.position.copy(parent.worldToLocal(centre.clone()));
        pivot.attach(node);
        return pivot;
    }

    function loadCarModel() {
        if (!THREE.GLTFLoader || !window.CAR_GLB_B64) { addParkedCars(); return; }

        // Decoded and parsed from memory: no fetch/XHR, so the page works when
        // parking/index.html is opened straight from disk (file://).
        const raw = atob(window.CAR_GLB_B64);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

        new THREE.GLTFLoader().parse(bytes.buffer, '', gltf => {
            const root = gltf.scene;
            root.rotation.y = Math.PI / 2;
            root.scale.set(MODEL_SCALE.x, MODEL_SCALE.y, MODEL_SCALE.z);
            root.updateMatrixWorld(true);

            root.traverse(o => {
                if (!o.isMesh) return;
                o.castShadow = true;
                o.receiveShadow = true;
                const mats = Array.isArray(o.material) ? o.material : [o.material];
                for (const mat of mats) {
                    if (!mat) continue;
                    if (mat.name === 'Blue') mat.color.set(PLAYER_PAINT.body);
                    if (mat.name === 'Headlights') { mat.emissive.set(0xffd489); mat.emissiveIntensity = 1.2; }
                    if (mat.name === 'TailLights') { mat.emissive.set(0xc02329); mat.emissiveIntensity = 0.6; }
                }
            });

            const nodes = [];
            root.traverse(o => { if (/Wheel/i.test(o.name)) nodes.push(o); });
            const front = [];
            for (const node of nodes) {
                if (node.parent && nodes.includes(node.parent)) continue;
                const pivot = pivotWheel(node);
                if (/Front.*Wheel/i.test(node.name)) front.push(pivot);
            }

            root.updateMatrixWorld(true);
            const box = new THREE.Box3().setFromObject(root);
            const mid = box.getCenter(new THREE.Vector3());
            root.position.set(-mid.x, -box.min.y, -mid.z);

            carModelFrontWheels = front;
            carModel = root;
            carModel.visible = false;
            playerCar.add(carModel);
            addParkedCars();
        }, () => { addParkedCars(); });
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

        const softMat = new THREE.MeshStandardMaterial({ color: 0x3a424e, roughness: 0.93, metalness: 0.03 });
        const trimMat = new THREE.MeshStandardMaterial({ color: 0x4b5663, roughness: 0.64, metalness: 0.16 });
        const hardMat = new THREE.MeshStandardMaterial({ color: 0x20262e, roughness: 0.88, metalness: 0.06 });
        const chromeMat = new THREE.MeshStandardMaterial({ color: 0xb4c0cd, roughness: 0.3, metalness: 0.85 });
        const seatMat = new THREE.MeshStandardMaterial({ color: 0x333b46, roughness: 0.95, metalness: 0.02 });
        const headMat = new THREE.MeshStandardMaterial({ color: 0xbfc4ca, roughness: 0.96, metalness: 0.02 });
        const screenMat = new THREE.MeshStandardMaterial({
            color: 0x0c1822, emissive: 0x13364b, emissiveIntensity: 0.55, roughness: 0.4,
        });
        const glowMat = new THREE.MeshStandardMaterial({
            color: 0x2f8ccf, emissive: 0x1f79bd, emissiveIntensity: 0.3, roughness: 0.5,
        });
        const glassMat = new THREE.MeshStandardMaterial({
            color: 0x8fa6ba, roughness: 0.42, metalness: 0, transparent: true,
            opacity: 0.07, depthWrite: false, side: THREE.DoubleSide,
        });

        const add = (geo, mat, x, y, z) => {
            const m = new THREE.Mesh(geo, mat);
            m.position.set(x, y, z);
            g.add(m);
            return m;
        };
        const box = (w, h, d, mat, x, y, z) => add(new THREE.BoxGeometry(w, h, d), mat, x, y, z);
        const cyl = (r, len, mat, x, y, z, axis) => {
            const m = add(new THREE.CylinderGeometry(r, r, len, 14), mat, x, y, z);
            if (axis === 'x') m.rotation.z = Math.PI / 2;
            if (axis === 'z') m.rotation.x = Math.PI / 2;
            return m;
        };
        const slab = (w, d, mat, x, y, z) => {          // horizontal pane
            const m = box(w, 0.006, d, mat, x, y, z);
            m.renderOrder = 2;
            return m;
        };
        const pane = (pts, mat, z) => {                 // vertical quad at fixed z
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
                pts[0][0], pts[0][1], z,
                pts[1][0], pts[1][1], z,
                pts[2][0], pts[2][1], z,
                pts[3][0], pts[3][1], z,
            ]), 3));
            geo.setIndex([0, 1, 2, 0, 2, 3]);
            geo.computeVertexNormals();
            const m = new THREE.Mesh(geo, mat);
            m.renderOrder = 2;
            g.add(m);
            return m;
        };

        /* shell ------------------------------------------------------------ */
        box(2.30, 0.05, 1.55, hardMat, -0.28, 0.335, 0);
        box(0.60, 0.03, 1.46, headMat, -0.03, CABIN.roof, 0);
        for (const s of [-1, 1]) {
            box(1.10, 0.03, 0.10, headMat, -0.88, CABIN.roof, s * 0.68);
        }
        box(0.10, 0.06, 1.44, trimMat, CABIN.headerX, 1.165, 0);
        for (const s of [-1, 1]) {
            box(1.66, 0.05, 0.07, trimMat, -0.60, 1.175, s * CABIN.pillarZ);
            box(0.16, 0.02, 0.30, headMat, 0.16, 1.145, s * 0.40);  // sun visors
        }

        /* dash ------------------------------------------------------------- */
        box(0.26, 0.09, 1.52, softMat, 0.79, 0.815, 0);
        cyl(0.045, 1.52, softMat, CABIN.cowl, 0.79, 0, 'z');
        box(0.12, 0.27, 1.52, softMat, 0.66, 0.64, 0);
        box(0.05, 0.11, 1.36, hardMat, 0.585, 0.46, 0);

        box(0.22, 0.05, 0.44, softMat, 0.70, 0.885, DRIVER_Z);       // binnacle hood
        box(0.02, 0.09, 0.34, hardMat, 0.645, 0.86, DRIVER_Z);       // cluster face
        for (const dz of [-0.075, 0.075]) {
            const ring = add(new THREE.TorusGeometry(0.042, 0.005, 8, 22), chromeMat,
                0.638, 0.86, DRIVER_Z + dz);
            ring.rotation.y = Math.PI / 2;
            const needle = box(0.004, 0.046, 0.004, glowMat, 0.632, 0.86, DRIVER_Z + dz);
            needle.rotation.x = dz < 0 ? 0.55 : -0.35;
        }

        /* centre stack + vents --------------------------------------------- */
        box(0.14, 0.34, 0.30, hardMat, 0.60, 0.61, 0);
        box(0.012, 0.14, 0.24, screenMat, 0.523, 0.66, 0);
        for (const s of [-1, 1]) {
            box(0.012, 0.06, 0.12, trimMat, 0.594, 0.72, s * 0.34);
            cyl(0.024, 0.02, chromeMat, 0.523, 0.52, s * 0.07, 'x');
        }
        box(0.012, 0.012, 0.92, glowMat, 0.60, 0.777, 0);

        /* column + wheel --------------------------------------------------- */
        cyl(0.03, 0.30, hardMat, 0.60, 0.80, DRIVER_Z, 'x');
        const stalkL = cyl(0.011, 0.10, hardMat, 0.58, 0.80, DRIVER_Z - 0.10, 'z');
        const stalkR = cyl(0.011, 0.10, hardMat, 0.58, 0.80, DRIVER_Z + 0.10, 'z');
        stalkL.rotation.z = 0.1;
        stalkR.rotation.z = 0.1;

        const tilt = new THREE.Group();
        tilt.position.set(0.40, 0.84, DRIVER_Z);
        tilt.rotation.z = -0.30;
        g.add(tilt);

        const spin = new THREE.Group();
        tilt.add(spin);

        const face = new THREE.Group();
        face.rotation.y = -Math.PI / 2;
        spin.add(face);

        face.add(new THREE.Mesh(new THREE.TorusGeometry(0.165, 0.023, 10, 32), hardMat));
        face.add(new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.026, 0.022), hardMat));
        const spokeD = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.145, 0.022), hardMat);
        spokeD.position.set(0, -0.065, 0);
        face.add(spokeD);
        const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.043, 0.043, 0.03, 16), hardMat);
        hub.rotation.x = Math.PI / 2;
        face.add(hub);

        /* console ---------------------------------------------------------- */
        box(1.02, 0.18, 0.24, hardMat, -0.09, 0.52, 0);
        box(0.34, 0.08, 0.22, trimMat, -0.36, 0.66, 0);       // armrest
        box(0.18, 0.012, 0.10, chromeMat, 0.22, 0.617, 0);    // gate plate
        cyl(0.012, 0.15, chromeMat, 0.22, 0.69, 0);           // gear lever
        add(new THREE.SphereGeometry(0.032, 12, 8), hardMat, 0.22, 0.775, 0);
        const handbrake = cyl(0.014, 0.18, chromeMat, 0.02, 0.66, 0);
        handbrake.rotation.z = -0.45;
        cyl(0.04, 0.012, hardMat, -0.16, 0.612, 0);           // cup well

        /* seats ------------------------------------------------------------ */
        const buildSeat = z => {
            const s = new THREE.Group();
            s.position.z = z;
            const part = (w, h, d, x, y, dz, rz) => {
                const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), seatMat);
                m.position.set(x, y, dz || 0);
                if (rz) m.rotation.z = rz;
                s.add(m);
            };
            part(0.50, 0.12, 0.42, -0.30, 0.54, 0);
            part(0.44, 0.10, 0.05, -0.26, 0.60, -0.19);
            part(0.44, 0.10, 0.05, -0.26, 0.60, 0.19);
            part(0.13, 0.54, 0.42, -0.63, 0.80, 0, 0.12);
            part(0.10, 0.48, 0.045, -0.66, 0.80, -0.19, 0.12);
            part(0.10, 0.48, 0.045, -0.66, 0.80, 0.19, 0.12);
            part(0.10, 0.18, 0.24, -0.70, 1.03, 0);
            g.add(s);
            return s;
        };
        buildSeat(DRIVER_Z);
        buildSeat(-DRIVER_Z);
        box(0.55, 0.12, 1.44, seatMat, -0.98, 0.54, 0);
        const rearBack = box(0.12, 0.34, 1.44, seatMat, -1.20, 0.68, 0);
        rearBack.rotation.z = 0.14;
        for (const z of [-0.42, 0.42]) box(0.10, 0.10, 0.24, seatMat, -1.24, 0.86, z);
        box(0.30, 0.03, 1.30, trimMat, -1.52, 0.85, 0);       // parcel shelf

        /* doors + glazing -------------------------------------------------- */
        for (const s of [-1, 1]) {
            const z = s * 0.795;
            box(2.02, 0.42, 0.05, trimMat, -0.18, 0.55, z);
            box(0.46, 0.07, 0.06, softMat, 0.02, 0.66, z);
            box(0.16, 0.02, 0.04, hardMat, 0.10, 0.70, z);
            box(0.20, 0.035, 0.04, chromeMat, 0.20, 0.73, z);
            const speaker = add(new THREE.TorusGeometry(0.06, 0.008, 8, 20), chromeMat, -0.72, 0.50, z);
            speaker.rotation.y = s > 0 ? Math.PI : 0;
            box(2.02, 0.03, 0.05, trimMat, -0.18, CABIN.belt, s * 0.735);

            pane([[0.87, 0.805], [0.26, 1.165], [-0.35, 1.165], [-0.35, 0.805]], glassMat, s * 0.723);
            pane([[-0.35, 0.805], [-0.35, 1.165], [-1.34, 1.165], [-1.34, 0.805]], glassMat, s * 0.723);
            box(0.07, 0.36, 0.06, hardMat, -0.35, 0.985, s * 0.728);
            box(0.09, 0.40, 0.07, hardMat, -1.38, 0.98, s * 0.72);
        }

        const rake = Math.atan2(1.18 - CABIN.belt, CABIN.headerX - CABIN.cowl);
        for (const s of [-1, 1]) {
            const pillar = box(0.761, 0.06, 0.07, trimMat, 0.56, 0.99, s * CABIN.pillarZ);
            pillar.rotation.z = rake;
        }

        const rearRake = Math.atan2(1.18 - 0.87, -0.29 - CABIN.rearGlass);
        slab(1.162, 1.26, glassMat, -0.85, 1.025, 0).rotation.z = rearRake;

        /* dome light -------------------------------------------------------- */
        const domeMat = new THREE.MeshStandardMaterial({
            color: 0xfff1d8, emissive: 0xffe6c4, emissiveIntensity: 0.32, roughness: 0.6,
        });
        const dome = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.008, 0.11), domeMat);
        dome.position.set(-0.10, 1.172, 0);
        g.add(dome);
        const domeLight = new THREE.PointLight(0xffe6c4, 0.4, 1.6, 1.5);
        domeLight.position.set(-0.10, 1.10, 0);
        g.add(domeLight);

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

        addRaisedPavement(bayGroup, -120, -STRIP_HALF);
        addRaisedPavement(bayGroup, STRIP_HALF, 120);

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

    addEventListener('keydown', e => {
        if (BLOCKED.has(e.code)) e.preventDefault();
        if (e.repeat) return;
        if (e.code === 'KeyR') { start(); return; }
        if (e.code === 'KeyM') { muted = !muted; return; }
        keys.add(e.code);
    });
    addEventListener('keyup', e => { keys.delete(e.code); });
    addEventListener('blur', () => keys.clear());

    elRetry.addEventListener('click', () => { playSfx('click'); start(); });

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

        const contacts = GEO.bodyContacts(car, state.bay, {
            roadBottom: ROAD_BOTTOM,
            lotEdge: LOT_EDGE,
            edgeHit: EDGE_HIT,
            kerbGap: KERB_GAP,
            kerbTol: KERB_TOL,
            paveLeft: -STRIP_HALF - KERB_TOL,
            paveRight: STRIP_HALF + KERB_TOL,
        });
        bump('kerb', contacts.topLine || contacts.pavement || contacts.backWall);

        const body = bodyRect(car);
        for (const p of PARKED_CARS) {
            bump(p.id, rectsOverlap(body, { x: p.x, y: p.y, h: p.h, half: CAR.half, halfW: CAR.halfW }));
        }

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

    function updateCamera() {
        const car = state.car;
        const fx = Math.cos(car.h), fz = Math.sin(car.h);
        const rx = -fz, rz = fx;

        const bx = car.x + fx * CAR.center;
        const bz = car.y + fz * CAR.center;

        const ex = bx + fx * EYE.fwd + rx * EYE.side;
        const ez = bz + fz * EYE.fwd + rz * EYE.side;

        camera.position.set(ex, EYE.up, ez);
        camera.lookAt(ex + fx * 6, EYE.up + Math.tan(PITCH) * 6, ez + fz * 6);

        playerCar.position.set(bx, 0, bz);
        playerCar.rotation.y = -car.h;
        for (const w of playerFrontWheels) w.rotation.y = -car.steer;
        for (const w of carModelFrontWheels) w.rotation.y = -car.steer;
        if (cockpit.userData.spin) cockpit.userData.spin.rotation.x = car.steer * WHEEL_VISUAL;

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
        const shell = playerCar.userData.shell;
        const cabin = playerCar.userData.cabin;
        const shellWas = shell.visible;
        const cabinWas = cabin.visible;
        const modelWas = carModel ? carModel.visible : false;

        // The outer GLB belongs to the mirrors; the first-person pass never
        // shows it, otherwise its body edges cut across the windshield view.
        if (carModel) {
            carModel.visible = false;
            shell.visible = false;
            cabin.visible = false;
        }

        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, W, H);
        renderer.clear();
        renderer.render(scene, camera);

        cockpit.visible = false;
        if (carModel) carModel.visible = true;
        renderer.shadowMap.autoUpdate = false;

        renderMirror(leftCamera, views.left);
        renderMirror(rearCamera, views.rear);
        renderMirror(rightCamera, views.right);

        renderer.shadowMap.autoUpdate = true;
        if (carModel) {
            carModel.visible = modelWas;
            shell.visible = shellWas;
            cabin.visible = cabinWas;
        }
        cockpit.visible = true;
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
        updateCamera();
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

    window.__parkingDebug = { state, bay: () => state.bay, GEO, parkedInSpec };
    window.__parking3d = { scene, camera, cockpit, playerCar, parkedGroup, THREE };
})();
