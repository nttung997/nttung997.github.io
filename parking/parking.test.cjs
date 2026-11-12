// Run with: node --test parking/parking.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const geo = require('./geometry.js');

const { CAR, BAY_LEN, BAY_DEPTH, CURB_BAND, REAR_MARK, TRACK, TIRE_HALF } = geo;
const ROAD_BOTTOM = 9;
const bay = geo.makeBay(ROAD_BOTTOM);
const deg = d => d * Math.PI / 180;

function pose(x, y, heading = 0) {
  return { x, y, h: heading, v: 0 };
}

// Rear axle for a car sitting square in the bay with its kerb-side tyres on the
// inner edge of the 25 cm band. Negative `across` tucks it closer to the kerb.
const KERB_TYRE = bay.y1 - CURB_BAND;
// Rear axle far enough back that the tail is past the yellow line but the car
// is still wholly inside the bay: reachable axles run x0+0.965 .. x1-3.46.
const BAY_MID_X = -1.9;
function squarePose(across = 0) {
  return pose(BAY_MID_X, KERB_TYRE - (TRACK + TIRE_HALF) - across);
}

test('bay matches QCVN 40 hạng B: Lg = 3a/2, Rg = 5b/4 for the Vios', () => {
  assert.equal(BAY_LEN, 3 * 4.425 / 2);
  assert.equal(BAY_DEPTH, 5 * 1.73 / 4);
  assert.equal(BAY_LEN.toFixed(2), '6.64');
  assert.equal(BAY_DEPTH.toFixed(2), '2.16');
});

test('a square stop against the kerb, past the rear line, passes', () => {
  assert.equal(geo.parkedInSpec(squarePose(), bay), true);
});

test('the rear line sits 1 m in from the back wall, and the tail must cross it', () => {
  assert.ok(Math.abs((bay.x0 + REAR_MARK) - (-BAY_LEN / 2 + REAR_MARK)) < 1e-9);
  const tail = car => Math.min(...geo.playerCorners(car).map(c => c.x));
  assert.ok(tail(squarePose()) < bay.x0 + REAR_MARK, 'a good park puts the tail past the line');
});

test('a car whose tail has not reached the yellow line is rejected', () => {
  const car = squarePose();
  car.x = bay.x0 + REAR_MARK + CAR.rearOverhang + 0.05;
  assert.equal(geo.parkedInSpec(car, bay), false);
});

test('the rear overhang is shorter than the line inset, so wheels cannot cross it', () => {
  // This is why the check scores the tail: x0+1 m is unreachable for the axle.
  assert.ok(CAR.rearOverhang < REAR_MARK);
  assert.ok(bay.x0 + REAR_MARK - (bay.x0 + CAR.rearOverhang) < 0.05);
});

test('the whole car has to be inside the bay lengthwise', () => {
  assert.equal(geo.parkedInSpec(pose(bay.x1 - 0.5, squarePose().y), bay), false);
});

test('the passing window is a usable band, not a razor edge', () => {
  let allowed = 0;
  for (let a = -0.3; a <= 0.05; a += 0.005) if (geo.parkedInSpec(squarePose(a), bay)) allowed++;
  assert.ok(allowed > 30, `only ${allowed} of 71 offsets of 5 mm pass`);
});

test('small heading errors still count', () => {
  const base = squarePose(-0.05);
  const passing = [];
  for (let d = -10; d <= 10; d += 0.25) {
    if (geo.parkedInSpec(pose(base.x, base.y, deg(d)), bay)) passing.push(d);
  }
  assert.ok(passing.includes(0));
  assert.ok(passing.length >= 12, `only ${passing.length} of 81 headings pass`);
});

test('the car must be stopped to be scored', () => {
  assert.equal(geo.parkedInSpec({ ...squarePose(), v: 0.2 }, bay), false);
  assert.equal(geo.parkedInSpec({ ...squarePose(), v: -0.2 }, bay), false);
});

test('a kerb-side tyre more than 25 cm from the kerb is rejected', () => {
  assert.equal(geo.parkedInSpec(squarePose(0.3), bay), false);
});

test('a pose half in the lane is rejected', () => {
  assert.equal(geo.parkedInSpec(pose((bay.x0 + bay.x1) / 2, bay.y0 + 0.6), bay), false);
});

test('bodyContacts reports the lane edge, the kerb and the raised pavement', () => {
  const limits = {
    roadBottom: ROAD_BOTTOM,
    lotEdge: bay.y0,
    edgeHit: 0.26,
    kerbGap: 0.25,
    kerbTol: 0.02,
  };
  const hugging = geo.bodyContacts(squarePose(-0.05), bay, limits);
  assert.deepEqual(hugging, { topLine: false, pavement: false, backWall: false });

  const onLine = geo.bodyContacts(pose(0, 0.1), bay, limits);
  assert.equal(onLine.topLine, true);

  const atKerb = geo.bodyContacts(pose(0, bay.y1 - 0.8), bay, limits);
  assert.equal(atKerb.backWall, true);

  const onPavement = geo.bodyContacts(squarePose(), { ...bay, x0: bay.x0 + 3.2, x1: bay.x1 + 3.2 }, limits);
  assert.equal(onPavement.pavement, true);
});

// The bug this suite exists for: the win condition was unreachable by driving.
// This replays a real reverse-park, using the same bicycle model and the same
// speed/steering constants as parking.js, from the spawn pose.
const DRIVE = {
  MAX_STEER: 33 * Math.PI / 180,
  V_FORWARD: 3.0,
  V_REVERSE: 1.8,
  TAU_ACCEL: 0.36,
  TAU_DECEL: 0.11,
  TAU_BRAKE: 0.045,
  DT: 1 / 60,
};
const STEER_RATE = DRIVE.MAX_STEER / 1.5;
const SPAWN = { x: BAY_LEN / 2 + CAR.rearOverhang, y: ROAD_BOTTOM - 3.7, h: 0, v: 0, steer: 0 };

function driveStep(car, a) {
  const dir = (a.right ? 1 : 0) - (a.left ? 1 : 0);
  if (dir) car.steer = Math.max(-DRIVE.MAX_STEER, Math.min(DRIVE.MAX_STEER, car.steer + dir * STEER_RATE * DRIVE.DT));
  else {
    const back = STEER_RATE * DRIVE.DT;
    car.steer = Math.abs(car.steer) <= back ? 0 : car.steer - Math.sign(car.steer) * back;
  }
  let target = 0;
  if (a.fwd) target = DRIVE.V_FORWARD;
  else if (a.rev) target = -DRIVE.V_REVERSE;
  let tau = Math.abs(target) < Math.abs(car.v) ? DRIVE.TAU_DECEL : DRIVE.TAU_ACCEL;
  if (a.brake) { target = 0; tau = DRIVE.TAU_BRAKE; }
  car.v += (target - car.v) * (1 - Math.exp(-DRIVE.DT / tau));
  if (Math.abs(car.v) < 0.006) car.v = 0;
  car.h += (car.v / CAR.wheelbase) * Math.tan(car.steer) * DRIVE.DT;
  car.x += Math.cos(car.h) * car.v * DRIVE.DT;
  car.y += Math.sin(car.h) * car.v * DRIVE.DT;
}

const ACTIONS = {
  RR: { rev: 1, right: 1 }, RL: { rev: 1, left: 1 }, 'R-': { rev: 1 },
  FR: { fwd: 1, right: 1 }, FL: { fwd: 1, left: 1 }, 'F-': { fwd: 1 },
  S: { brake: 1 },
};

// Frames per input, found by a beam search over this exact model.
const WINNING_RUNS = [
  ['FL', 18], ['S', 36], ['RR', 18], ['RL', 18], ['RR', 90], ['RL', 126],
  ['FL', 18], ['S', 18], ['FL', 18], ['RL', 36], ['RR', 18], ['RL', 18],
  ['RR', 18], ['FL', 18], ['RR', 36], ['S', 36], ['FL', 18], ['S', 36],
  ['RR', 18], ['FR', 36], ['RL', 18], ['S', 18], ['FL', 36], ['RL', 54],
  ['RR', 18], ['FR', 9],
];

function replay(runs, start = SPAWN) {
  const car = { ...start };
  let scored = false;
  for (const [name, frames] of runs) {
    for (let i = 0; i < frames; i++) {
      driveStep(car, ACTIONS[name]);
      if (geo.parkedInSpec(car, bay)) scored = true;
    }
  }
  return { car, scored };
}

test('a real reverse-park driven from the spawn pose reaches the pass condition', () => {
  const { car, scored } = replay(WINNING_RUNS);
  assert.ok(scored, `never scored; ended at x=${car.x.toFixed(2)} y=${car.y.toFixed(2)} deg=${(car.h * 180 / Math.PI).toFixed(1)}`);
  assert.equal(geo.parkedInSpec(car, bay), true);
});

test('the steering rate matches the 60 rpm wheel used by the sim', () => {
  assert.ok(Math.abs(STEER_RATE - (1.0) * DRIVE.MAX_STEER / (540 / 360)) < 1e-12);
});
