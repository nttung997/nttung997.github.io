'use strict';

/* Shared yard logic for the 2D sa hình page (sahinh.js) and the 3D parking page
   (parking.js). Plain 2D — x along the kerb, y out from it — with no DOM and no
   three.js, so the browser and the Node tests run the same code.

   The pass rule is the one the 2D page has always used for ghép ngang (bài 8)
   and ghép dọc (bài 7): the body sits inside the painted bay, the car is close
   enough to square with the bay, and it has stopped. QCVN 40 sizes the paint; it
   does not define the beep, so no extra kerb-band or rear-line checks. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.ParkingGeometry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // 3D page: Toyota Vios (XP150) 4425 × 1730 mm, wheelbase 2550 mm, rear
    // overhang 965 mm. Its pose origin is the rear axle.
    const CAR = { len: 4.425, wid: 1.730, wheelbase: 2.550, rearOverhang: 0.965 };
    CAR.half = CAR.len / 2;
    CAR.halfW = CAR.wid / 2;
    // Body centre, measured forward from the rear axle.
    CAR.center = CAR.half - CAR.rearOverhang;

    // 2D page test car: 4.5 × 1.8 m, pose origin at the body centre.
    const CAR_2D = { len: 4.5, wid: 1.8, wheelbase: 2.7 };
    CAR_2D.half = CAR_2D.len / 2;
    CAR_2D.halfW = CAR_2D.wid / 2;
    CAR_2D.center = 0;

    // A car drives the same way whether its pose is the centre or the rear axle;
    // the only difference is the offset between the two.
    const centreOffset = spec => (spec.rearOverhang === undefined ? 0 : spec.len / 2 - spec.rearOverhang);

    // QCVN 40:2024 hạng B. 2.1.15.8 ghép ngang: Lg = 3a/2, Rg = 5b/4.
    // 2.1.15.7 ghép dọc: Ld = a + 1.0, Rd = b + 0.6.
    const bayAcross = spec => ({ len: 3 * spec.len / 2, depth: 5 * spec.wid / 4 });
    const bayAlong = spec => ({ len: spec.len + 1.0, depth: spec.wid + 0.6 });

    // Same tolerances both pages use today: 8° of heading, 0.12 m/s of creep.
    const TOL = { heading: 0.14, square: 0.15, stop: 0.12 };

    function cornersAt(cx, cy, h, spec) {
        const c = Math.cos(h), s = Math.sin(h);
        const half = spec.len / 2, halfW = spec.wid / 2;
        const local = [[half, halfW], [-half, halfW], [-half, -halfW], [half, -halfW]];
        return local.map(([lx, ly]) => ({ x: cx + c * lx - s * ly, y: cy + s * lx + c * ly }));
    }

    // Corner quad for a pose given at the body centre (the 2D page).
    function bodyQuad(car, spec) {
        return cornersAt(car.x, car.y, car.h, spec);
    }

    // Corner quad for a pose given at the rear axle (the 3D page).
    function axleQuad(car, spec) {
        const off = centreOffset(spec);
        return cornersAt(car.x + Math.cos(car.h) * off, car.y + Math.sin(car.h) * off, car.h, spec);
    }

    function insideBay(quad, bay) {
        return quad.every(p => p.x > bay.x0 && p.x < bay.x1 && p.y > bay.y0 && p.y < bay.y1);
    }

    const normHeading = a => Math.atan2(Math.sin(a), Math.cos(a));

    // Ghép ngang: parallel bay along the kerb. Straight along it and stopped.
    function parkedAcross(quad, heading, v, bay) {
        if (Math.abs(v) >= TOL.stop) return false;
        if (!insideBay(quad, bay)) return false;
        return Math.abs(normHeading(heading)) < TOL.heading;
    }

    // Ghép dọc: perpendicular bay. Square to it and stopped.
    function parkedAlong(quad, heading, v, bay) {
        if (Math.abs(v) >= TOL.stop) return false;
        if (!insideBay(quad, bay)) return false;
        return Math.abs(Math.cos(heading)) < TOL.square;
    }

    // 3D page: the bay sits against the kerb at y = roadBottom.
    function makeBay(roadBottom, spec) {
        const { len, depth } = bayAcross(spec || CAR);
        return { x0: -len / 2, x1: len / 2, y0: roadBottom - depth, y1: roadBottom };
    }

    // Kerb and lane contacts, used only to score hits on the 3D page.
    function bodyContacts(car, bay, limits, spec) {
        const quad = axleQuad(car, spec || CAR);
        const kerbTol = limits.kerbTol;
        return {
            topLine: quad.some(c => c.y < limits.edgeHit),
            pavement: quad.some(c => c.y > limits.lotEdge + kerbTol
                && (c.x < bay.x0 - limits.kerbGap - kerbTol || c.x > bay.x1 + limits.kerbGap + kerbTol)),
            backWall: quad.some(c => c.y > limits.roadBottom - kerbTol),
        };
    }

    return {
        CAR, CAR_2D, TOL,
        centreOffset, bayAcross, bayAlong,
        cornersAt, bodyQuad, axleQuad, insideBay, normHeading,
        parkedAcross, parkedAlong, makeBay, bodyContacts,
    };
});
