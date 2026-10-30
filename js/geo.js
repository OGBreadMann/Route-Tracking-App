// Pure geometry / track-analysis helpers (no DOM, testable in Node).

const R = 6371000;
const rad = d => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversine(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Total distance along a list of points, ignoring GPS jumps that imply > 160 km/h. */
export function trackDistance(points) {
  let d = 0;
  for (let i = 1; i < points.length; i++) {
    const seg = haversine(points[i - 1], points[i]);
    const dt = (points[i].t - points[i - 1].t) / 1000;
    if (dt > 0 && seg / dt > 45) continue;
    d += seg;
  }
  return d;
}

/** Find the closest of `candidates` within `maxM` metres, or null. */
export function nearest(p, candidates, maxM = Infinity) {
  let best = null, bestD = maxM;
  for (const c of candidates) {
    if (c.lat == null) continue;
    const d = haversine(p, c);
    if (d <= bestD) { bestD = d; best = c; }
  }
  return best ? { item: best, dist: bestD } : null;
}

/**
 * Work out how long the truck sat at each logged stop: from the moment the stop
 * was logged until the track first moves more than `leaveM` metres away from it.
 * Capped so a forgotten tap doesn't produce an absurd number.
 */
export function serviceTimes(events, points, { leaveM = 35, capS = 900 } = {}) {
  const out = new Map();
  let pi = 0;
  for (const ev of events) {
    if (ev.type !== 'stop') continue;
    while (pi < points.length && points[pi].t < ev.t) pi++;
    let leftAt = null;
    for (let k = pi; k < points.length; k++) {
      if (haversine(ev, points[k]) > leaveM) { leftAt = points[k].t; break; }
    }
    if (leftAt != null) out.set(ev, Math.min(capS, Math.max(0, (leftAt - ev.t) / 1000)));
  }
  return out;
}

/** Summary numbers for a finished (or in-progress) run. */
export function runStats(run, points) {
  const end = run.endedAt || (points.length ? points[points.length - 1].t : run.startedAt);
  const totalS = Math.max(0, (end - run.startedAt) / 1000);
  const service = serviceTimes(run.events, points);
  let serviceS = 0;
  for (const s of service.values()) serviceS += s;
  const stops = run.events.filter(e => e.type === 'stop').length;
  const dumps = run.events.filter(e => e.type === 'dump').length;
  return {
    totalS,
    distanceM: trackDistance(points),
    stops,
    dumps,
    serviceS,
    avgServiceS: service.size ? serviceS / service.size : null,
    driveS: Math.max(0, totalS - serviceS),
  };
}

/**
 * Truckload sizes from a run: number of stops between dump visits.
 * A dump after the last stop just ends the day and doesn't split a load.
 */
export function loadsFromEvents(events) {
  const loads = [];
  let cur = 0;
  for (const e of events) {
    if (e.type === 'stop') cur++;
    else if (e.type === 'dump' && cur > 0) { loads.push(cur); cur = 0; }
  }
  if (cur > 0) loads.push(cur);
  return loads;
}

export function fmtDuration(s) {
  if (s == null || !isFinite(s)) return '–';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${s}s`;
}

export function fmtMiles(m) {
  if (m == null || !isFinite(m)) return '–';
  return `${(m / 1609.344).toFixed(m < 16093 ? 1 : 0)} mi`;
}

/** Key used for the drive-time cache (≈1 m precision). */
export function coordKey(p) {
  return `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
}
