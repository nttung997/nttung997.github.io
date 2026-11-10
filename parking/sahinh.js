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

    // ---------------------------------------------------------------- model

    const CAR = { len: 4.5, wid: 1.8, wheelbase: 2.7 };
    CAR.half = CAR.len / 2;
    CAR.halfW = CAR.wid / 2;

    const MAX_STEER = 34 * Math.PI / 180;
    const STEER_RATE = 100 * Math.PI / 180;
    const TAU_RETURN = 0.22;
    const TAU_ACC = 0.36;
    const TAU_DEC = 0.11;
    const TAU_BRAKE = 0.045;
    const V_REV = 1.8;

    const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
    const norm = a => Math.atan2(Math.sin(a), Math.cos(a));
    const rect = (x, y, w, h) => ({ x0: x, y0: y, x1: x + w, y1: y + h });
    const gearNum = v => v > 2.9 ? 3 : v > 1.8 ? 2 : v > 0.05 ? 1 : 0;

    const C = {
        bg: '#0a0d12',
        walk: '#1c2530',
        road: '#333d4a',
        kerb: '#5b6878',
        paint: 'rgba(226,238,250,.72)',
        paintSoft: 'rgba(226,238,250,.28)',
        accent: '#5fb8ff',
        good: '#5ee08a',
        bad: '#ff6060',
        parked: { body: '#2b3341', roof: '#333d4d', glass: '#161d27', tyre: '#0a0d11', head: '#39434f', tail: '#3d2f35' },
        player: { body: '#dbe4ef', roof: '#f2f6fb', glass: '#26333f', tyre: '#0a0d11', head: '#fff2c4', tail: '#e05252', edge: 'rgba(10,15,22,.55)' },
    };

    // ------------------------------------------------------------- geometry

    function cornersAt(cx, cy, h) {
        const c = Math.cos(h), s = Math.sin(h);
        const hl = CAR.half, hw = CAR.halfW;
        return [[hl, hw], [-hl, hw], [-hl, -hw], [hl, -hw]]
            .map(([lx, ly]) => ({ x: cx + c * lx - s * ly, y: cy + s * lx + c * ly }));
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

    function distToSeg(px, py, ax, ay, bx, by) {
        const dx = bx - ax, dy = by - ay;
        const l2 = dx * dx + dy * dy;
        let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
        t = clamp(t, 0, 1);
        return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    }

    function distToPath(x, y, pts) {
        let d = Infinity;
        for (let i = 0; i < pts.length - 1; i++) {
            d = Math.min(d, distToSeg(x, y, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
        }
        return d;
    }

    function inArea(x, y, area) {
        for (const r of area.rects) {
            if (x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1) return true;
        }
        for (const p of area.paths) {
            if (distToPath(x, y, p.pts) <= p.hw) return true;
        }
        return false;
    }

    // ------------------------------------------------------------------ S

    const S_PTS = (() => {
        const p = [];
        for (let x = 2; x <= 44.001; x += 1.5) p.push([x, 5 * Math.sin((x - 2) / 42 * Math.PI * 2)]);
        return p;
    })();

    // QCVN 40:2024 — hạng B, xe 4,5 × 1,8 m.
    // 2.1.15.7 ghép xe dọc:  Ld = a + 1,0 = 5,5 m, Rd = b + 0,6 = 2,4 m (lùi chuồng vuông góc).
    const BAY_DOC = { x0: 20.3, y0: 9, x1: 22.7, y1: 14.5 };
    // 2.1.15.8 ghép xe ngang: Lg = 3a/2 = 6,75 m, Rg = 5b/4 = 2,25 m (đỗ song song sát lề).
    const BAY_NGANG = { x0: 18.15, y0: 6.75, x1: 24.9, y1: 9 };
    const FINISH11 = { x0: 34, y0: -2.6, x1: 40, y1: 2.6 };

    const lightAt = t => { const c = t % 15; return c < 6 ? 'red' : c < 8 ? 'yellow' : 'green'; };

    const paint = (x, y, w, h, a) => { P.fillStyle = `rgba(226,238,250,${a})`; P.fillRect(x, y, w, h); };

    // ------------------------------------------------------------- exercises

    const EX = [
        {
            n: 1,
            name: 'Xuất phát',
            tip: 'Bật xi nhan trái trước vạch xuất phát, qua vạch rồi tắt xi nhan.',
            start: { x: 3, y: 0, h: 0 },
            build: () => ({ area: { rects: [], paths: [{ pts: [[0, 0], [46, 0]], hw: 4 }] }, obstacles: [] }),
            draw(g) {
                paint(8, -4, 0.45, 8, .78);
                checkers(g, 36, -4, 4);
                label(g, 'XUẤT PHÁT', 8, -5.4);
            },
            update(a) {
                const f = a.st.f;
                if (!f.crossed && a.front() > 8) {
                    f.crossed = true;
                    if (a.st.signal !== 'left') a.score(10, 'Không bật xi nhan trái khi xuất phát');
                }
                if (f.crossed && !f.off && a.front() > 18) {
                    f.off = true;
                    if (a.st.signal === 'left') a.score(5, 'Chưa tắt xi nhan sau khi xuất phát');
                }
            },
            goal: a => a.front() > 36,
        },
        {
            n: 2,
            name: 'Nhường người đi bộ',
            tip: 'Dừng hẳn trước vạch, chờ người đi bộ qua đường rồi mới đi tiếp.',
            start: { x: 3, y: 0, h: 0 },
            build: () => ({ area: { rects: [], paths: [{ pts: [[0, 0], [46, 0]], hw: 4 }] }, obstacles: [] }),
            draw(g, st) {
                for (let y = -3.9; y < 4; y += 1.2) paint(22.4, y, 4.2, 0.62, .5);
                paint(21.6, -4, 0.36, 8, .85);
                if (st.ped) {
                    g.fillStyle = C.accent;
                    g.beginPath();
                    g.arc(st.ped.x, st.ped.y, 0.46, 0, 7);
                    g.fill();
                }
                checkers(g, 38, -4, 4);
                label(g, 'NHƯỜNG ĐƯỜNG', 24.5, -5.4);
            },
            update(a) {
                const f = a.st.f, front = a.front(), t = a.t, v = Math.abs(a.car.v);
                if (!f.stopped && v < 0.05 && front > 20 && front < 21.6) {
                    f.stopped = true;
                    f.at = t;
                }
                if (f.stopped && t - f.at > 0.6) f.clear = true;

                const p0 = 2, p1 = 6.6;
                a.st.ped = (t > p0 && t < p1)
                    ? { x: 24.5, y: -4.4 + (t - p0) / (p1 - p0) * 8.8 }
                    : null;

                if (a.st.ped && front > 22.2) a.fail('Không nhường đường cho người đi bộ');
                if (front > 26.8 && !f.clear && !f.warned) {
                    f.warned = true;
                    a.score(10, 'Không dừng trước vạch nhường đường');
                }
            },
            goal: a => a.front() > 40,
        },
        {
            n: 3,
            name: 'Dừng & khởi hành ngang dốc',
            tip: 'Dừng trong ô trên dốc, giữ phanh rồi khởi hành — không để xe tụt quá 50 cm.',
            start: { x: 3, y: 0, h: 0 },
            grav: car => (car.x > 20 && car.x < 30) ? -2.6 * Math.cos(car.h) : 0,
            build: () => ({ area: { rects: [], paths: [{ pts: [[0, 0], [44, 0]], hw: 4 }] }, obstacles: [] }),
            draw(g, st) {
                g.fillStyle = 'rgba(95,184,255,.06)';
                g.fillRect(20, -4, 10, 8);
                g.save();
                g.setLineDash([0.6, 0.45]);
                g.strokeStyle = C.accent;
                g.lineWidth = 0.16;
                g.strokeRect(24.4, -4, 1.5, 8);
                g.restore();
                g.save();
                g.strokeStyle = 'rgba(95,184,255,.45)';
                g.lineWidth = 0.16;
                for (let x = 21; x < 30; x += 1.6) {
                    g.beginPath();
                    g.moveTo(x - 0.5, 2.6);
                    g.lineTo(x, 1.9);
                    g.lineTo(x + 0.5, 2.6);
                    g.stroke();
                }
                g.restore();
                checkers(g, 37, -4, 4);
                label(g, 'DỐC', 25, -5.4);
            },
            update(a) {
                const f = a.st.f, front = a.front(), stopped = Math.abs(a.car.v) < 0.05;
                if (!f.held && a.brake && stopped && front > 24.4 && front < 25.9) {
                    f.hold = (f.hold || 0) + a.dt;
                    if (f.hold > 1) {
                        f.held = true;
                        f.rel = a.car.x;
                    }
                } else if (!f.held) {
                    f.hold = 0;
                }
                if (f.held && !f.roll && a.car.x < f.rel - 0.5) {
                    f.roll = true;
                    a.fail('Xe tụt dốc quá 50 cm');
                }
                if (front > 33 && !f.held && !f.warned) {
                    f.warned = true;
                    a.score(10, 'Không dừng đúng vùng trên dốc');
                }
            },
            status(a) {
                const f = a.st.f;
                if (f.held) return 'Đã giữ dốc — nhả phanh và đi tiếp.';
                if (f.hold > 0) return `Giữ phanh… ${Math.min(100, Math.round(f.hold / 1 * 100))}%`;
                return 'Dừng trong ô xanh trên dốc và giữ phanh (Space).';
            },
            goal: a => a.front() > 38,
        },
        {
            n: 4,
            name: 'Vệt bánh xe – hẹp vuông góc',
            tip: 'Canh bánh trước vào vệt, rẽ vuông góc vào đường hẹp, không chạm vạch.',
            start: { x: 3, y: 0, h: 0 },
            build: () => ({
                area: {
                    rects: [rect(14, -4, 10, 8)],
                    paths: [
                        { pts: [[0, 0], [18, 0]], hw: 3.2 },
                        { pts: [[19, -4], [19, -22]], hw: 2 },
                    ],
                },
                obstacles: [],
            }),
            draw(g) {
                g.save();
                g.strokeStyle = 'rgba(226,238,250,.45)';
                g.lineWidth = 0.14;
                g.setLineDash([0.9, 0.6]);
                g.beginPath();
                g.moveTo(3, -0.9); g.lineTo(13, -0.9);
                g.moveTo(3, 0.9); g.lineTo(13, 0.9);
                g.stroke();
                g.restore();
                label(g, 'VỆT BÁNH XE', 8, -4.4);
                label(g, 'HẸP', 19, -23.4);
                checkers(g, 17, -23, -16);
            },
            update() { },
            goal: a => a.car.y < -18.5,
        },
        {
            n: 5,
            name: 'Ngã tư có đèn',
            tip: 'Dừng trước vạch khi đèn đỏ, đi khi đèn xanh. Vượt đèn đỏ là loại.',
            start: { x: 3, y: 0, h: 0 },
            build: () => ({ area: { rects: [rect(0, -4, 46, 8), rect(16, -22, 8, 44)], paths: [] }, obstacles: [] }),
            draw(g, st) {
                const L = lightAt(st.t);
                paint(16, -4, 0.36, 8, .85);
                const box = { x: 16.4, y: -6.4, w: 1.6, h: 4.4 };
                g.fillStyle = '#0d1319';
                g.strokeStyle = 'rgba(255,255,255,.16)';
                g.lineWidth = 0.12;
                g.beginPath();
                g.roundRect(box.x, box.y, box.w, box.h, 0.5);
                g.fill();
                g.stroke();
                const cols = { red: C.bad, yellow: '#ffcf5e', green: C.good };
                ['red', 'yellow', 'green'].forEach((k, i) => {
                    g.beginPath();
                    g.arc(box.x + box.w / 2, box.y + 0.95 + i * 1.3, 0.44, 0, 7);
                    g.fillStyle = L === k ? cols[k] : 'rgba(255,255,255,.07)';
                    g.fill();
                });
                checkers(g, 38, -4, 4);
                label(g, 'ĐÈN GIAO THÔNG', 17.2, -8.2);
            },
            update(a) {
                const f = a.st.f, front = a.front(), L = lightAt(a.t);
                if (!f.crossed && front > 16) {
                    f.crossed = true;
                    if (L === 'red') a.fail('Vượt đèn đỏ');
                    else if (L === 'yellow') a.score(10, 'Vượt đèn vàng');
                }
            },
            status(a) {
                const L = lightAt(a.t);
                return L === 'red' ? 'Đèn đỏ — dừng lại.' : L === 'yellow' ? 'Đèn vàng — chuẩn bị dừng.' : 'Đèn xanh — đi qua ngã tư.';
            },
            goal: a => a.front() > 40,
        },
        {
            n: 6,
            name: 'Đường vòng quanh co (S)',
            tip: 'Đi số 1, đánh lái đều theo thành chữ S, không để bánh chạm vạch.',
            start: { x: S_PTS[0][0], y: S_PTS[0][1], h: Math.atan2(S_PTS[1][1] - S_PTS[0][1], S_PTS[1][0] - S_PTS[0][0]) },
            build: () => ({ area: { rects: [], paths: [{ pts: S_PTS, hw: 2.6 }] }, obstacles: [] }),
            draw(g) {
                const y = 5 * Math.sin((41 - 2) / 42 * Math.PI * 2);
                g.save();
                g.strokeStyle = 'rgba(94,224,138,.85)';
                g.lineWidth = 0.22;
                g.setLineDash([0.8, 0.5]);
                g.beginPath();
                g.moveTo(41, y - 2.6);
                g.lineTo(41, y + 2.6);
                g.stroke();
                g.restore();
            },
            update() { },
            goal: a => a.car.x > 41,
        },
        {
            n: 7,
            name: 'Ghép xe dọc',
            tip: 'Lùi vuông góc vào ô giữa hai xe, thân xe thẳng và nằm gọn trong ô.',
            start: { x: 4, y: 4.5, h: 0 },
            build: () => ({
                area: { rects: [rect(0, 0, 46, 9), rect(8, 9, 30, 5.5)], paths: [] },
                obstacles: [
                    { x: 19.4, y: 11.75, h: Math.PI / 2 },
                    { x: 23.6, y: 11.75, h: Math.PI / 2 },
                ],
            }),
            draw(g) {
                paint(BAY_DOC.x0, BAY_DOC.y0, BAY_DOC.x1 - BAY_DOC.x0, BAY_DOC.y1 - BAY_DOC.y0, .07);
                g.save();
                g.strokeStyle = C.paint;
                g.lineWidth = 0.12;
                g.setLineDash([0.45, 0.3]);
                g.strokeRect(BAY_DOC.x0, BAY_DOC.y0, BAY_DOC.x1 - BAY_DOC.x0, BAY_DOC.y1 - BAY_DOC.y0);
                g.restore();
                label(g, 'GHÉP DỌC', 21.5, 15.7);
            },
            update() { },
            goal(a) {
                const b = BAY_DOC, q = a.q;
                const inside = q.every(p => p.x > b.x0 && p.x < b.x1 && p.y > b.y0 && p.y < b.y1);
                return inside && Math.abs(Math.cos(a.car.h)) < 0.15 && Math.abs(a.car.v) < 0.12;
            },
        },
        {
            n: 8,
            name: 'Ghép xe ngang',
            tip: 'Lùi song song vào ô giữa hai xe, canh thân xe sát lề và thẳng ô.',
            start: { x: 5, y: 4.8, h: 0 },
            build: () => ({
                area: { rects: [rect(0, 0, 46, 9)], paths: [] },
                obstacles: [
                    { x: 15.9, y: 7.875, h: 0 },
                    { x: 27.15, y: 7.875, h: 0 },
                ],
            }),
            draw(g) {
                paint(BAY_NGANG.x0, BAY_NGANG.y0, BAY_NGANG.x1 - BAY_NGANG.x0, BAY_NGANG.y1 - BAY_NGANG.y0, .07);
                g.save();
                g.strokeStyle = C.paint;
                g.lineWidth = 0.12;
                g.setLineDash([0.45, 0.3]);
                g.strokeRect(BAY_NGANG.x0, BAY_NGANG.y0, BAY_NGANG.x1 - BAY_NGANG.x0, BAY_NGANG.y1 - BAY_NGANG.y0);
                g.restore();
                label(g, 'GHÉP NGANG', 21.5, 5.95);
            },
            update() { },
            goal(a) {
                const b = BAY_NGANG, q = a.q;
                const inside = q.every(p => p.x > b.x0 && p.x < b.x1 && p.y > b.y0 && p.y < b.y1);
                return inside && Math.abs(norm(a.car.h)) < 0.14 && Math.abs(a.car.v) < 0.12;
            },
        },
        {
            n: 9,
            name: 'Tạm dừng đường sắt',
            tip: 'Dừng hẳn trước vạch, quan sát rồi mới đi qua đường sắt.',
            start: { x: 3, y: 0, h: 0 },
            build: () => ({ area: { rects: [], paths: [{ pts: [[0, 0], [46, 0]], hw: 4.5 }] }, obstacles: [] }),
            draw(g, st) {
                g.fillStyle = 'rgba(26,33,42,.95)';
                g.fillRect(20, -4.5, 4, 9);
                for (let x = 20.3; x < 23.8; x += 0.85) paint(x, -4.2, 0.34, 8.4, .16);
                paint(20.1, -4.5, 0.26, 9, .5);
                paint(23.65, -4.5, 0.26, 9, .5);
                paint(19.2, -4.5, 0.34, 9, .82);
                const on = Math.sin(st.t * 7) > 0;
                g.fillStyle = on ? C.bad : 'rgba(255,96,96,.16)';
                g.beginPath();
                g.arc(18.2, -6, 0.52, 0, 7);
                g.fill();
                if (st.t > 1.8 && st.t < 3.2) {
                    const ty = -10 + (st.t - 1.8) / 1.4 * 20;
                    g.fillStyle = '#39434f';
                    g.fillRect(20.2, ty - 1.3, 3.6, 2.6);
                }
                checkers(g, 36, -4.5, 4.5);
                label(g, 'ĐƯỜNG SẮT', 22, -6.4);
            },
            update(a) {
                const f = a.st.f, front = a.front();
                if (!f.ok && a.brake && Math.abs(a.car.v) < 0.05 && front > 18 && front < 19.7) {
                    f.hold = (f.hold || 0) + a.dt;
                    if (f.hold > 0.6) f.ok = true;
                } else if (!f.ok) {
                    f.hold = 0;
                }
                if (!f.ok && !f.warned && front > 24) {
                    f.warned = true;
                    a.score(10, 'Không dừng quan sát trước đường sắt');
                }
            },
            status(a) {
                const f = a.st.f;
                if (f.ok) return 'Đã quan sát — đi qua đường sắt.';
                return f.hold > 0 ? 'Đang dừng quan sát…' : 'Dừng trước vạch và đạp phanh (Space).';
            },
            goal: a => a.front() > 36,
        },
        {
            n: 10,
            name: 'Thay đổi số',
            tip: 'Tăng lên số 2 rồi số 3 đúng đoạn quy định, giữ ga đều.',
            start: { x: 3, y: 0, h: 0 },
            vmax: 4.4,
            build: () => ({ area: { rects: [], paths: [{ pts: [[0, 0], [46, 0]], hw: 4 }] }, obstacles: [] }),
            draw(g) {
                paint(16, -4, 0.32, 8, .55);
                paint(28, -4, 0.32, 8, .55);
                label(g, 'SỐ 2', 16, -5.2);
                label(g, 'SỐ 3', 28, -5.2);
                checkers(g, 42, -4, 4);
            },
            update(a) {
                const f = a.st.f, front = a.front(), g = gearNum(a.car.v);
                f.max = Math.max(f.max || 0, g);
                if (!f.g2 && front > 16) {
                    f.g2 = true;
                    if (f.max < 2) a.score(5, 'Chưa lên số 2 đúng đoạn');
                }
                if (!f.g3 && front > 28) {
                    f.g3 = true;
                    if (f.max < 3) a.score(5, 'Chưa lên số 3 đúng đoạn');
                }
            },
            status(a) {
                return `Số hiện tại: ${gearNum(a.car.v) || 'N'} — cần đạt số 3 trước cột mốc.`;
            },
            goal: a => a.front() > 42 && Math.abs(a.car.v) < 0.12,
        },
        {
            n: 11,
            name: 'Kết thúc',
            tip: 'Bật xi nhan phải, tấp vào ô đích và dừng hẳn trong ô.',
            start: { x: 3, y: 0, h: 0 },
            build: () => ({ area: { rects: [], paths: [{ pts: [[0, 0], [44, 0]], hw: 4 }] }, obstacles: [] }),
            draw(g) {
                paint(FINISH11.x0, FINISH11.y0, FINISH11.x1 - FINISH11.x0, FINISH11.y1 - FINISH11.y0, .08);
                g.save();
                g.strokeStyle = C.good;
                g.lineWidth = 0.16;
                g.setLineDash([0.5, 0.35]);
                g.strokeRect(FINISH11.x0, FINISH11.y0, FINISH11.x1 - FINISH11.x0, FINISH11.y1 - FINISH11.y0);
                g.restore();
                label(g, 'ĐÍCH', 37, -4.4);
            },
            update(a) {
                const f = a.st.f;
                if (!f.in && a.front() > FINISH11.x0) {
                    f.in = true;
                    if (a.st.signal !== 'right') a.score(10, 'Chưa bật xi nhan phải khi vào đích');
                }
            },
            goal(a) {
                const b = FINISH11, q = a.q;
                return q.every(p => p.x > b.x0 && p.x < b.x1 && p.y > b.y0 && p.y < b.y1)
                    && Math.abs(a.car.v) < 0.05 && a.brake;
            },
        },
    ];

    // -------------------------------------------------------------- drawing

    function checkers(g, x, y0, y1) {
        const n = Math.round((y1 - y0) / 1);
        for (let i = 0; i < n; i++) {
            g.fillStyle = i % 2 ? 'rgba(226,238,250,.72)' : 'rgba(226,238,250,.22)';
            g.fillRect(x, y0 + i * 1, 0.9, 1);
        }
    }

    function label(g, text, x, y) {
        g.save();
        g.fillStyle = 'rgba(141,154,173,.95)';
        g.font = '600 0.62px ui-sans-serif, system-ui, sans-serif';
        g.textAlign = 'center';
        g.fillText(text, x, y);
        g.restore();
    }

    function drawArea(g, area, color, grow) {
        g.fillStyle = color;
        g.strokeStyle = color;
        for (const r of area.rects) {
            g.fillRect(r.x0 - grow, r.y0 - grow, (r.x1 - r.x0) + grow * 2, (r.y1 - r.y0) + grow * 2);
        }
        for (const p of area.paths) {
            g.lineWidth = p.hw * 2 + grow * 2;
            g.lineCap = 'round';
            g.lineJoin = 'round';
            g.beginPath();
            g.moveTo(p.pts[0][0], p.pts[0][1]);
            for (let i = 1; i < p.pts.length; i++) g.lineTo(p.pts[i][0], p.pts[i][1]);
            g.stroke();
        }
    }

    function drawCar(g, cx, cy, h, steer, look) {
        const hl = CAR.half, hw = CAR.halfW, ax = CAR.wheelbase / 2;
        const tw = 0.62, th = 0.26;

        g.save();
        g.translate(cx, cy);
        g.rotate(h);

        g.fillStyle = look.tyre;
        for (const s of [-1, 1]) {
            g.beginPath();
            g.roundRect(-ax - tw / 2, s * (hw - 0.02) - th / 2, tw, th, 0.09);
            g.fill();
        }
        for (const s of [-1, 1]) {
            g.save();
            g.translate(ax, s * (hw - 0.02));
            g.rotate(steer);
            g.beginPath();
            g.roundRect(-tw / 2, -th / 2, tw, th, 0.09);
            g.fill();
            g.restore();
        }

        g.beginPath();
        g.roundRect(-hl, -hw, CAR.len, CAR.wid, 0.42);
        g.fillStyle = look.body;
        g.fill();
        if (look.edge) {
            g.strokeStyle = look.edge;
            g.lineWidth = 0.055;
            g.stroke();
        }

        g.fillStyle = look.glass;
        g.beginPath();
        g.moveTo(-1.20, -hw + 0.18);
        g.lineTo(1.30, -hw + 0.22);
        g.lineTo(1.30, hw - 0.22);
        g.lineTo(-1.20, hw - 0.18);
        g.closePath();
        g.fill();

        g.fillStyle = look.roof;
        g.beginPath();
        g.roundRect(-0.70, -hw + 0.30, 1.40, CAR.wid - 0.60, 0.20);
        g.fill();

        g.fillStyle = look.head;
        g.beginPath();
        g.roundRect(hl - 0.17, -hw + 0.16, 0.15, 0.32, 0.06);
        g.roundRect(hl - 0.17, hw - 0.48, 0.15, 0.32, 0.06);
        g.fill();

        g.fillStyle = look.tail;
        g.beginPath();
        g.roundRect(-hl + 0.02, -hw + 0.16, 0.15, 0.32, 0.06);
        g.roundRect(-hl + 0.02, hw - 0.48, 0.15, 0.32, 0.06);
        g.fill();

        g.restore();
    }

    // ---------------------------------------------------------------- state

    const canvas = document.getElementById('game');
    const ctx = canvas.getContext('2d');
    const elScore = document.getElementById('score');
    const elTime = document.getElementById('time');
    const elGear = document.getElementById('gear');
    const elSignal = document.getElementById('signal');
    const elObjective = document.getElementById('objective');
    const elStatus = document.getElementById('status');
    const elResult = document.getElementById('result');
    const elTitle = document.getElementById('result-title');
    const elSub = document.getElementById('result-sub');
    const elNotes = document.getElementById('result-notes');
    const elRetry = document.getElementById('retry');
    const elNext = document.getElementById('next');
    const elChips = document.getElementById('chips');

    let P = ctx;
    let W = 0, H = 0, dpr = 1;
    let frameDt = 0.016;

    const st = {
        idx: 0,
        ex: null,
        area: null,
        obstacles: [],
        bay: null,
        car: null,
        q: [],
        bounds: null,
        score: 100,
        time: 0,
        done: false,
        won: false,
        failed: null,
        signal: null,
        notes: [],
        f: {},
        ped: null,
        flash: 0,
        contacts: new Map(),
        lastHit: new Map(),
    };

    const api = {
        get st() { return st; },
        get car() { return st.car; },
        get q() { return st.q; },
        get t() { return st.time; },
        get dt() { return frameDt; },
        get brake() { return keys.has('Space'); },
        front() {
            let m = -Infinity;
            for (const p of st.q) if (p.x > m) m = p.x;
            return m;
        },
        back() {
            let m = Infinity;
            for (const p of st.q) if (p.x < m) m = p.x;
            return m;
        },
        score(n, msg) {
            if (st.done) return;
            st.score = Math.max(0, st.score - n);
            if (msg && !st.notes.includes(msg)) st.notes.push(msg);
            st.flash = 1;
            if (st.score <= 0) finish(false, 'Hết điểm');
        },
        fail(msg) {
            if (st.done) return;
            if (msg && !st.notes.includes(msg)) st.notes.push(msg);
            finish(false, msg);
        },
    };

    function buildBounds(ex) {
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        const put = (x, y) => {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
        };
        for (const r of ex.area.rects) { put(r.x0, r.y0); put(r.x1, r.y1); }
        for (const p of ex.area.paths) for (const [x, y] of p.pts) { put(x - p.hw, y - p.hw); put(x + p.hw, y + p.hw); }
        for (const o of ex.obstacles) for (const c of cornersAt(o.x, o.y, o.h)) put(c.x, c.y);
        return { x0: x0 - 3, y0: y0 - 3, x1: x1 + 3, y1: y1 + 3 };
    }

    function start(index) {
        const ex = EX[index];
        const built = ex.build();

        st.idx = index;
        st.ex = ex;
        st.area = built.area;
        st.obstacles = built.obstacles.map((o, i) => ({ ...o, id: 'o' + i, quad: cornersAt(o.x, o.y, o.h) }));
        st.bounds = buildBounds({ area: built.area, obstacles: built.obstacles });
        st.score = 100;
        st.time = 0;
        st.done = false;
        st.won = false;
        st.failed = null;
        st.signal = null;
        st.notes = [];
        st.f = {};
        st.ped = null;
        st.flash = 0;
        st.contacts.clear();
        st.lastHit.clear();
        st.car = { x: ex.start.x, y: ex.start.y, h: ex.start.h, v: 0, steer: 0 };
        st.q = cornersAt(st.car.x, st.car.y, st.car.h);

        elResult.classList.add('hidden');
        elObjective.textContent = `${ex.n}. ${ex.name}`;
        elStatus.textContent = ex.status ? ex.status(api) : ex.tip;
        elNext.disabled = index + 1 >= EX.length;
        hud.key = '';

        for (const b of elChips.children) {
            b.setAttribute('aria-pressed', String(Number(b.dataset.i) === index));
        }
        resize();
    }

    // ----------------------------------------------------------------- input

    const keys = new Set();
    const BLOCKED = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

    function toggleSignal(side) {
        st.signal = st.signal === side ? null : side;
    }

    addEventListener('keydown', e => {
        if (BLOCKED.has(e.code)) e.preventDefault();
        if (e.code === 'KeyR') { start(st.idx); return; }
        if (e.code === 'KeyQ') { toggleSignal('left'); return; }
        if (e.code === 'KeyE') { toggleSignal('right'); return; }
        keys.add(e.code);
    });
    addEventListener('keyup', e => { keys.delete(e.code); });
    addEventListener('blur', () => keys.clear());

    EX.forEach((ex, i) => {
        const b = document.createElement('button');
        b.textContent = String(ex.n);
        b.dataset.i = String(i);
        b.setAttribute('aria-label', ex.name);
        b.title = ex.name;
        b.addEventListener('click', () => start(i));
        elChips.appendChild(b);
    });

    elRetry.addEventListener('click', () => start(st.idx));
    elNext.addEventListener('click', () => {
        if (st.idx + 1 < EX.length) start(st.idx + 1);
    });

    // ---------------------------------------------------------------- update

    function update(dt) {
        frameDt = dt;
        st.flash = Math.max(0, st.flash - dt * 2.2);
        if (st.done) return;

        const ex = st.ex, car = st.car;

        const left = keys.has('KeyA') || keys.has('ArrowLeft');
        const right = keys.has('KeyD') || keys.has('ArrowRight');
        const fwd = keys.has('KeyW') || keys.has('ArrowUp');
        const rev = keys.has('KeyS') || keys.has('ArrowDown');
        const brake = keys.has('Space');
        const vmax = ex.vmax || 3.0;

        const dir = (right ? 1 : 0) - (left ? 1 : 0);
        if (dir !== 0) {
            car.steer = clamp(car.steer + dir * STEER_RATE * dt, -MAX_STEER, MAX_STEER);
        } else {
            car.steer *= Math.exp(-dt / TAU_RETURN);
            if (Math.abs(car.steer) < 0.002) car.steer = 0;
        }

        let target = 0;
        if (fwd && !rev) target = vmax;
        else if (rev && !fwd) target = -V_REV;

        let tau = Math.abs(target) < Math.abs(car.v) ? TAU_DEC : TAU_ACC;
        if (brake) { target = 0; tau = TAU_BRAKE; }

        car.v += (target - car.v) * (1 - Math.exp(-dt / tau));
        if (ex.grav && !brake) car.v += ex.grav(car) * dt;
        car.v = clamp(car.v, -V_REV, vmax);
        if (Math.abs(car.v) < 0.006) car.v = 0;

        car.h += (car.v / CAR.wheelbase) * Math.tan(car.steer) * dt;
        car.x += Math.cos(car.h) * car.v * dt;
        car.y += Math.sin(car.h) * car.v * dt;

        st.time += dt;
        st.q = cornersAt(car.x, car.y, car.h);

        if (!st.q.every(p => inArea(p.x, p.y, st.area))) bump('off');
        for (const o of st.obstacles) {
            if (overlaps(st.q, o.quad)) bump(o.id);
        }

        ex.update(api);

        if (!st.done && ex.goal(api)) finish(true);
        if (!st.done && ex.status) elStatus.textContent = ex.status(api);
    }

    function bump(id) {
        const was = st.contacts.get(id) || false;
        if (!was) {
            const last = st.lastHit.get(id);
            if (last === undefined || st.time - last > 0.6) {
                st.lastHit.set(id, st.time);
                api.score(5, id === 'off' ? 'Chạm vạch / lấn làn' : 'Va chạm vật cản');
            }
        }
        st.contacts.set(id, true);
        st.contacts.set(id + ':t', st.time);
        for (const [k, v] of st.contacts) {
            if (k.endsWith(':t')) continue;
            if (st.time - (st.contacts.get(k + ':t') || 0) > 0.1) st.contacts.set(k, false);
        }
    }

    function finish(won, reason) {
        if (st.done) return;
        st.done = true;
        st.won = won && st.score >= 80;
        if (won && st.score < 80) {
            st.notes.push('Điểm dưới 80 — không đạt');
            st.won = false;
        }
        showResult(reason);
    }

    function showResult(reason) {
        elTitle.textContent = st.won ? 'ĐẠT' : 'CHƯA ĐẠT';
        elTitle.style.color = st.won ? '#5ee08a' : '#ff6060';
        elSub.textContent = `Điểm ${st.score} · ${st.time.toFixed(1)}s`;
        elNotes.innerHTML = '';
        const items = st.won ? st.notes.slice() : [reason || st.failed, ...st.notes].filter(Boolean);
        const uniq = [...new Set(items)];
        if (!uniq.length) uniq.push(st.won ? 'Không mắc lỗi nào.' : 'Bài chưa hoàn thành.');
        for (const n of uniq) {
            const li = document.createElement('li');
            li.textContent = n;
            elNotes.appendChild(li);
        }
        elResult.classList.remove('hidden');
    }

    // ------------------------------------------------------------- rendering

    function render() {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = C.bg;
        ctx.fillRect(0, 0, W, H);

        const b = st.bounds;
        const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
        const s = Math.min(W / bw, H / bh);
        const ox = W / 2 - s * (b.x0 + bw / 2);
        const oy = H / 2 - s * (b.y0 + bh / 2);
        ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);

        drawArea(ctx, st.area, C.kerb, 0.34);
        drawArea(ctx, st.area, C.road, 0);

        st.ex.draw(ctx, st);

        for (const o of st.obstacles) drawCar(ctx, o.x, o.y, o.h, 0, C.parked);

        const car = st.car;
        drawCar(ctx, car.x, car.y, car.h, car.steer, C.player);

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (st.flash > 0) {
            const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.72);
            g.addColorStop(0, 'rgba(255,72,72,0)');
            g.addColorStop(1, `rgba(255,72,72,${(0.45 * st.flash).toFixed(3)})`);
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, W, H);
        }
    }

    // ------------------------------------------------------------------- hud

    let hud = { key: '' };

    function updateHud() {
        const key = `${st.score}|${st.time.toFixed(1)}|${gearNum(st.car.v)}|${st.signal}|${st.done}`;
        if (key === hud.key) return;
        hud.key = key;

        elScore.textContent = String(st.score);
        elScore.style.color = st.score >= 80 ? '#5ee08a' : st.score >= 50 ? '#ffcf5e' : '#ff6060';
        elTime.textContent = st.time.toFixed(1) + 's';
        elGear.textContent = st.car.v < -0.05 ? 'R' : (gearNum(st.car.v) || 'N');
        elGear.dataset.gear = st.car.v < -0.05 ? 'R' : gearNum(st.car.v) ? 'D' : 'N';
        elSignal.textContent = st.signal === 'left' ? '◀' : st.signal === 'right' ? '▶' : '—';
        elSignal.classList.toggle('on', !!st.signal);
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
        for (const el of document.querySelectorAll('[data-signal]')) {
            el.addEventListener('click', () => {
                toggleSignal(el.dataset.signal);
                updateHud();
            });
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
    start(0);
    requestAnimationFrame(frame);

})();
