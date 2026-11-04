import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runStats, pausedSeconds, trackDistance, trackSegments, detectBreaks, serviceTimes } from '../js/geo.js';

const MIN = 60000;
// Drive east ~11 m per 10 s point along a road, optionally sitting still for a while.
function drive(t0, lat, lng, n, { dLng = 0.0001, step = 10000 } = {}) {
  return Array.from({ length: n }, (_, i) => ({ lat, lng: lng + i * dLng, t: t0 + i * step }));
}

test('pausedSeconds clips to the range and handles an open pause', () => {
  const pauses = [{ from: 10 * MIN, to: 20 * MIN }, { from: 50 * MIN, to: null }];
  assert.equal(pausedSeconds(pauses, 0, 60 * MIN), 20 * 60);
  assert.equal(pausedSeconds(pauses, 15 * MIN, 55 * MIN), 10 * 60);
});

test('runStats leaves breaks and overnight time out of route time', () => {
  const t0 = 0;
  const run = {
    id: 'r', startedAt: t0, endedAt: t0 + 8 * 60 * MIN, events: [],
    pauses: [{ from: t0 + 2 * 60 * MIN, to: t0 + 2.5 * 60 * MIN, kind: 'break' },
             { from: t0 + 4 * 60 * MIN, to: t0 + 6 * 60 * MIN, kind: 'overnight' }],
  };
  const st = runStats(run, []);
  assert.equal(st.totalS, 5.5 * 3600);
  assert.equal(st.breaks, 1);
});

test('the jump across a pause is not counted as miles and splits the trail', () => {
  const a = drive(0, 31.5, -95.0, 10);
  const b = drive(20 * MIN, 31.6, -95.0, 10).map((p, i) => (i === 0 ? { ...p, seg: true } : p));
  const all = [...a, ...b];
  const expected = trackDistance(a) + trackDistance(b);
  assert.ok(Math.abs(trackDistance(all) - expected) < 1e-6);
  assert.equal(trackSegments(all).length, 2);
});

test('detectBreaks finds a long sit away from stops but not one at a stop', () => {
  const t0 = 0;
  const pts = [
    ...drive(t0, 31.5, -95.0, 30),                                   // driving
    ...drive(t0 + 300000, 31.5, -94.997, 70, { dLng: 0 }),           // 11.5 min parked: lunch
    ...drive(t0 + 1000000, 31.5, -94.996, 30),                       // driving
    ...drive(t0 + 1300000, 31.5, -94.993, 60, { dLng: 0 }),          // 10 min parked at a stop
  ];
  const stops = [{ lat: 31.5, lng: -94.993 }];
  const found = detectBreaks(pts, { stops });
  assert.equal(found.length, 1);
  assert.ok(Math.abs(found[0].lng - -94.997) < 0.001); // within ~100 m of the parked spot
  // Already marked as a pause → not suggested again.
  assert.equal(detectBreaks(pts, { stops, pauses: [{ from: found[0].from, to: found[0].to }] }).length, 0);
});

test('a break right after a stop ends that stop', () => {
  const ev = { type: 'stop', lat: 31.5, lng: -95.0, t: 0 };
  const pts = drive(0, 31.5, -95.0, 120, { dLng: 0 }); // sat there 20 min
  const without = serviceTimes([ev], [...pts, { lat: 31.6, lng: -95, t: 21 * MIN }]).get(ev);
  const withPause = serviceTimes([ev], [...pts, { lat: 31.6, lng: -95, t: 21 * MIN }], { pauses: [{ from: 2 * MIN, to: 20 * MIN }] }).get(ev);
  assert.equal(without, 900); // capped at 15 min
  assert.equal(withPause, 120);
});
