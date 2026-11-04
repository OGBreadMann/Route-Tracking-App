// Pure geometry / track-analysis helpers (no DOM, testable in Node).

const R = 6371000;
const rad = d => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversine(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Total distance along a list of points, ignoring GPS jumps that imply > 160 km/h
 *  and the jump across a pause (a point flagged `seg` starts a new segment). */
export function trackDistance(points) {
  let d = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].seg) continue;
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
export function serviceTimes(events, points, { leaveM = 35, capS = 900, pauses = [] } = {}) {
  const out = new Map();
  let pi = 0;
  for (const ev of events) {
    if (ev.type !== 'stop') continue;
    while (pi < points.length && points[pi].t < ev.t) pi++;
    let leftAt = null;
    for (let k = pi; k < points.length; k++) {
      if (haversine(ev, points[k]) > leaveM) { leftAt = points[k].t; break; }
    }
    // A pause that starts before the truck pulls away ends the stop (e.g. lunch right after a pickup).
    const pause = pauses.find(p => p.from >= ev.t && (leftAt == null || p.from < leftAt));
    if (pause) leftAt = pause.from;
    if (leftAt != null) out.set(ev, Math.min(capS, Math.max(0, (leftAt - ev.t) / 1000)));
  }
  return out;
}

/** Summary numbers for a finished (or in-progress) run. */
export function runStats(run, points, now = Date.now()) {
  const end = run.endedAt || now; // still running: count up to now
  const pausedS = pausedSeconds(run.pauses, run.startedAt, end);
  const totalS = Math.max(0, (end - run.startedAt) / 1000 - pausedS);
  const service = serviceTimes(run.events, points, { pauses: run.pauses || [] });
  let serviceS = 0;
  for (const s of service.values()) serviceS += s;
  const stops = run.events.filter(e => e.type === 'stop').length;
  const dumps = run.events.filter(e => e.type === 'dump').length;
  return {
    totalS,
    pausedS,
    breaks: (run.pauses || []).filter(p => p.kind !== 'overnight').length,
    distanceM: trackDistance(points),
    stops,
    dumps,
    serviceS,
    avgServiceS: service.size ? serviceS / service.size : null,
    driveS: Math.max(0, totalS - serviceS),
  };
}

/** Seconds of [from, to] covered by pauses (an open pause runs until `to`). */
export function pausedSeconds(pauses = [], from, to) {
  let ms = 0;
  for (const p of pauses) {
    const a = Math.max(p.from, from), b = Math.min(p.to ?? to, to);
    if (b > a) ms += b - a;
  }
  return ms / 1000;
}

/** Split a track into polylines at pause boundaries (points flagged `seg`). */
export function trackSegments(points) {
  const segs = [];
  for (const p of points) {
    if (!segs.length || p.seg) segs.push([]);
    segs[segs.length - 1].push([p.lat, p.lng]);
  }
  return segs;
}

/**
 * Likely breaks (food, gas) in a recorded day: the truck sat within `radiusM` of
 * one spot for at least `minS` seconds, and that spot isn't a logged stop or a
 * known place (home / dump). Periods already marked as pauses are skipped.
 */
export function detectBreaks(points, { stops = [], places = [], pauses = [], minS = 300, radiusM = 60, awayM = 150, placeM = 300 } = {}) {
  const out = [];
  let i = 0;
  while (i < points.length) {
    let j = i;
    while (j + 1 < points.length && !points[j + 1].seg && haversine(points[i], points[j + 1]) < radiusM) j++;
    const from = points[i].t, to = points[j].t;
    if ((to - from) / 1000 >= minS) {
      const p = points[i];
      const nearStop = stops.some(s => s.lat != null && haversine(p, s) < awayM);
      const nearPlace = places.some(s => s && s.lat != null && haversine(p, s) < placeM);
      const overlaps = pauses.some(x => x.from < to && (x.to ?? Infinity) > from);
      if (!nearStop && !nearPlace && !overlaps) out.push({ from, to, lat: p.lat, lng: p.lng });
      i = j + 1;
    } else i++;
  }
  return out;
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
