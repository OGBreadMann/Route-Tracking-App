// Turns recorded data into an optimization problem and compares the result with
// the order actually driven. Both orders are timed with the same road-time
// matrix, so the comparison is apples to apples.

import { buildMatrix } from './matrix.js';
import { solvePath, splitIntoLoads, pathCost } from './optimizer.js';
import { loadsFromEvents } from './geo.js';

/**
 * @param {object} p
 * @param {object} p.run          baseline run (the day to compare against), may be null if includeAll
 * @param {object[]} p.routeStops all stops saved on the route
 * @param {boolean} p.includeAll  optimize every active saved stop, not just the ones visited in `run`
 * @param {{lat,lng}|null} p.home
 * @param {object[]} p.dumps      dump sites [{id,lat,lng,name}]
 * @param {'dump'|'home'|'open'} p.endMode
 * @param {number|null} p.capacity  max stops per truckload (null = no mid-route dump trips)
 * @param {(msg:string)=>void} p.onProgress
 */
export async function optimizeRoute({ run, routeStops, includeAll, home, dumps, endMode, capacity, onProgress = () => {} }) {
  const stopById = new Map(routeStops.map(s => [s.id, s]));
  const placed = s => s && s.lat != null && s.active !== false;

  let stops;
  if (includeAll || !run) {
    stops = routeStops.filter(placed);
  } else {
    const seen = new Set();
    stops = [];
    for (const e of run.events) {
      const s = stopById.get(e.stopId);
      if (e.type === 'stop' && placed(s) && !seen.has(s.id)) { seen.add(s.id); stops.push(s); }
    }
  }
  if (stops.length < 2) throw new Error('Need at least 2 stops with a location to optimize.');

  // Node layout: [start, ...dumps, ...stops]
  const firstPoint = run?.events.find(e => e.lat != null);
  const start = home || firstPoint || stops[0];
  const nodes = [{ kind: 'start', ...pick(start) }, ...dumps.map(d => ({ kind: 'dump', id: d.id, ...pick(d) })),
    ...stops.map(s => ({ kind: 'stop', id: s.id, ...pick(s) }))];
  const dumpNodes = dumps.map((_, i) => 1 + i);
  const stopNodes = stops.map((_, i) => 1 + dumps.length + i);
  const nodeOfStop = new Map(stops.map((s, i) => [s.id, stopNodes[i]]));
  const nodeOfDump = new Map(dumps.map((d, i) => [d.id, dumpNodes[i]]));

  onProgress('Getting real drive times between stops…');
  const { dur, dist, estimated } = await buildMatrix(nodes, (done, total) => {
    if (total) onProgress(`Getting real drive times… ${done}/${total}`);
  });

  // ----- the order actually driven (only comparable when the stop set matches)
  let yours = null;
  const comparable = run && (!includeAll || stops.every(s => run.events.some(e => e.stopId === s.id)));
  if (comparable) {
    const seq = [];
    const seen = new Set();
    for (const e of run.events) {
      if (e.type === 'stop' && nodeOfStop.has(e.stopId) && !seen.has(e.stopId)) { seen.add(e.stopId); seq.push(nodeOfStop.get(e.stopId)); }
      else if (e.type === 'dump' && nodeOfDump.has(e.dumpId)) seq.push(nodeOfDump.get(e.dumpId));
    }
    // A dump at the very end of the day is the "end", not a mid-route trip.
    let end = resolveEnd(endMode, dumpNodes, dur, seq.filter(n => !dumpNodes.includes(n)).at(-1));
    if (endMode === 'dump' && dumpNodes.includes(seq.at(-1))) end = seq.pop();
    while (seq.length && dumpNodes.includes(seq[0])) seq.shift(); // dump before the first pickup: ignore
    yours = {
      nodes: seq, end,
      driveS: pathCost(dur, 0, seq, end),
      distM: pathCost(dist, 0, seq, end),
      dumps: seq.filter(n => dumpNodes.includes(n)).length,
    };
  }

  // ----- best order: try each possible end dump, keep the cheapest overall
  onProgress('Finding the fastest order…');
  await new Promise(r => setTimeout(r, 30)); // let the progress text paint
  const ends = endMode === 'dump' && dumpNodes.length ? dumpNodes : [endMode === 'home' ? 0 : null];
  const budget = Math.min(4000, 800 + stops.length * 15) / ends.length;
  let best = null;
  for (const end of ends) {
    const { order } = solvePath(dur, { start: 0, end, stops: stopNodes, timeLimitMs: budget });
    const split = splitIntoLoads(dur, { start: 0, end, order, capacity, dumpNodes });
    if (!best || split.cost < best.split.cost) best = { end, split };
  }
  const seqNodes = best.split.sequence.map(s => s.node);
  const suggested = {
    nodes: seqNodes, end: best.end,
    driveS: best.split.cost,
    distM: pathCost(dist, 0, seqNodes, best.end),
    dumps: best.split.dumps,
    sequence: best.split.sequence.map(s => nodes[s.node].kind === 'dump'
      ? { type: 'dump', dumpId: nodes[s.node].id }
      : { type: 'stop', stopId: nodes[s.node].id }),
  };

  // If the driven order is already better (local search is a heuristic), say so honestly.
  if (yours && yours.driveS <= suggested.driveS) suggested.alreadyOptimal = true;

  return { nodes, stops, start, suggested, yours, estimated, capacity };
}

/** Suggest a truckload size from a run: biggest load between dump trips, or null. */
export function capacityFromRun(run) {
  const loads = loadsFromEvents(run?.events || []);
  return loads.length > 1 ? Math.max(...loads) : null;
}

function resolveEnd(endMode, dumpNodes, dur, lastStop) {
  if (endMode === 'home') return 0;
  if (endMode === 'dump' && dumpNodes.length && lastStop != null) {
    return dumpNodes.reduce((a, b) => (dur[lastStop][b] < dur[lastStop][a] ? b : a));
  }
  return null;
}

function pick(p) {
  return { lat: p.lat, lng: p.lng };
}
