// Route-day recording: GPS trail, stop / dump logging, screen wake lock, and
// recovery if iOS reloads the page mid-route.

import * as db from './db.js';
import { haversine, nearest } from './geo.js';

const MIN_MOVE_M = 6;        // record a point when moved this far...
const MAX_GAP_MS = 20000;    // ...or this long since the last recorded point
const MAX_ACC_M = 60;        // ignore fixes worse than this

const listeners = new Set();
const state = {
  run: null,          // active run object (persisted in 'runs')
  points: [],         // recorded points for the active run
  fix: null,          // latest GPS fix (even if not recorded)
  watchId: null,
  wakeLock: null,
  wakeLockOk: false,
  error: null,
};

export const tracker = {
  get run() { return state.run; },
  get points() { return state.points; },
  get fix() { return state.fix; },
  get wakeLockOk() { return state.wakeLockOk; },
  get error() { return state.error; },
  on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  start, resume, end, logStop, logDump, undo, startWatch, stopWatch,
};

function emit(type, data) {
  for (const fn of listeners) fn(type, data);
}

/** Start watching GPS (also used outside a run so the map can show "you are here"). */
function startWatch() {
  if (state.watchId != null || !('geolocation' in navigator)) return;
  state.watchId = navigator.geolocation.watchPosition(onFix, onError, {
    enableHighAccuracy: true, maximumAge: 0, timeout: 30000,
  });
}

function stopWatch() {
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
}

function onError(err) {
  state.error = err.code === 1
    ? 'Location permission denied. Allow location for this site in Settings → Privacy → Location Services → Safari Websites.'
    : `GPS: ${err.message}`;
  emit('error', state.error);
}

async function onFix(pos) {
  state.error = null;
  const c = pos.coords;
  const fix = { lat: c.latitude, lng: c.longitude, acc: c.accuracy, spd: c.speed, t: pos.timestamp || Date.now() };
  state.fix = fix;
  emit('fix', fix);
  if (!state.run || fix.acc > MAX_ACC_M) return;
  const last = state.points[state.points.length - 1];
  if (last && haversine(last, fix) < MIN_MOVE_M && fix.t - last.t < MAX_GAP_MS) return;
  const point = { runId: state.run.id, ...fix };
  state.points.push(point);
  emit('point', point);
  try { await db.put('points', point); } catch (e) { console.error('save point', e); }
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLockOk = true;
      state.wakeLock.addEventListener('release', () => { state.wakeLockOk = false; emit('wakelock', false); });
    }
  } catch (e) {
    state.wakeLockOk = false;
  }
  emit('wakelock', state.wakeLockOk);
}

document.addEventListener('visibilitychange', async () => {
  if (!state.run) return;
  if (document.visibilityState === 'visible') {
    await requestWakeLock();
    state.run.gaps = state.run.gaps || [];
    const hiddenAt = state.run._hiddenAt;
    if (hiddenAt && Date.now() - hiddenAt > 30000) {
      state.run.gaps.push({ from: hiddenAt, to: Date.now() });
      emit('gap', { from: hiddenAt, to: Date.now() });
    }
    delete state.run._hiddenAt;
    await saveRun();
  } else {
    state.run._hiddenAt = Date.now();
    await saveRun();
  }
});

async function saveRun() {
  if (state.run) await db.put('runs', { ...state.run });
}

async function start(routeId) {
  const run = { id: db.uid(), routeId, startedAt: Date.now(), endedAt: null, events: [], gaps: [] };
  state.run = run;
  state.points = [];
  if (state.fix && state.fix.acc <= MAX_ACC_M && Date.now() - state.fix.t < 60000) {
    const p = { runId: run.id, ...state.fix, t: Date.now() };
    state.points.push(p);
    await db.put('points', p);
  }
  await saveRun();
  await db.setSetting('activeRunId', run.id);
  startWatch();
  await requestWakeLock();
  emit('run', run);
  return run;
}

/** Called on app load: pick up an unfinished run (e.g. after iOS reloaded the page). */
async function resume() {
  const id = await db.getSetting('activeRunId');
  if (!id) return null;
  const run = await db.get('runs', id);
  if (!run || run.endedAt) { await db.setSetting('activeRunId', null); return null; }
  state.run = run;
  state.points = (await db.byIndex('points', 'runId', id)).sort((a, b) => a.t - b.t);
  const lastT = state.points.length ? state.points[state.points.length - 1].t : run.startedAt;
  if (Date.now() - lastT > 60000) {
    run.gaps = run.gaps || [];
    run.gaps.push({ from: lastT, to: Date.now() });
  }
  delete run._hiddenAt;
  await saveRun();
  startWatch();
  await requestWakeLock();
  emit('run', run);
  return run;
}

async function end() {
  const run = state.run;
  if (!run) return null;
  run.endedAt = Date.now();
  delete run._hiddenAt;
  await saveRun();
  await db.setSetting('activeRunId', null);
  try { await state.wakeLock?.release(); } catch {}
  state.wakeLock = null;
  state.run = null;
  emit('run', null);
  return run;
}

function currentPosition() {
  const f = state.fix;
  if (f && Date.now() - f.t < 120000) return f;
  const p = state.points[state.points.length - 1];
  return p || null;
}

/**
 * Log a pickup at the current spot. If a saved stop for this route (or an
 * imported customer not yet on a route) is within `matchRadius`, the visit is
 * attached to it; otherwise a new stop is created.
 */
async function logStop({ matchRadius = 25 } = {}) {
  const run = state.run;
  const pos = currentPosition();
  if (!run) throw new Error('No route in progress');
  if (!pos) throw new Error('No GPS fix yet — wait a few seconds and try again');

  const visited = new Set(run.events.filter(e => e.stopId).map(e => e.stopId));
  const routeStops = await db.byIndex('stops', 'routeId', run.routeId);
  const pool = (await db.all('stops')).filter(s => s.routeId == null && s.lat != null);
  const candidates = [...routeStops, ...pool].filter(s => !visited.has(s.id) && s.active !== false);
  const match = nearest(pos, candidates, matchRadius);

  let stop, created = false;
  if (match) {
    stop = match.item;
    if (stop.routeId == null) { stop.routeId = run.routeId; await db.put('stops', stop); }
  } else {
    stop = {
      id: db.uid(), routeId: run.routeId, lat: pos.lat, lng: pos.lng,
      name: '', address: '', note: '', active: true, source: 'gps', createdAt: Date.now(),
    };
    await db.put('stops', stop);
    created = true;
  }
  const ev = { type: 'stop', stopId: stop.id, lat: pos.lat, lng: pos.lng, acc: pos.acc, t: Date.now(), created };
  run.events.push(ev);
  await saveRun();
  emit('event', ev);
  return { event: ev, stop, created, matchDist: match?.dist ?? null, acc: pos.acc };
}

/** Log a dump/landfill visit. Saves the spot as a dump site if it's a new one. */
async function logDump() {
  const run = state.run;
  const pos = currentPosition();
  if (!run) throw new Error('No route in progress');
  if (!pos) throw new Error('No GPS fix yet — wait a few seconds and try again');
  const dumps = await db.getSetting('dumps', []);
  let site = nearest(pos, dumps, 400)?.item;
  if (!site) {
    site = { id: db.uid(), name: `Dump site ${dumps.length + 1}`, lat: pos.lat, lng: pos.lng };
    dumps.push(site);
    await db.setSetting('dumps', dumps);
  }
  const ev = { type: 'dump', dumpId: site.id, lat: pos.lat, lng: pos.lng, acc: pos.acc, t: Date.now() };
  run.events.push(ev);
  await saveRun();
  emit('event', ev);
  return { event: ev, site };
}

async function undo() {
  const run = state.run;
  const ev = run?.events.pop();
  if (!ev) return null;
  if (ev.type === 'stop' && ev.created) {
    // Only remove the stop if nothing else ever referenced it.
    const runs = await db.byIndex('runs', 'routeId', run.routeId);
    const used = runs.some(r => r.id !== run.id && r.events.some(e => e.stopId === ev.stopId));
    if (!used) await db.del('stops', ev.stopId);
  }
  await saveRun();
  emit('event', null);
  return ev;
}
