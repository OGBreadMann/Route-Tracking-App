// Route optimizer: finds a fast order to visit stops given a travel-time matrix.
//
// Problem shape: an open path that starts at a fixed node (home), visits every
// stop exactly once, and ends at a fixed node (dump / home) or wherever the last
// stop is. Travel times may be asymmetric (one-way roads, turn costs).
//
// Approach: nearest-neighbour + randomized greedy starts, improved with 2-opt
// and Or-opt local search, wrapped in iterated local search (double-bridge kicks)
// for a fixed time budget. For truckload limits, the best order is then split
// into loads with dump visits inserted where they cost the least (exact DP).

/**
 * @param {number[][]} m   time matrix, m[i][j] = seconds from node i to node j
 * @param {object} opts
 * @param {number} opts.start       node index the path starts at
 * @param {number|null} opts.end    node index the path must finish at, or null for open end
 * @param {number[]} opts.stops     node indices that must be visited
 * @param {number} [opts.timeLimitMs=1500]
 * @param {() => number} [opts.random]
 * @returns {{order:number[], cost:number}} order = stops in visiting order
 */
export function solvePath(m, { start, end = null, stops, timeLimitMs = 1500, random = Math.random }) {
  const n = stops.length;
  if (n === 0) return { order: [], cost: end == null ? 0 : m[start][end] };
  if (n === 1) return { order: stops.slice(), cost: pathCost(m, start, stops, end) };
  if (n <= 10) return heldKarp(m, start, stops, end);

  const deadline = now() + timeLimitMs;
  let best = localSearch(m, start, end, nearestNeighbour(m, start, stops));
  let bestCost = pathCost(m, start, best, end);

  // A few randomized greedy starts give the local search different basins.
  for (let k = 0; k < 4 && now() < deadline; k++) {
    const cand = localSearch(m, start, end, randomizedGreedy(m, start, stops, random));
    const c = pathCost(m, start, cand, end);
    if (c < bestCost - 1e-9) { best = cand; bestCost = c; }
  }

  // Iterated local search from the incumbent.
  let cur = best, curCost = bestCost;
  while (now() < deadline) {
    const cand = localSearch(m, start, end, doubleBridge(cur, random));
    const c = pathCost(m, start, cand, end);
    if (c < curCost - 1e-9) {
      cur = cand; curCost = c;
      if (c < bestCost - 1e-9) { best = cand; bestCost = c; }
    } else if (random() < 0.05) {
      cur = best; curCost = bestCost; // occasional restart from the best known
    }
  }
  return { order: best, cost: bestCost };
}

/** Total travel time of start -> order... -> end (end may be null). */
export function pathCost(m, start, order, end = null) {
  if (!order.length) return end == null ? 0 : m[start][end];
  let c = m[start][order[0]];
  for (let i = 1; i < order.length; i++) c += m[order[i - 1]][order[i]];
  if (end != null) c += m[order[order.length - 1]][end];
  return c;
}

/**
 * Split a visiting order into truckloads of at most `capacity` stops, inserting
 * a dump trip between loads at the cheapest point. Exact DP over break points.
 * The final dump (if the day ends at the dump) is handled by the caller's `end`.
 *
 * @returns {{sequence:Array<{type:'stop'|'dump', node:number}>, cost:number, dumps:number}}
 */
export function splitIntoLoads(m, { start, end = null, order, capacity, dumpNodes }) {
  const n = order.length;
  if (!capacity || capacity >= n || !dumpNodes.length) {
    return {
      sequence: order.map(node => ({ type: 'stop', node })),
      cost: pathCost(m, start, order, end),
      dumps: 0,
    };
  }
  // detour(i) = extra time to go order[i] -> best dump -> order[i+1], and which dump.
  const detour = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const a = order[i], b = order[i + 1];
    let bestD = null, bestExtra = Infinity;
    for (const d of dumpNodes) {
      const extra = m[a][d] + m[d][b] - m[a][b];
      if (extra < bestExtra) { bestExtra = extra; bestD = d; }
    }
    detour[i] = { extra: bestExtra, dump: bestD };
  }
  // f[i] = min extra cost when a load ends right after stop i (a break after i),
  // with all stops 0..i covered. f[-1] = 0 is the start of the day.
  const f = new Array(n).fill(Infinity);
  const prev = new Array(n).fill(-2);
  for (let i = 0; i < n; i++) {
    for (let j = Math.max(-1, i - capacity); j < i; j++) {
      // load covers stops j+1..i; a break after j costs detour[j] (none at start)
      const base = j === -1 ? 0 : f[j] + detour[j].extra;
      if (base < f[i]) { f[i] = base; prev[i] = j; }
    }
  }
  const breaks = new Set();
  for (let i = n - 1; prev[i] !== -1; i = prev[i]) breaks.add(prev[i]);
  const sequence = [];
  order.forEach((node, i) => {
    sequence.push({ type: 'stop', node });
    if (breaks.has(i)) sequence.push({ type: 'dump', node: detour[i].dump });
  });
  return { sequence, cost: pathCost(m, start, order, end) + f[n - 1], dumps: breaks.size };
}

/** Travel time of an explicit sequence of node indices (stops and dumps mixed). */
export function sequenceCost(m, start, nodes, end = null) {
  return pathCost(m, start, nodes, end);
}

// ---------------------------------------------------------------------------

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Exact dynamic-programming solution for small stop counts. */
export function heldKarp(m, start, stops, end) {
  const n = stops.length, full = (1 << n) - 1;
  const dp = new Float64Array((1 << n) * n).fill(Infinity);
  const par = new Int8Array((1 << n) * n).fill(-1);
  for (let i = 0; i < n; i++) dp[(1 << i) * n + i] = m[start][stops[i]];
  for (let mask = 1; mask <= full; mask++) {
    for (let i = 0; i < n; i++) {
      const cur = dp[mask * n + i];
      if (!(mask & (1 << i)) || cur === Infinity) continue;
      for (let j = 0; j < n; j++) {
        if (mask & (1 << j)) continue;
        const nm = mask | (1 << j), v = cur + m[stops[i]][stops[j]];
        if (v < dp[nm * n + j]) { dp[nm * n + j] = v; par[nm * n + j] = i; }
      }
    }
  }
  let bestI = 0, bestCost = Infinity;
  for (let i = 0; i < n; i++) {
    const v = dp[full * n + i] + (end != null ? m[stops[i]][end] : 0);
    if (v < bestCost) { bestCost = v; bestI = i; }
  }
  const order = [];
  for (let mask = full, i = bestI; i !== -1;) {
    order.push(stops[i]);
    const p = par[mask * n + i];
    mask &= ~(1 << i); i = p;
  }
  return { order: order.reverse(), cost: bestCost };
}

function nearestNeighbour(m, start, stops) {
  const left = new Set(stops);
  const out = [];
  let cur = start;
  while (left.size) {
    let best = null, bestC = Infinity;
    for (const s of left) if (m[cur][s] < bestC) { bestC = m[cur][s]; best = s; }
    out.push(best); left.delete(best); cur = best;
  }
  return out;
}

function randomizedGreedy(m, start, stops, random) {
  const left = new Set(stops);
  const out = [];
  let cur = start;
  while (left.size) {
    // pick among the 3 nearest
    const cands = [...left].sort((a, b) => m[cur][a] - m[cur][b]).slice(0, 3);
    const pick = cands[Math.floor(random() * cands.length)];
    out.push(pick); left.delete(pick); cur = pick;
  }
  return out;
}

function doubleBridge(order, random) {
  const n = order.length;
  const cuts = [];
  while (cuts.length < 3) {
    const c = 1 + Math.floor(random() * (n - 1));
    if (!cuts.includes(c)) cuts.push(c);
  }
  cuts.sort((a, b) => a - b);
  const [a, b, c] = cuts;
  return [...order.slice(0, a), ...order.slice(b, c), ...order.slice(a, b), ...order.slice(c)];
}

/**
 * 2-opt (segment reversal) + Or-opt (move a run of 1-3 stops, optionally
 * reversed) until no improving move exists. Works on asymmetric matrices by
 * using prefix sums of forward and backward edge costs along the path.
 */
function localSearch(m, start, end, order) {
  // Work on a full path P = [start, ...order, end?] so edges are uniform.
  const P = [start, ...order];
  if (end != null) P.push(end);
  const last = end != null ? P.length - 2 : P.length - 1; // last movable index
  let improved = true;
  while (improved) {
    improved = twoOpt(m, P, last) || orOpt(m, P, last);
  }
  return P.slice(1, last + 1);
}

function twoOpt(m, P, last) {
  const len = P.length;
  // fwd[k] = sum of m[P[t]][P[t+1]] for t < k; bwd[k] = sum of m[P[t+1]][P[t]] for t < k
  const fwd = new Float64Array(len), bwd = new Float64Array(len);
  for (let t = 1; t < len; t++) {
    fwd[t] = fwd[t - 1] + m[P[t - 1]][P[t]];
    bwd[t] = bwd[t - 1] + m[P[t]][P[t - 1]];
  }
  for (let i = 1; i < last; i++) {
    for (let j = i + 1; j <= last; j++) {
      // reverse P[i..j]
      const hasNext = j + 1 < len;
      const before = m[P[i - 1]][P[i]] + (fwd[j] - fwd[i]) + (hasNext ? m[P[j]][P[j + 1]] : 0);
      const after = m[P[i - 1]][P[j]] + (bwd[j] - bwd[i]) + (hasNext ? m[P[i]][P[j + 1]] : 0);
      if (after < before - 1e-9) {
        reverse(P, i, j);
        return true;
      }
    }
  }
  return false;
}

function orOpt(m, P, last) {
  const len = P.length;
  const w = (a, b) => (b < len ? m[P[a]][P[b]] : 0);
  for (let segLen = 1; segLen <= 3; segLen++) {
    for (let i = 1; i + segLen - 1 <= last; i++) {
      const j = i + segLen - 1; // segment P[i..j]
      const removeGain = w(i - 1, i) + w(j, j + 1) - (j + 1 < len ? m[P[i - 1]][P[j + 1]] : 0);
      let inner = 0, innerRev = 0;
      for (let t = i; t < j; t++) { inner += m[P[t]][P[t + 1]]; innerRev += m[P[t + 1]][P[t]]; }
      // insert between P[k] and P[k+1], k outside [i-1, j]
      for (let k = 0; k <= last; k++) {
        if (k >= i - 1 && k <= j) continue;
        const hasNext = k + 1 < len && k + 1 !== i;
        const nxt = k + 1 < len ? P[k + 1] : null;
        const oldEdge = hasNext ? m[P[k]][nxt] : 0;
        const fwdAdd = m[P[k]][P[i]] + inner + (hasNext ? m[P[j]][nxt] : 0) - oldEdge;
        const revAdd = m[P[k]][P[j]] + innerRev + (hasNext ? m[P[i]][nxt] : 0) - oldEdge;
        const curInner = inner; // segment kept in the same direction costs `inner` already
        if (fwdAdd - curInner < removeGain - 1e-9 || revAdd - curInner < removeGain - 1e-9) {
          const useRev = revAdd < fwdAdd;
          const seg = P.splice(i, segLen);
          if (useRev) seg.reverse();
          const at = k < i ? k + 1 : k + 1 - segLen;
          P.splice(at, 0, ...seg);
          return true;
        }
      }
    }
  }
  return false;
}

function reverse(a, i, j) {
  while (i < j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
}
