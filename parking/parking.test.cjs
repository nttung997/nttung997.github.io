// Run with: node --test parking/parking.test.cjs
//
// One shared yard rule for the 2D sa hình page and the 3D parking page. The
// reference is the 2D ghép ngang goal (bài 8): body inside the painted bay,
// heading within ~8° of the kerb, and stopped. A pose that passes here must
// therefore also pass in the 2D page, and vice versa.
const test = require('node:test');
const assert = require('node:assert/strict');
const geo = require('./geometry.js');

const { CAR, CAR_2D, TOL, bayAcross } = geo;
const ROAD_BOTTOM = 9;

// ---- 3D page: Vios, pose at the rear axle, bay against the kerb -------------

const bay3d = geo.makeBay(ROAD_BOTTOM, CAR);
const DEG = d => d * Math.PI / 180;

const axlePose = (x, y, heading = 0, v = 0) => ({ x, y, h: heading, v, steer: 0 });
const corners3d = car => geo.axleQuad(car, CAR);
const parked3d = car => geo.parkedAcross(corners3d(car), car.h, car.v, bay3d);

// Rear axle for a car sitting square in the middle of the bay. The bay is only
// 1.5 car lengths, so the axle cannot sit at x=0: the body centre must be
// within the paint, and the axle trails it by CAR.center.
const MID_BODY_X = 0;
const MID_AXLE = x => x - CAR.center;
const centreAxleY = (bay3d.y0 + bay3d.y1) / 2;
const midPose = (heading = 0, v = 0) => axlePose(MID_AXLE(MID_BODY_X), centreAxleY, heading, v);

test('bay matches QCVN 40 hạng B: Lg = 3a/2, Rg = 5b/4', () => {
  const b = bayAcross(CAR);
  assert.equal(b.len, 3 * 4.425 / 2);
  assert.equal(b.depth, 5 * 1.73 / 4);
  assert.equal(b.len.toFixed(2), '6.64');
  assert.equal(b.depth.toFixed(2), '2.16');
});

test('a car parked square in the middle of the bay passes (3D)', () => {
  assert.equal(parked3d(midPose()), true);
});

test('the centered car that used to fail now passes', () => {
  // Regression: the old kerb-band rule rejected this pose because the tyre sat
  // 0.2538 m from the kerb against a 0.25 m limit.
  const car = midPose();
  assert.equal(geo.insideBay(corners3d(car), bay3d), true);
  assert.equal(parked3d(car), true);
});

test('a car still moving is not scored', () => {
  assert.equal(parked3d(midPose(0, 0.2)), false);
  assert.equal(parked3d(midPose(0, -0.2)), false);
});

test('the car must be inside the bay on all four corners', () => {
  assert.equal(parked3d(axlePose(MID_AXLE(0), bay3d.y0 + 0.3)), false, 'too far into the lane');
  assert.equal(parked3d(axlePose(MID_AXLE(0), bay3d.y1 - 0.3)), false, 'on the kerb');
  assert.equal(parked3d(axlePose(bay3d.x0 + 0.6, centreAxleY)), false, 'nose out the back');
  assert.equal(parked3d(axlePose(bay3d.x1 - 0.3, centreAxleY)), false, 'tail out the front');
});

test('heading must stay within the shared 8° tolerance', () => {
  assert.equal(parked3d(midPose(DEG(2))), true);
  assert.equal(parked3d(midPose(DEG(-2))), true);
  assert.equal(parked3d(midPose(DEG(20))), false);
  // The bay is only 1.25 car widths deep, so the corners bind before 8° does.
  assert.equal(parked3d(midPose(DEG(6))), false);
});

test('the pose origin is the rear axle, not the body centre', () => {
  const xs = corners3d(midPose()).map(p => p.x);
  const axle = MID_AXLE(MID_BODY_X);
  assert.ok(Math.abs(Math.max(...xs) - (axle + CAR.center + CAR.half)) < 1e-9);
  assert.ok(Math.abs(Math.min(...xs) - (axle + CAR.center - CAR.half)) < 1e-9);
});

// ---- 2D page: 4.5 x 1.8 m car, pose at the body centre ---------------------

const bay2d = { x0: 18.15, y0: 6.75, x1: 24.9, y1: 9 };
const centre = { x: (bay2d.x0 + bay2d.x1) / 2, y: (bay2d.y0 + bay2d.y1) / 2, h: 0, v: 0 };

test('bài 8 ghép ngang bay matches its own formula (3a/2 x 5b/4)', () => {
  const b = bayAcross(CAR_2D);
  assert.equal(b.len, 6.75);
  assert.equal(b.depth, 2.25);
  assert.ok(Math.abs((bay2d.x1 - bay2d.x0) - b.len) < 1e-9);
  assert.ok(Math.abs((bay2d.y1 - bay2d.y0) - b.depth) < 1e-9);
});

test('a car stopped square in the middle of bài 8 passes (2D)', () => {
  const quad = geo.bodyQuad(centre, CAR_2D);
  assert.equal(geo.parkedAcross(quad, centre.h, centre.v, bay2d), true);
});

test('bài 8 rejects a car that is not straight or not inside', () => {
  const askew = { ...centre, h: DEG(20) };
  assert.equal(geo.parkedAcross(geo.bodyQuad(askew, CAR_2D), askew.h, askew.v, bay2d), false);

  // The 1.8 m car cannot fit across a 2.25 m deep bay if it sits off-centre by 0.4 m.
  const proud = { ...centre, y: bay2d.y0 + CAR_2D.halfW - 0.4 };
  assert.equal(geo.insideBay(geo.bodyQuad(proud, CAR_2D), bay2d), false);

  const rolling = { ...centre, v: 0.4 };
  assert.equal(geo.parkedAcross(geo.bodyQuad(rolling, CAR_2D), rolling.h, rolling.v, bay2d), false);
});

test('bài 7 ghép dọc is square to the bay, not parallel', () => {
  const bay7 = { x0: 20.3, y0: 9, x1: 22.7, y1: 14.5 };
  const c = { x: (bay7.x0 + bay7.x1) / 2, y: (bay7.y0 + bay7.y1) / 2, h: Math.PI / 2, v: 0 };
  const quad = geo.bodyQuad(c, CAR_2D);
  assert.equal(geo.insideBay(quad, bay7), true);
  assert.equal(geo.parkedAlong(quad, c.h, c.v, bay7), true);
  // The same pose must NOT count as a parallel park.
  assert.equal(geo.parkedAcross(quad, c.h, c.v, bay7), false);
});

test('both pages share one tolerance so a 2D pass is a 3D pass', () => {
  assert.equal(TOL.heading, 0.14);
  assert.equal(TOL.stop, 0.12);
  // The shared stop threshold gates both pages the same way.
  assert.equal(parked3d(midPose(0, TOL.stop - 0.001)), true);
  assert.equal(parked3d(midPose(0, TOL.stop + 0.001)), false);
});

test('bodyContacts still reports kerb and lane contacts for hit scoring', () => {
  const limits = { roadBottom: ROAD_BOTTOM, lotEdge: bay3d.y0, edgeHit: 0.26, kerbGap: 0.25, kerbTol: 0.02 };
  const clean = geo.bodyContacts(midPose(), bay3d, limits, CAR);
  assert.deepEqual(clean, { topLine: false, pavement: false, backWall: false });

  assert.equal(geo.bodyContacts(axlePose(MID_AXLE(0), 0.2), bay3d, limits, CAR).topLine, true);

  const beside = { ...bay3d, x0: bay3d.x0 - 5, x1: bay3d.x1 - 5 };
  assert.equal(geo.bodyContacts(midPose(), beside, limits, CAR).pavement, true);
});
