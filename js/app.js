// Pinky's Route Tracker — screens and wiring.
/* global L */

import * as db from './db.js';
import { tracker } from './tracker.js';
import { runStats, fmtDuration, fmtMiles, serviceTimes, haversine } from './geo.js';
import { optimizeRoute, capacityFromRun } from './analysis.js';
import { routeLine } from './matrix.js';
import { parseCsv, rowsToCustomers, importCustomers } from './importer.js';
import {
  h, toast, sheet, confirmSheet, promptSheet, makeMap, numberIcon, placeIcon, meIcon, fitTo,
  appleMapsUrl, pickLocation, download, fmtDate, fmtTime,
} from './ui.js';

const view = document.getElementById('view');
const tabs = document.querySelectorAll('nav.tabs button');
let maps = [];
let cleanup = [];

function resetView() {
  for (const fn of cleanup) fn();
  cleanup = [];
  for (const m of maps) m.remove();
  maps = [];
  view.replaceChildren();
  window.scrollTo(0, 0);
}

/** Append to the screen, skipping empty (null/false) entries. */
function show(...nodes) {
  view.append(...nodes.flat().filter(n => n != null && n !== false));
}

function addMap(el, opts) {
  const m = makeMap(el, opts);
  maps.push(m);
  return m;
}

function setTab(name) {
  tabs.forEach(b => b.classList.toggle('active', b.dataset.tab === name));
}

tabs.forEach(b => b.addEventListener('click', () => go(b.dataset.tab)));

async function go(name, ...args) {
  const screens = { track: showTrack, routes: showRoutes, route: showRoute, run: showRun, optimize: showOptimize, settings: showSettings };
  setTab({ route: 'routes', run: 'routes', optimize: 'routes' }[name] || name);
  resetView();
  await screens[name](...args);
}

const settings = {
  async load() {
    return {
      home: await db.getSetting('home'),
      dumps: await db.getSetting('dumps', []),
      endMode: await db.getSetting('endMode', 'dump'),
      matchRadius: await db.getSetting('matchRadius', 25),
    };
  },
};

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

async function routeName(id) {
  return (await db.get('routes', id))?.name || 'Route';
}

// =================================================================== TRACK

async function showTrack() {
  if (tracker.run) return showActiveRun();
  const routes = (await db.all('routes')).sort((a, b) => a.name.localeCompare(b.name));
  const today = WEEKDAYS[new Date().getDay()];
  const select = h('select', ...routes.map(r => h('option', { value: r.id }, r.name)),
    h('option', { value: '__new' }, '+ New route…'));
  const guess = routes.find(r => r.name.toLowerCase().includes(today.toLowerCase()));
  if (guess) select.value = guess.id;
  else if (!routes.length) select.value = '__new';

  const planNote = h('p.muted.small');
  const updatePlanNote = async () => {
    const r = routes.find(x => x.id === select.value);
    planNote.textContent = r?.plan
      ? `✓ This route has a suggested order (${r.plan.sequence.filter(s => s.type === 'stop').length} stops). It will show you the next stop as you go.`
      : '';
  };
  select.addEventListener('change', updatePlanNote);
  updatePlanNote();

  const { home } = await settings.load();
  const runs = (await db.all('runs')).filter(r => r.endedAt).sort((a, b) => b.startedAt - a.startedAt).slice(0, 5);
  const routeById = new Map(routes.map(r => [r.id, r]));

  show(
    h('section.card',
      h('h2', 'Start a route day'),
      h('label', 'Which route is this?', select),
      planNote,
      h('button.btn.big', { onclick: () => beginRun(select.value, today) }, '▶ Start Route'),
      h('p.muted.small', 'Keep this app open on screen while driving — iPhone pauses location for web apps when the screen locks or you switch apps.'),
      !home ? h('p.warn.small', 'Tip: start the route while you’re at the house and it will offer to save it as Home.') : null,
    ),
    runs.length ? h('section.card',
      h('h3', 'Recent days'),
      ...runs.map(r => h('button.list-item', { onclick: () => go('run', r.id) },
        h('div', h('strong', routeById.get(r.routeId)?.name || 'Route'), h('div.muted.small', `${fmtDate(r.startedAt)} · ${r.events.filter(e => e.type === 'stop').length} stops`)),
        h('span.chev', '›')))) : null,
  );
}

async function beginRun(routeId, today) {
  if (routeId === '__new') {
    const name = await promptSheet('New route', 'Name it (you can rename later)', `${today} route`, 'Create');
    if (!name) return;
    const r = { id: db.uid(), name, createdAt: Date.now() };
    await db.put('routes', r);
    routeId = r.id;
  }
  tracker.startWatch();
  const { home } = await settings.load();
  if (!home) {
    const ok = await confirmSheet('Save home?', 'Are you at the house right now? If so, this spot will be saved as Home — where every route starts. (You can change it in Settings.)', 'Yes, save as Home');
    if (ok) {
      const fix = await waitForFix();
      if (fix) { await db.setSetting('home', { lat: fix.lat, lng: fix.lng }); toast('Home saved'); }
      else toast('No GPS fix yet — set Home later in Settings');
    }
  }
  await tracker.start(routeId);
  go('track');
}

function waitForFix(timeoutMs = 15000) {
  return new Promise(resolve => {
    const f = tracker.fix;
    if (f && Date.now() - f.t < 30000 && f.acc < 100) return resolve(f);
    const t = setTimeout(() => { off(); resolve(tracker.fix); }, timeoutMs);
    const off = tracker.on((type, fix) => {
      if (type === 'fix' && fix.acc < 100) { clearTimeout(t); off(); resolve(fix); }
    });
  });
}

async function showActiveRun() {
  const run = tracker.run;
  const route = await db.get('routes', run.routeId);
  const s = await settings.load();
  const routeStops = await db.byIndex('stops', 'routeId', run.routeId);
  const stopById = new Map(routeStops.map(x => [x.id, x]));
  const plan = route?.plan;

  const elTime = h('b', '0m'), elMiles = h('b', '0'), elStops = h('b', '0'), elGps = h('span.gps', 'GPS…');
  const elWake = h('span.small');
  const mapEl = h('div.map.run-map');
  const nextCard = h('div.next-card');
  const stopBtn = h('button.btn.stop-btn', { onclick: onStop }, 'STOP HERE');

  show(
    h('div.run-head',
      h('div', h('strong', route?.name || 'Route'), h('div.muted.small', `Started ${fmtTime(run.startedAt)}`)),
      h('div.stats', h('div', elTime, h('small', 'time')), h('div', elMiles, h('small', 'miles')), h('div', elStops, h('small', 'stops'))),
      h('div.row.small', elGps, elWake)),
    plan ? nextCard : null,
    mapEl,
    h('div.run-actions',
      stopBtn,
      h('div.row',
        h('button.btn.secondary', { onclick: onDump }, '🗑️ Dump'),
        h('button.btn.secondary', { onclick: onUndo }, '↶ Undo'),
        h('button.btn.secondary', { onclick: onEnd }, '■ End day'))),
  );

  const map = addMap(mapEl, { center: tracker.fix ? [tracker.fix.lat, tracker.fix.lng] : null, zoom: 16 });
  const trail = L.polyline(tracker.points.map(p => [p.lat, p.lng]), { color: '#e2337f', weight: 5, opacity: 0.85 }).addTo(map);
  const me = L.marker([0, 0], { icon: meIcon(), interactive: false });
  const eventLayer = L.layerGroup().addTo(map);
  const planLayer = L.layerGroup().addTo(map);
  if (s.home) L.marker([s.home.lat, s.home.lng], { icon: placeIcon('home') }).addTo(map);
  for (const d of s.dumps) L.marker([d.lat, d.lng], { icon: placeIcon('dump') }).bindPopup(d.name).addTo(map);
  let follow = true;
  map.on('dragstart', () => { follow = false; });
  const recenter = L.control({ position: 'topright' });
  recenter.onAdd = () => h('button.map-btn', { onclick: e => { e.stopPropagation(); follow = true; if (tracker.fix) map.setView([tracker.fix.lat, tracker.fix.lng], Math.max(map.getZoom(), 16)); } }, '◎');
  recenter.addTo(map);

  function drawEvents() {
    eventLayer.clearLayers();
    let n = 0;
    for (const e of run.events) {
      if (e.type === 'stop') {
        n++;
        const st = stopById.get(e.stopId);
        L.marker([e.lat, e.lng], { icon: numberIcon(n) }).bindPopup(st?.name || `Stop ${n}`).addTo(eventLayer);
      } else L.marker([e.lat, e.lng], { icon: placeIcon('dump') }).addTo(eventLayer);
    }
    elStops.textContent = String(n);
  }

  function nextPlanned() {
    if (!plan) return null;
    const visited = new Set(run.events.map(e => e.stopId).filter(Boolean));
    let idx = 0;
    for (const step of plan.sequence) {
      if (step.type === 'stop') {
        idx++;
        const st = stopById.get(step.stopId);
        if (st && !visited.has(st.id) && st.active !== false && st.lat != null && !skipped.has(st.id)) return { st, idx };
      }
    }
    return null;
  }
  const skipped = new Set();

  function drawPlan() {
    if (!plan) return;
    planLayer.clearLayers();
    const visited = new Set(run.events.map(e => e.stopId).filter(Boolean));
    let idx = 0;
    for (const step of plan.sequence) {
      if (step.type !== 'stop') continue;
      idx++;
      const st = stopById.get(step.stopId);
      if (!st || st.lat == null || visited.has(st.id)) continue;
      L.marker([st.lat, st.lng], { icon: numberIcon(idx, 'plan'), opacity: 0.9 }).bindPopup(st.name || `Planned #${idx}`).addTo(planLayer);
    }
    const nx = nextPlanned();
    const total = plan.sequence.filter(x => x.type === 'stop').length;
    nextCard.replaceChildren(nx
      ? h('div.row',
          h('div.grow', h('div.muted.small', `Next stop · ${nx.idx} of ${total}`), h('strong', nx.st.name || nx.st.address || 'Unnamed stop'),
            tracker.fix ? h('span.muted.small', ` · ${fmtMiles(haversine(tracker.fix, nx.st))} away`) : null),
          h('a.btn.small', { href: appleMapsUrl(nx.st), target: '_blank', rel: 'noopener' }, 'Navigate'),
          h('button.btn.small.secondary', { onclick: () => { skipped.add(nx.st.id); drawPlan(); } }, 'Skip'))
      : h('div', h('strong', '✓ All planned stops done'), h('div.muted.small', s.dumps.length ? 'Head to the dump and tap End day.' : 'Tap End day when finished.')));
  }

  function tick() {
    const stats = runStats(run, tracker.points);
    elTime.textContent = fmtDuration(stats.totalS).replace(/ \d+s$/, '');
    elMiles.textContent = (stats.distanceM / 1609.344).toFixed(1);
  }

  function onFix(fix) {
    me.setLatLng([fix.lat, fix.lng]);
    if (!map.hasLayer(me)) me.addTo(map);
    if (follow) map.setView([fix.lat, fix.lng], Math.max(map.getZoom(), 15), { animate: false });
    elGps.textContent = `GPS ±${Math.round(fix.acc)}m`;
    elGps.className = 'gps ' + (fix.acc <= 20 ? 'good' : fix.acc <= 60 ? 'ok' : 'bad');
  }

  function wakeText(ok) {
    elWake.textContent = ok ? '· Screen stays on ✓' : '· ⚠ Screen may sleep — set Auto-Lock to Never';
  }

  async function onStop() {
    stopBtn.disabled = true;
    try {
      const r = await tracker.logStop({ matchRadius: s.matchRadius });
      stopById.set(r.stop.id, r.stop);
      navigator.vibrate?.(40);
      drawEvents(); drawPlan();
      const n = run.events.filter(e => e.type === 'stop').length;
      const label = r.created ? `Stop ${n} logged` : `Stop ${n}: ${r.stop.name || 'saved stop'} ✓`;
      toast(r.acc > 40 ? `${label} (weak GPS ±${Math.round(r.acc)}m)` : label, [
        ['Add note', () => editStop(r.stop, { quick: true }).then(st => st && stopById.set(st.id, st))],
      ]);
    } catch (e) {
      toast(e.message);
    } finally {
      setTimeout(() => { stopBtn.disabled = false; }, 800);
    }
  }

  async function onDump() {
    try {
      const r = await tracker.logDump();
      s.dumps = await db.getSetting('dumps', []);
      drawEvents();
      toast(`Dump trip logged (${r.site.name})`);
    } catch (e) { toast(e.message); }
  }

  async function onUndo() {
    const ev = await tracker.undo();
    if (!ev) return toast('Nothing to undo');
    drawEvents(); drawPlan();
    toast(ev.type === 'dump' ? 'Removed dump trip' : 'Removed last stop');
  }

  async function onEnd() {
    const ok = await confirmSheet('End the day?', 'This stops tracking and saves the day so you can review it and optimize.', 'End day');
    if (!ok) return;
    const ended = await tracker.end();
    tracker.stopWatch();
    go('run', ended.id, { justEnded: true });
  }

  drawEvents(); drawPlan(); tick(); wakeText(tracker.wakeLockOk);
  if (tracker.fix) onFix(tracker.fix);
  if (tracker.error) toast(tracker.error, [], 10000);
  const timer = setInterval(tick, 5000);
  const off = tracker.on((type, data) => {
    if (type === 'fix') onFix(data);
    else if (type === 'point') trail.addLatLng([data.lat, data.lng]);
    else if (type === 'wakelock') wakeText(data);
    else if (type === 'error') toast(data, [], 10000);
    else if (type === 'gap') toast(`Tracking paused for ${fmtDuration((data.to - data.from) / 1000)} while the app was hidden.`, [], 6000);
  });
  cleanup.push(() => { clearInterval(timer); off(); });
}

// =================================================================== ROUTES

async function showRoutes() {
  const routes = (await db.all('routes')).sort((a, b) => a.name.localeCompare(b.name));
  const stops = await db.all('stops');
  const runs = await db.all('runs');
  const unassigned = stops.filter(s => s.routeId == null);

  show(h('section.card',
    h('div.row', h('h2.grow', 'Routes'), h('button.btn.small', {
      onclick: async () => {
        const name = await promptSheet('New route', 'Route name (e.g. Monday – Lufkin)', '', 'Create');
        if (name) { await db.put('routes', { id: db.uid(), name, createdAt: Date.now() }); go('routes'); }
      },
    }, '+ New')),
    routes.length ? null : h('p.muted', 'No routes yet. Start a route day on the Track tab and one will be created.'),
    ...routes.map(r => {
      const n = stops.filter(s => s.routeId === r.id).length;
      const days = runs.filter(x => x.routeId === r.id && x.endedAt).length;
      return h('button.list-item', { onclick: () => go('route', r.id) },
        h('div', h('strong', r.name), h('div.muted.small', `${n} stops · ${days} day${days === 1 ? '' : 's'} recorded${r.plan ? ' · has suggested order' : ''}`)),
        h('span.chev', '›'));
    })),
    unassigned.length ? h('section.card',
      h('h3', `Imported customers not on a route yet (${unassigned.length})`),
      h('p.muted.small', 'These get attached to a route automatically when you log a stop at their address (if the address was found on the map), or you can link them from a stop’s edit screen.'),
      ...unassigned.slice(0, 200).map(st => h('div.list-item.static',
        h('div', h('strong', st.name || '(no name)'), h('div.muted.small', `${st.address || ''}${st.lat == null ? ' · not on map yet' : ''}`))))) : null,
  );
}

async function showRoute(routeId) {
  const route = await db.get('routes', routeId);
  if (!route) return go('routes');
  const stops = await db.byIndex('stops', 'routeId', routeId);
  const runs = (await db.byIndex('runs', 'routeId', routeId)).filter(r => r.endedAt).sort((a, b) => b.startedAt - a.startedAt);
  const s = await settings.load();
  const mapEl = h('div.map');

  // Order stop list by the plan if there is one, else by first time visited.
  const order = new Map();
  if (route.plan) route.plan.sequence.filter(x => x.type === 'stop').forEach((x, i) => order.set(x.stopId, i));
  const sorted = [...stops].sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9) || a.createdAt - b.createdAt);

  show(
    h('button.back', { onclick: () => go('routes') }, '‹ Routes'),
    h('section.card',
      h('div.row', h('h2.grow', route.name),
        h('button.btn.small.secondary', {
          onclick: async () => {
            const name = await promptSheet('Rename route', 'Name', route.name);
            if (name) { route.name = name; await db.put('routes', route); go('route', routeId); }
          },
        }, 'Rename')),
      h('p.muted.small', `${stops.length} stops · ${runs.length} day${runs.length === 1 ? '' : 's'} recorded`),
      h('button.btn.big', { onclick: () => go('optimize', routeId), disabled: stops.length < 2 }, '⚡ Find the fastest route'),
      route.plan ? h('p.small', `Suggested order saved ${fmtDate(route.plan.createdAt)} — est. ${fmtDuration(route.plan.driveS)} driving.`) : null,
    ),
    mapEl,
    h('section.card',
      h('h3', 'Days recorded'),
      runs.length ? null : h('p.muted', 'None yet.'),
      ...runs.map(r => h('button.list-item', { onclick: () => go('run', r.id) },
        h('div', h('strong', fmtDate(r.startedAt)), h('div.muted.small',
          `${fmtTime(r.startedAt)}–${fmtTime(r.endedAt)} · ${r.events.filter(e => e.type === 'stop').length} stops · ${r.events.filter(e => e.type === 'dump').length} dump trips`)),
        h('span.chev', '›')))),
    h('section.card',
      h('h3', route.plan ? 'Stops (in suggested order)' : 'Stops'),
      ...sorted.map((st, i) => h('button.list-item', { onclick: async () => { if (await editStop(st)) go('route', routeId); } },
        h('div',
          h('strong', `${route.plan && order.has(st.id) ? `${order.get(st.id) + 1}. ` : ''}${st.name || st.address || `Stop (${st.lat?.toFixed(4)}, ${st.lng?.toFixed(4)})`}`),
          h('div.muted.small', [st.name && st.address ? st.address : '', st.note, st.active === false ? 'SKIPPED (inactive)' : '', st.lat == null ? 'not on map' : ''].filter(Boolean).join(' · '))),
        h('span.chev', '›')))),
    h('section.card',
      h('button.btn.danger.secondary', {
        onclick: async () => {
          if (!await confirmSheet('Delete route?', `Delete “${route.name}”, its ${runs.length} recorded days and ${stops.length} stops? This can’t be undone.`, 'Delete', true)) return;
          for (const r of runs) await db.deleteRun(r.id);
          for (const st of stops) await db.del('stops', st.id);
          await db.del('routes', routeId);
          go('routes');
        },
      }, 'Delete route')),
  );

  const map = addMap(mapEl);
  const pts = [];
  if (s.home) { L.marker([s.home.lat, s.home.lng], { icon: placeIcon('home') }).addTo(map); pts.push([s.home.lat, s.home.lng]); }
  for (const d of s.dumps) L.marker([d.lat, d.lng], { icon: placeIcon('dump') }).bindPopup(d.name).addTo(map);
  sorted.forEach((st, i) => {
    if (st.lat == null) return;
    const label = route.plan && order.has(st.id) ? order.get(st.id) + 1 : '•';
    L.marker([st.lat, st.lng], { icon: numberIcon(label, route.plan ? 'plan' : 'stop') }).bindPopup(st.name || st.address || 'Stop').addTo(map);
    pts.push([st.lat, st.lng]);
  });
  fitTo(map, pts);
}

/** Edit a stop. Resolves the updated stop, or null if nothing changed / deleted. */
function editStop(stop, { quick = false } = {}) {
  return new Promise(resolve => {
    let result = null;
    const name = h('input', { type: 'text', value: stop.name || '', placeholder: 'Customer name' });
    const address = h('input', { type: 'text', value: stop.address || '', placeholder: 'Address' });
    const note = h('textarea', { rows: 2, placeholder: 'e.g. cans behind gate, dog, extra bags', value: stop.note || '' });
    const active = h('input', { type: 'checkbox', checked: stop.active !== false });
    const save = async () => {
      Object.assign(stop, { name: name.value.trim(), address: address.value.trim(), note: note.value.trim(), active: active.checked });
      await db.put('stops', stop);
      result = stop; sh.close();
    };
    const linkCustomer = async () => {
      const pool = (await db.all('stops')).filter(x => x.source === 'import' && x.id !== stop.id && (x.routeId == null || x.lat == null));
      if (!pool.length) return toast('No imported customers to link. Import a customer list in Settings.');
      const search = h('input', { type: 'search', placeholder: 'Search name or address' });
      const list = h('div');
      const render = () => {
        const q = search.value.toLowerCase();
        list.replaceChildren(...pool
          .filter(x => `${x.name} ${x.address}`.toLowerCase().includes(q))
          .slice(0, 50)
          .map(x => h('button.list-item', {
            onclick: async () => {
              name.value = x.name || name.value; address.value = x.address || address.value;
              if (x.note) note.value = [note.value, x.note].filter(Boolean).join(' · ');
              await db.del('stops', x.id);
              pick.close();
              toast(`Linked to ${x.name || x.address}`);
            },
          }, h('div', h('strong', x.name || '(no name)'), h('div.muted.small', x.address)))));
      };
      search.addEventListener('input', render);
      const pick = sheet('Which customer is this?', [search, list]);
      render();
    };
    const sh = sheet(quick ? 'Stop details' : 'Edit stop', [
      h('label', 'Name', name),
      h('label', 'Address', address),
      h('label', 'Notes', note),
      quick ? null : h('label.check', active, ' Active (uncheck if they cancelled — skipped by the optimizer)'),
      h('div.row',
        h('button.btn.secondary.small', { onclick: linkCustomer }, 'Link imported customer'),
        quick || stop.lat == null ? null : h('a.btn.secondary.small', { href: appleMapsUrl(stop), target: '_blank', rel: 'noopener' }, 'Directions'),
        quick ? null : h('button.btn.secondary.small', {
          onclick: async () => {
            const p = await pickLocation('Move stop', { start: stop.lat != null ? stop : null, fix: () => tracker.fix });
            if (p) { stop.lat = p.lat; stop.lng = p.lng; toast('Location updated — tap Save'); }
          },
        }, 'Move pin')),
      h('div.row',
        quick ? null : h('button.btn.danger.secondary', {
          onclick: async () => {
            if (!await confirmSheet('Delete stop?', 'Remove this stop from the route? Past days keep their trail but lose this stop.', 'Delete', true)) return;
            await db.del('stops', stop.id); result = stop; sh.close();
          },
        }, 'Delete'),
        h('button.btn', { onclick: save }, 'Save')),
    ], { onClose: () => resolve(result) });
  });
}

// =================================================================== RUN DETAIL

async function showRun(runId, { justEnded = false } = {}) {
  const run = await db.get('runs', runId);
  if (!run) return go('routes');
  const route = await db.get('routes', run.routeId);
  const points = (await db.byIndex('points', 'runId', runId)).sort((a, b) => a.t - b.t);
  const stops = new Map((await db.byIndex('stops', 'routeId', run.routeId)).map(s => [s.id, s]));
  const stats = runStats(run, points);
  const service = serviceTimes(run.events, points);
  const mapEl = h('div.map');
  const gapS = (run.gaps || []).reduce((a, g) => a + (g.to - g.from) / 1000, 0);

  let n = 0;
  show(
    h('button.back', { onclick: () => go('route', run.routeId) }, `‹ ${route?.name || 'Route'}`),
    justEnded ? h('section.card.highlight', h('strong', 'Day saved! '), 'Record a few days of this route, then tap “Find the fastest route”.') : null,
    h('section.card',
      h('h2', `${route?.name || 'Route'} — ${fmtDate(run.startedAt)}`),
      h('div.grid',
        stat('Total time', fmtDuration(stats.totalS)),
        stat('Miles', fmtMiles(stats.distanceM)),
        stat('Stops', stats.stops),
        stat('Dump trips', stats.dumps),
        stat('At stops', fmtDuration(stats.serviceS)),
        stat('Avg per stop', fmtDuration(stats.avgServiceS))),
      gapS > 60 ? h('p.warn.small', `GPS was paused for ${fmtDuration(gapS)} (app was in the background). Miles may be a little low.`) : null,
      h('div.row',
        h('button.btn', { onclick: () => go('optimize', run.routeId, run.id) }, '⚡ Optimize this day'),
        h('button.btn.secondary', { onclick: () => download(`route-${fmtDate(run.startedAt).replace(/\W+/g, '-')}.gpx`, toGpx(run, points, stops), 'application/gpx+xml') }, 'Export GPX'))),
    mapEl,
    h('section.card',
      h('h3', 'Timeline'),
      h('div.list-item.static', h('div', h('strong', `${fmtTime(run.startedAt)} Start`))),
      ...run.events.map(e => {
        if (e.type === 'dump') return h('div.list-item.static', h('div', h('strong', `${fmtTime(e.t)} 🗑️ Dump trip`)));
        n++;
        const st = stops.get(e.stopId);
        const sv = service.get(e);
        return h('button.list-item', { onclick: async () => { if (st && await editStop(st)) go('run', runId); } },
          h('div', h('strong', `${fmtTime(e.t)} #${n} ${st?.name || st?.address || ''}`),
            h('div.muted.small', [sv != null ? `stopped ${fmtDuration(sv)}` : '', st?.note].filter(Boolean).join(' · '))),
          h('span.chev', '›'));
      }),
      h('div.list-item.static', h('div', h('strong', `${fmtTime(run.endedAt)} End`)))),
    h('section.card',
      h('button.btn.danger.secondary', {
        onclick: async () => {
          if (!await confirmSheet('Delete this day?', 'Removes the GPS trail and stop log for this day. Saved stops stay on the route.', 'Delete', true)) return;
          await db.deleteRun(runId);
          go('route', run.routeId);
        },
      }, 'Delete this day')),
  );

  const map = addMap(mapEl);
  const line = points.map(p => [p.lat, p.lng]);
  if (line.length) L.polyline(line, { color: '#e2337f', weight: 4 }).addTo(map);
  n = 0;
  for (const e of run.events) {
    if (e.type === 'stop') L.marker([e.lat, e.lng], { icon: numberIcon(++n) }).bindPopup(stops.get(e.stopId)?.name || `Stop ${n}`).addTo(map);
    else L.marker([e.lat, e.lng], { icon: placeIcon('dump') }).addTo(map);
  }
  fitTo(map, [...line, ...run.events.map(e => [e.lat, e.lng])]);
}

function stat(label, value) {
  return h('div.stat', h('b', String(value)), h('small', label));
}

function toGpx(run, points, stops) {
  const x = s => String(s ?? '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  let n = 0;
  const wpts = run.events.map(e => e.type === 'stop'
    ? `<wpt lat="${e.lat}" lon="${e.lng}"><time>${new Date(e.t).toISOString()}</time><name>${x(`#${++n} ${stops.get(e.stopId)?.name || ''}`)}</name></wpt>`
    : `<wpt lat="${e.lat}" lon="${e.lng}"><time>${new Date(e.t).toISOString()}</time><name>Dump</name></wpt>`).join('\n');
  const trk = points.map(p => `<trkpt lat="${p.lat}" lon="${p.lng}"><time>${new Date(p.t).toISOString()}</time></trkpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Pinky's Route Tracker" xmlns="http://www.topografix.com/GPX/1/1">
${wpts}
<trk><name>Route ${new Date(run.startedAt).toISOString().slice(0, 10)}</name><trkseg>
${trk}
</trkseg></trk>
</gpx>`;
}

// =================================================================== OPTIMIZE

async function showOptimize(routeId, runId) {
  const route = await db.get('routes', routeId);
  const routeStops = await db.byIndex('stops', 'routeId', routeId);
  const runs = (await db.byIndex('runs', 'routeId', routeId)).filter(r => r.endedAt).sort((a, b) => b.startedAt - a.startedAt);
  const s = await settings.load();

  const runSel = h('select',
    ...runs.map(r => h('option', { value: r.id }, `${fmtDate(r.startedAt)} (${r.events.filter(e => e.type === 'stop').length} stops)`)),
    h('option', { value: '' }, 'None — just use all saved stops'));
  runSel.value = runId || runs[0]?.id || '';
  const includeAll = h('input', { type: 'checkbox', checked: !runs.length });
  const endSel = h('select',
    h('option', { value: 'dump' }, 'At the dump'),
    h('option', { value: 'home' }, 'Back home'),
    h('option', { value: 'open' }, 'At the last stop'));
  endSel.value = s.endMode;
  const cap = h('input', { type: 'number', min: 1, inputMode: 'numeric', placeholder: 'No limit' });
  const capHint = h('div.muted.small');
  const syncCap = () => {
    const run = runs.find(r => r.id === runSel.value);
    const c = capacityFromRun(run);
    cap.value = c ?? '';
    capHint.textContent = c
      ? `That day had dump trips mid-route; the biggest load was ${c} stops, so loads are capped at ${c}.`
      : 'Leave blank if the truck holds the whole route.';
  };
  runSel.addEventListener('change', syncCap);
  syncCap();

  const out = h('div');
  const goBtn = h('button.btn.big', { onclick: run }, '⚡ Find the fastest route');

  show(
    h('button.back', { onclick: () => go('route', routeId) }, `‹ ${route.name}`),
    h('section.card',
      h('h2', 'Find the fastest route'),
      !s.home ? h('p.warn.small', 'Home isn’t set, so the route will start where that day’s recording started. Set Home in Settings for best results.') : null,
      h('label', 'Compare against this day', runSel),
      h('label.check', includeAll, ` Use all ${routeStops.filter(x => x.lat != null && x.active !== false).length} active saved stops (not just that day’s)`),
      h('label', 'Day ends', endSel),
      endSel.value === 'dump' && !s.dumps.length ? h('p.warn.small', 'No dump site saved yet — tap 🗑️ Dump at the dump during a route, or add one in Settings.') : null,
      h('label', 'Max stops per truckload', cap),
      capHint,
      goBtn),
    out,
  );

  async function run() {
    goBtn.disabled = true;
    const progress = h('p.muted', 'Starting…');
    out.replaceChildren(h('section.card', progress));
    try {
      await db.setSetting('endMode', endSel.value);
      const baseline = runs.find(r => r.id === runSel.value) || null;
      const res = await optimizeRoute({
        run: baseline, routeStops, includeAll: includeAll.checked || !baseline,
        home: s.home, dumps: s.dumps, endMode: endSel.value,
        capacity: parseInt(cap.value, 10) || null,
        onProgress: msg => { progress.textContent = msg; },
      });
      await showResult(res, baseline);
    } catch (e) {
      console.error(e);
      out.replaceChildren(h('section.card', h('p.warn', e.message)));
    } finally {
      goBtn.disabled = false;
    }
  }

  async function showResult(res, baseline) {
    const { suggested, yours } = res;
    const stopById = new Map(routeStops.map(x => [x.id, x]));
    const dumpById = new Map(s.dumps.map(d => [d.id, d]));
    const loggedAs = new Map();
    baseline?.events.filter(e => e.type === 'stop').forEach((e, i) => { if (!loggedAs.has(e.stopId)) loggedAs.set(e.stopId, i + 1); });
    const label = st => st?.name || st?.address || (loggedAs.has(st?.id) ? `House you logged #${loggedAs.get(st.id)}` : 'Unnamed stop');
    const recorded = baseline ? runStats(baseline, (await db.byIndex('points', 'runId', baseline.id)).sort((a, b) => a.t - b.t)) : null;
    const avgService = recorded?.avgServiceS ?? 30;
    const serviceS = avgService * res.stops.length;

    let verdict;
    if (yours) {
      const save = yours.driveS - suggested.driveS;
      verdict = suggested.alreadyOptimal || save < Math.max(180, yours.driveS * 0.02)
        ? h('div.verdict.good', h('b', 'Your route is already about as fast as it gets. 👍'),
          h('div.small', save > 0 ? `The best order found would only save ~${fmtDuration(save)}.` : 'No faster order was found.'))
        : h('div.verdict.save', h('b', `Could save about ${fmtDuration(save)} of driving`),
          h('div.small', `and ${fmtMiles(yours.distM - suggested.distM)} per day (${Math.round((save / yours.driveS) * 100)}% less drive time).`));
    } else {
      verdict = h('div.verdict', h('b', `Suggested order: ~${fmtDuration(suggested.driveS + serviceS)} total`));
    }

    const mapEl = h('div.map');
    const list = h('ol.plan-list');
    let idx = 0;
    for (const step of suggested.sequence) {
      if (step.type === 'dump') {
        list.append(h('li.dump', `🗑️ Dump trip — ${dumpById.get(step.dumpId)?.name || 'dump'}`));
        continue;
      }
      const st = stopById.get(step.stopId);
      idx++;
      list.append(h('li', h('span.num', idx), h('span.grow', label(st)),
        st ? h('a.small', { href: appleMapsUrl(st), target: '_blank', rel: 'noopener' }, 'Directions') : null));
    }
    const endLabel = { dump: 'Dump', home: 'Home', open: '' }[endSel.value];
    if (endLabel && suggested.end != null) list.append(h('li.dump', `🏁 End: ${endLabel}`));

    out.replaceChildren(
      h('section.card',
        verdict,
        h('table.compare',
          h('tr', h('th', ''), h('th', 'Drive time'), h('th', 'Miles'), h('th', 'Dump trips')),
          recorded ? h('tr', h('td', 'Recorded that day*'), h('td', fmtDuration(recorded.driveS)), h('td', fmtMiles(recorded.distanceM)), h('td', recorded.dumps)) : null,
          yours ? h('tr', h('td', 'Your order'), h('td', fmtDuration(yours.driveS)), h('td', fmtMiles(yours.distM)), h('td', yours.dumps)) : null,
          h('tr.best', h('td', 'Suggested'), h('td', fmtDuration(suggested.driveS)), h('td', fmtMiles(suggested.distM)), h('td', suggested.dumps))),
        h('p.muted.small',
          `Plus ~${fmtDuration(serviceS)} stopped at ${res.stops.length} houses (${fmtDuration(avgService)} each). `,
          recorded ? '*Recorded time includes traffic, breaks and waiting, so it’s usually higher than the estimates. “Your order” and “Suggested” are timed the same way, so compare those two. ' : '',
          res.estimated ? '⚠ Some drive times couldn’t be fetched (no signal?) and were estimated from straight-line distance — try again with a connection.' : ''),
        h('button.btn', {
          onclick: async () => {
            route.plan = { createdAt: Date.now(), sequence: suggested.sequence, driveS: suggested.driveS, endMode: endSel.value };
            await db.put('routes', route);
            toast('Saved! Next time you start this route it will guide you stop by stop.');
          },
        }, '✓ Use this order next time')),
      mapEl,
      h('section.card', h('h3', 'Suggested order'), list),
    );

    const map = addMap(mapEl);
    const coords = suggested.nodes.map(i => res.nodes[i]);
    const seq = [res.start, ...coords];
    if (suggested.end != null) seq.push(res.nodes[suggested.end]);
    if (s.home) L.marker([s.home.lat, s.home.lng], { icon: placeIcon('home') }).addTo(map);
    for (const d of s.dumps) L.marker([d.lat, d.lng], { icon: placeIcon('dump') }).bindPopup(d.name).addTo(map);
    idx = 0;
    for (const step of suggested.sequence) {
      if (step.type !== 'stop') continue;
      const st = stopById.get(step.stopId);
      idx++;
      if (st) L.marker([st.lat, st.lng], { icon: numberIcon(idx, 'plan') }).bindPopup(label(st)).addTo(map);
    }
    fitTo(map, seq.map(p => [p.lat, p.lng]));
    const straight = L.polyline(seq.map(p => [p.lat, p.lng]), { color: '#7a3cff', weight: 3, dashArray: '6 6' }).addTo(map);
    routeLine(seq).then(line => {
      if (!maps.includes(map)) return;
      straight.remove();
      L.polyline(line, { color: '#7a3cff', weight: 4, opacity: 0.8 }).addTo(map);
    });
  }
}

// =================================================================== SETTINGS

async function showSettings() {
  const s = await settings.load();
  const radius = h('input', { type: 'number', min: 5, max: 200, value: s.matchRadius, inputMode: 'numeric' });
  radius.addEventListener('change', async () => { await db.setSetting('matchRadius', Math.max(5, +radius.value || 25)); toast('Saved'); });
  const fileIn = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
  const csvIn = h('input', { type: 'file', accept: '.csv,text/csv', style: { display: 'none' } });

  const place = (p) => p ? `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}` : 'Not set';

  show(
    h('section.card',
      h('h2', 'Places'),
      h('div.list-item.static',
        h('div.grow', h('strong', '🏠 Home (route start)'), h('div.muted.small', place(s.home))),
        h('button.btn.small.secondary', {
          onclick: async () => {
            tracker.startWatch();
            const p = await pickLocation('Set home', { start: s.home || tracker.fix, fix: () => tracker.fix || s.home });
            if (p) { await db.setSetting('home', p); go('settings'); }
          },
        }, s.home ? 'Change' : 'Set')),
      ...s.dumps.map(d => h('div.list-item.static',
        h('div.grow', h('strong', `🗑️ ${d.name}`), h('div.muted.small', place(d))),
        h('button.btn.small.secondary', {
          onclick: async () => {
            const name = await promptSheet('Rename dump site', 'Name', d.name);
            if (name) { d.name = name; await db.setSetting('dumps', s.dumps); go('settings'); }
          },
        }, 'Rename'),
        h('button.btn.small.danger.secondary', {
          onclick: async () => {
            if (!await confirmSheet('Remove dump site?', d.name, 'Remove', true)) return;
            await db.setSetting('dumps', s.dumps.filter(x => x.id !== d.id)); go('settings');
          },
        }, '✕'))),
      h('button.btn.secondary', {
        onclick: async () => {
          tracker.startWatch();
          const p = await pickLocation('Add dump / landfill', { start: tracker.fix || s.home, fix: () => tracker.fix });
          if (!p) return;
          const name = await promptSheet('Dump site name', 'Name', `Dump site ${s.dumps.length + 1}`);
          s.dumps.push({ id: db.uid(), name: name || `Dump site ${s.dumps.length + 1}`, ...p });
          await db.setSetting('dumps', s.dumps); go('settings');
        },
      }, '+ Add dump site'),
      h('p.muted.small', 'Dump sites are also saved automatically when you tap 🗑️ Dump during a route.')),
    h('section.card',
      h('h2', 'Customer list'),
      h('p.small', 'Import a CSV exported from a spreadsheet (File → Download → CSV). Columns like Name, Address, City, Zip and Route/Day are detected automatically. Addresses are looked up on the map; any that can’t be found exactly get placed the first time you log a stop and link them.'),
      csvIn,
      h('button.btn.secondary', { onclick: () => csvIn.click() }, 'Import customers (CSV)')),
    h('section.card',
      h('h2', 'Tracking'),
      h('label', 'Stop matching distance (meters)', radius),
      h('p.muted.small', 'When you tap STOP HERE within this distance of a saved stop, it counts as a visit to that stop instead of creating a new one. Raise it if houses are far apart and GPS is jumpy; lower it if houses are close together.')),
    h('section.card',
      h('h2', 'Backup'),
      h('p.small', 'Everything is stored only on this phone. Export a backup now and then (save to Files / iCloud Drive) so nothing is lost if Safari data is cleared.'),
      h('div.row',
        h('button.btn.secondary', { onclick: async () => download(`route-tracker-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(await db.exportAll())) }, 'Export backup'),
        h('button.btn.secondary', { onclick: () => fileIn.click() }, 'Restore backup')),
      fileIn),
    h('section.card',
      h('h2', 'Install on iPhone'),
      h('ol.small',
        h('li', 'Open this page in Safari.'),
        h('li', 'Tap the Share button → “Add to Home Screen”.'),
        h('li', 'Open it from the home-screen icon and allow location when asked.'),
        h('li', 'On route days keep the app open on screen (a dash mount helps). If the screen still dims, set Settings → Display & Brightness → Auto-Lock → Never for the day.'))),
    h('section.card',
      h('button.btn.danger.secondary', {
        onclick: async () => {
          if (!await confirmSheet('Erase everything?', 'Deletes all routes, stops, recorded days and settings from this phone. Export a backup first!', 'Erase all', true)) return;
          await db.wipeAll(); go('settings');
        },
      }, 'Erase all data')),
    h('p.muted.small.center', 'Maps © OpenStreetMap contributors · Drive times by OSRM'),
  );

  fileIn.addEventListener('change', async () => {
    const f = fileIn.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const replace = await confirmSheet('Restore backup', 'Replace everything on this phone with the backup? (Cancel = merge it in instead.)', 'Replace');
      await db.importAll(data, { replace });
      toast('Backup restored'); go('settings');
    } catch (e) { toast(`Couldn’t restore: ${e.message}`); }
  });

  csvIn.addEventListener('change', async () => {
    const f = csvIn.files[0];
    if (!f) return;
    try {
      const { customers, columns } = rowsToCustomers(parseCsv(await f.text()));
      if (!customers.length) return toast('No customers found in that file.');
      const found = Object.keys(columns).join(', ') || 'none';
      const needLookup = customers.filter(c => c.lat == null && c.address).length;
      const ok = await confirmSheet('Import customers',
        `Found ${customers.length} customers (columns: ${found}). ${needLookup ? `${needLookup} addresses will be looked up on the map — about ${Math.ceil(needLookup * 1.2 / 60)} min; keep the app open.` : ''}`, 'Import');
      if (!ok) return;
      const prog = h('p', 'Importing…');
      const ctrl = new AbortController();
      const sh = sheet('Importing customers', [prog, h('button.btn.secondary', { onclick: () => ctrl.abort() }, 'Stop')]);
      const stats = await importCustomers(customers, { signal: ctrl.signal, onProgress: (d, t) => { prog.textContent = `Imported ${d} of ${t}…`; } });
      sh.close();
      toast(`Imported ${stats.added} customers — ${stats.placed} on the map, ${stats.unplaced} to place later${stats.routesCreated ? `, ${stats.routesCreated} routes created` : ''}.`, [], 8000);
      go('routes');
    } catch (e) { toast(`Import failed: ${e.message}`); }
  });
}

// =================================================================== BOOT

(async function boot() {
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW', e));
  }
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  const resumed = await tracker.resume();
  if (resumed) toast('Picked up your route where it left off.');
  go('track');
})();

// Exposed for debugging in the console.
window.__app = { db, tracker, go, haversine };
