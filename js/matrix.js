// Real road drive times between places, from the free public OSRM server
// (OpenStreetMap road data). Results are cached on the phone so re-running the
// optimizer doesn't refetch. If the server can't be reached, falls back to a
// straight-line estimate (clearly flagged in the result).

import { getLegs, putLegs } from './db.js';
import { haversine, coordKey } from './geo.js';

// Two free public OSRM servers; the second is a backup if the first is down.
const SERVERS = ['https://router.project-osrm.org', 'https://routing.openstreetmap.de/routed-car'];
const BLOCK = 50;          // 50 sources x 50 destinations = 100 coords per request (server limit)
const MIN_GAP_MS = 1100;   // be polite to the free demo server: ~1 request / second

let lastRequest = 0;
async function throttledFetch(path) {
  const wait = lastRequest + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastRequest = Date.now();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(SERVERS[attempt % SERVERS.length] + path);
      if (res.status === 429) { await new Promise(r => setTimeout(r, 3000 * (attempt + 1))); continue; }
      const json = await res.json();
      if (json.code !== 'Ok') throw new Error(json.message || json.code);
      return json;
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

const coordStr = pts => pts.map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');

/** Straight-line guess: rural roads wind ~35% more than the crow flies, ~35 mph average. */
function estimateLeg(a, b) {
  const dist = haversine(a, b) * 1.35;
  return { dur: dist / 15.6, dist, est: true };
}

/**
 * @param {{lat:number,lng:number}[]} points
 * @param {(done:number,total:number)=>void} [onProgress]
 * @returns {Promise<{dur:number[][], dist:number[][], estimated:boolean}>}
 */
export async function buildMatrix(points, onProgress = () => {}) {
  const n = points.length;
  const keys = points.map(coordKey);
  const pairKey = (i, j) => `${keys[i]}>${keys[j]}`;

  const wanted = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) wanted.push(pairKey(i, j));
  const cache = await getLegs(wanted);

  // Plan blocks that still have missing pairs.
  const blocks = [];
  for (let si = 0; si < n; si += BLOCK) {
    for (let di = 0; di < n; di += BLOCK) {
      const src = range(si, Math.min(n, si + BLOCK));
      const dst = range(di, Math.min(n, di + BLOCK));
      const missing = src.some(i => dst.some(j => i !== j && !cache.has(pairKey(i, j))));
      if (missing) blocks.push({ src, dst });
    }
  }

  let estimated = false;
  let done = 0;
  onProgress(0, blocks.length);
  for (const { src, dst } of blocks) {
    // Union of coordinates (src and dst may overlap on the diagonal blocks).
    const idx = [...new Set([...src, ...dst])];
    const pos = new Map(idx.map((v, k) => [v, k]));
    const url = `/table/v1/driving/${coordStr(idx.map(i => points[i]))}` +
      `?sources=${src.map(i => pos.get(i)).join(';')}` +
      `&destinations=${dst.map(i => pos.get(i)).join(';')}&annotations=duration,distance`;
    const fresh = [];
    try {
      const json = await throttledFetch(url);
      src.forEach((i, a) => dst.forEach((j, b) => {
        if (i === j) return;
        const dur = json.durations[a][b], dist = json.distances?.[a]?.[b];
        const v = dur == null ? estimateLeg(points[i], points[j]) : { dur, dist: dist ?? null };
        cache.set(pairKey(i, j), v);
        if (!v.est) fresh.push([pairKey(i, j), v]);
      }));
    } catch (e) {
      console.warn('OSRM table failed, estimating', e);
      estimated = true;
      src.forEach(i => dst.forEach(j => {
        if (i !== j && !cache.has(pairKey(i, j))) cache.set(pairKey(i, j), estimateLeg(points[i], points[j]));
      }));
    }
    if (fresh.length) await putLegs(fresh);
    onProgress(++done, blocks.length);
  }

  const dur = [], dist = [];
  for (let i = 0; i < n; i++) {
    dur.push(new Array(n)); dist.push(new Array(n));
    for (let j = 0; j < n; j++) {
      if (i === j) { dur[i][j] = 0; dist[i][j] = 0; continue; }
      const v = cache.get(pairKey(i, j)) || estimateLeg(points[i], points[j]);
      if (v.est) estimated = true;
      dur[i][j] = v.dur;
      dist[i][j] = v.dist ?? haversine(points[i], points[j]) * 1.35;
    }
  }
  return { dur, dist, estimated };
}

/**
 * Road-following line through the given points in order, for drawing on the map.
 * Returns an array of [lat, lng]. Falls back to straight lines on failure.
 */
export async function routeLine(points) {
  const CHUNK = 40;
  const out = [];
  for (let i = 0; i < points.length - 1; i += CHUNK - 1) {
    const chunk = points.slice(i, i + CHUNK);
    if (chunk.length < 2) break;
    try {
      const json = await throttledFetch(
        `/route/v1/driving/${coordStr(chunk)}?overview=full&geometries=geojson&continue_straight=false`);
      for (const [lng, lat] of json.routes[0].geometry.coordinates) out.push([lat, lng]);
    } catch {
      for (const p of chunk) out.push([p.lat, p.lng]);
    }
  }
  return out;
}

function range(a, b) {
  const r = [];
  for (let i = a; i < b; i++) r.push(i);
  return r;
}
