'use strict';

/* Yard geometry in a plain 2D frame: x runs along the kerb, y runs out from it.
   No three.js and no DOM, so parking.js and the Node tests share one definition
   of the bay, the car footprint and the pass condition. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.ParkingGeometry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // Toyota Vios (XP150, the sedan used for hạng B): 4425 × 1730 mm, wheelbase 2550 mm,
    // rear overhang 965 mm. Body centre sits that far ahead of the rear axle.
    const CAR = { len: 4.425, wid: 1.730, wheelbase: 2.550, rearOverhang: 0.965 };
    CAR.half = CAR.len / 2;
    CAR.halfW = CAR.wid / 2;
    CAR.center = CAR.half - CAR.rearOverhang;

    // QCVN 40:2024 hạng B, clause 2.1.15.8 (Hình 13): Lg = 3a/2, Rg = 5b/4.
    // For the Vios below that is 6.64 x 2.16 m, the size of the real test bay.
    const BAY_LEN = 3 * CAR.len / 2;
    const BAY_DEPTH = 5 * CAR.wid / 4;

    // Two yard rules that are not QCVN dimensions: the kerb-side tyres stop within
    // 25 cm of the kerb, and the tail of the car reaches past the yellow line
    // painted 1 m in from the back wall.
    const CURB_BAND = 0.25;
    const REAR_MARK = 1.0;

    // Vios front track 1470 mm, tyre 185 mm. TRACK is the wheel-centre offset.
    const TRACK = 1.470 / 2;
    const TIRE_HALF = 0.185 / 2;

    // The bay sits against the kerb at y = roadBottom and opens onto the lane at y0.
    function makeBay(roadBottom) {
        const half = BAY_LEN / 2;
        return { x0: -half, x1: half, y0: roadBottom - BAY_DEPTH, y1: roadBottom };
    }

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
    // kerb-side tyres within 25 cm of the kerb (not on it), and the tail of the
    // car past the yellow line 1 m in from the back wall.
    function parkedInSpec(car, bay) {
        if (Math.abs(car.v) >= 0.12) return false;

        const quad = playerCorners(car);
        const inside = p => p.x > bay.x0 && p.x < bay.x1 && p.y > bay.y0 && p.y < bay.y1;
        if (!quad.every(inside)) return false;

        const sideOf = sign => ({
            front: tireOuter(car, CAR.wheelbase, sign),
            rear: tireOuter(car, 0, sign),
        });
        const left = sideOf(1);
        const right = sideOf(-1);
        const curb = (left.front.y + left.rear.y) >= (right.front.y + right.rear.y) ? left : right;
        if (bay.y1 - curb.front.y > CURB_BAND || bay.y1 - curb.rear.y > CURB_BAND) return false;

        // The line sits REAR_MARK in from the far wall and the tail has to reach
        // past it. The rear overhang (0.965 m) is within the 1 m inset, so the
        // wheels themselves cannot cross the line without the bumper leaving the
        // bay — the tail of the body is what the yard scores.
        if (Math.min(...quad.map(c => c.x)) > bay.x0 + REAR_MARK) return false;

        return [left.front, left.rear, right.front, right.rear].every(inside);
    }

    // Kerb and lane contacts for the current pose. `limits` carries the level
    // constants (roadBottom, lotEdge, edgeHit, kerbGap, kerbTol) so the caller
    // owns the road layout.
    function bodyContacts(car, bay, limits) {
        const quad = playerCorners(car);
        const kerbTol = limits.kerbTol;
        return {
            topLine: quad.some(c => c.y < limits.edgeHit),
            pavement: quad.some(c => c.y > limits.lotEdge + kerbTol
                && (c.x < bay.x0 - limits.kerbGap - kerbTol || c.x > bay.x1 + limits.kerbGap + kerbTol)),
            backWall: quad.some(c => c.y > limits.roadBottom - kerbTol),
        };
    }

    return {
        CAR, BAY_LEN, BAY_DEPTH, CURB_BAND, REAR_MARK, TRACK, TIRE_HALF,
        makeBay, cornersAt, playerCorners, axlePoint, tireOuter, parkedInSpec, bodyContacts,
    };
});
