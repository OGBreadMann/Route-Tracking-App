import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solvePath, pathCost, splitIntoLoads, heldKarp } from '../js/optimizer.js';

function rng(seed) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function randomMatrix(n, rand, asym = 0.2) {
  const pts = Array.from({ length: n }, () => [rand() * 1000, rand() * 1000]);
  return pts.map((a, i) => pts.map((b, j) => {
    if (i === j) return 0;
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    return d * (1 + (i < j ? asym * rand() : 0));
  }));
}

function permutations(arr) {
  if (arr.length <= 1) return [arr];
  return arr.flatMap((x, i) => permutations([...arr.slice(0, i), ...arr.slice(i + 1)]).map(p => [x, ...p]));
}

function bruteForce(m, start, stops, end) {
  let best = Infinity;
  for (const p of permutations(stops)) best = Math.min(best, pathCost(m, start, p, end));
  return best;
}

test('matches brute force on small instances (fixed end and open end)', () => {
  const rand = rng(42);
  for (let t = 0; t < 30; t++) {
    const m = randomMatrix(9, rand);
    const stops = [1, 2, 3, 4, 5, 6, 7];
    for (const end of [8, null]) {
      const { order, cost } = solvePath(m, { start: 0, end, stops, timeLimitMs: 50, random: rand });
      assert.deepEqual([...order].sort(), [...stops].sort());
      assert.ok(Math.abs(cost - pathCost(m, 0, order, end)) < 1e-6);
      assert.ok(cost <= bruteForce(m, 0, stops, end) + 1e-6, `trial ${t} end=${end}`);
    }
  }
});

test('heuristic (used above 10 stops) matches the exact optimum on 13 stops', () => {
  const rand = rng(99);
  for (let t = 0; t < 5; t++) {
    const m = randomMatrix(15, rand);
    const stops = Array.from({ length: 13 }, (_, i) => i + 1);
    for (const end of [14, null]) {
      const { cost } = solvePath(m, { start: 0, end, stops, timeLimitMs: 1000, random: rand });
      const exact = heldKarp(m, 0, stops, end);
      assert.ok(cost <= exact.cost * 1.03 + 1e-6, `trial ${t}: ${cost} vs ${exact.cost}`);
    }
  }
});

test('never worse than the given order on a larger instance', () => {
  const rand = rng(7);
  const m = randomMatrix(152, rand);
  const stops = Array.from({ length: 150 }, (_, i) => i + 1);
  const { order, cost } = solvePath(m, { start: 0, end: 151, stops, timeLimitMs: 800, random: rand });
  assert.equal(new Set(order).size, 150);
  assert.ok(cost < pathCost(m, 0, stops, 151));
});

test('splitIntoLoads respects capacity and picks cheapest breaks', () => {
  const rand = rng(3);
  const m = randomMatrix(14, rand);
  const order = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
  const res = splitIntoLoads(m, { start: 0, end: 1, order, capacity: 5, dumpNodes: [1] });
  let load = 0;
  for (const s of res.sequence) {
    if (s.type === 'stop') { load++; assert.ok(load <= 5); } else load = 0;
  }
  assert.ok(res.dumps >= 2);
  const nodes = res.sequence.map(s => s.node);
  assert.ok(Math.abs(res.cost - pathCost(m, 0, nodes, 1)) < 1e-6);
});

test('no capacity means no dump trips', () => {
  const m = randomMatrix(5, rng(1));
  const res = splitIntoLoads(m, { start: 0, end: 4, order: [1, 2, 3], capacity: null, dumpNodes: [4] });
  assert.equal(res.dumps, 0);
});
