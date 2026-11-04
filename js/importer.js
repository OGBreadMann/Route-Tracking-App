// Customer list import (CSV from a spreadsheet). Column names are detected
// loosely so most exports work: name, address, city, state, zip, lat, lng, route/day.

import * as db from './db.js';
import { geocode } from './ui.js';
import { nearest } from './geo.js';

export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f.trim())) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(f => f.trim())) rows.push(row);
  return rows;
}

const COLS = {
  name: /^(name|customer|customer name|client|full name)$/i,
  first: /^first( name)?$/i,
  last: /^last( name)?$/i,
  address: /(address|street)/i,
  city: /^(city|town)$/i,
  state: /^(state|st)$/i,
  zip: /^(zip|zip code|zipcode|postal( code)?)$/i,
  lat: /^(lat|latitude)$/i,
  lng: /^(lng|lon|long|longitude)$/i,
  route: /^(route|day|pickup day|service day|route day)$/i,
  note: /^(note|notes|comments?)$/i,
};

export function mapColumns(header) {
  const map = {};
  header.forEach((hname, i) => {
    const name = hname.trim();
    for (const [key, re] of Object.entries(COLS)) {
      if (map[key] == null && re.test(name)) { map[key] = i; break; }
    }
  });
  return map;
}

export function rowsToCustomers(rows) {
  const [header, ...body] = rows;
  const col = mapColumns(header);
  const get = (r, k) => (col[k] != null ? (r[col[k]] || '').trim() : '');
  return {
    columns: col,
    customers: body.map(r => {
      const name = get(r, 'name') || [get(r, 'first'), get(r, 'last')].filter(Boolean).join(' ');
      const street = get(r, 'address');
      const full = [street, get(r, 'city'), [get(r, 'state') || 'TX', get(r, 'zip')].filter(Boolean).join(' ')]
        .filter(Boolean).join(', ');
      const lat = parseFloat(get(r, 'lat')), lng = parseFloat(get(r, 'lng'));
      return {
        name, street, address: street ? full : '', route: get(r, 'route'), note: get(r, 'note'),
        lat: isFinite(lat) ? lat : null, lng: isFinite(lng) ? lng : null,
      };
    }).filter(c => c.name || c.address || c.lat != null),
  };
}

/**
 * Save customers as stops. Rows with a route/day column are put on a route of
 * that name (created if needed). Addresses without coordinates are looked up;
 * only house-level matches are trusted, the rest are left "unplaced" and get a
 * location the first time you log a stop and link it.
 */
export async function importCustomers(customers, { onProgress = () => {}, signal } = {}) {
  const routes = await db.all('routes');
  const byName = new Map(routes.map(r => [r.name.toLowerCase(), r]));
  const stats = { added: 0, placed: 0, unplaced: 0, routesCreated: 0 };
  for (let i = 0; i < customers.length; i++) {
    if (signal?.aborted) break;
    const c = customers[i];
    let routeId = null;
    if (c.route) {
      let r = byName.get(c.route.toLowerCase());
      if (!r) {
        r = { id: db.uid(), name: c.route, createdAt: Date.now() };
        await db.put('routes', r);
        byName.set(c.route.toLowerCase(), r);
        stats.routesCreated++;
      }
      routeId = r.id;
    }
    let { lat, lng } = c;
    if (lat == null && c.address) {
      try {
        await new Promise(r => setTimeout(r, 1100)); // Nominatim allows 1 request / second
        const hits = await geocode(c.address);
        const hit = hits.find(x => x.address?.house_number);
        if (hit) { lat = +hit.lat; lng = +hit.lon; }
      } catch (e) { console.warn('geocode', e); }
    }
    await db.put('stops', {
      id: db.uid(), routeId, lat, lng, name: c.name, address: c.address, note: c.note,
      active: true, source: 'import', createdAt: Date.now(),
    });
    stats.added++;
    if (lat != null) stats.placed++; else stats.unplaced++;
    onProgress(i + 1, customers.length);
  }
  return stats;
}

// ---------------------------------------------------------------- GPX restore

/** Read a GPX file (ours, or any app's): waypoints become stops/dumps, the track becomes the trail. */
export function parseGpx(text) {
  const attr = (s, k) => parseFloat((s.match(new RegExp(`\\b${k}="([^"]+)"`)) || [])[1]);
  const tag = (s, k) => (s.match(new RegExp(`<${k}>([\\s\\S]*?)</${k}>`)) || [])[1];
  const unxml = s => (s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const wpts = [...text.matchAll(/<wpt\b([^>]*)>([\s\S]*?)<\/wpt>/g)].map(m => ({
    lat: attr(m[1], 'lat'), lng: attr(m[1], 'lon'), t: Date.parse(tag(m[2], 'time')), name: unxml(tag(m[2], 'name')).trim(),
  })).filter(w => isFinite(w.lat) && isFinite(w.lng) && isFinite(w.t)).sort((a, b) => a.t - b.t);
  const points = [...text.matchAll(/<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/g)].map(m => ({
    lat: attr(m[1], 'lat'), lng: attr(m[1], 'lon'), t: Date.parse(tag(m[2], 'time')),
  })).filter(p => isFinite(p.lat) && isFinite(p.lng) && isFinite(p.t)).sort((a, b) => a.t - b.t);
  return { wpts, points };
}

/**
 * Save a parsed GPX as a recorded day on the named route (created if needed).
 * Waypoints at saved stops of that route reuse those stops.
 */
export async function importGpxDay({ wpts, points }, routeName, { matchRadius = 25 } = {}) {
  if (!wpts.length && !points.length) throw new Error('No stops or GPS trail found in that file.');
  const routes = await db.all('routes');
  let route = routes.find(r => r.name.trim().toLowerCase() === routeName.trim().toLowerCase());
  if (!route) { route = { id: db.uid(), name: routeName.trim(), createdAt: Date.now() }; await db.put('routes', route); }

  const times = [...wpts, ...points].map(x => x.t);
  const startedAt = Math.min(...times), endedAt = Math.max(...times);
  const existing = await db.byIndex('runs', 'routeId', route.id);
  const dup = existing.find(r => r.startedAt === startedAt);
  if (dup) return { runId: dup.id, duplicate: true };

  const routeStops = await db.byIndex('stops', 'routeId', route.id);
  const dumps = await db.getSetting('dumps', []);
  const runId = db.uid();
  const events = [], used = new Set(), newStops = [];
  for (const w of wpts) {
    if (/^dump\b/i.test(w.name)) {
      let site = nearest(w, dumps, 400)?.item;
      if (!site) { site = { id: db.uid(), name: `Dump site ${dumps.length + 1}`, lat: w.lat, lng: w.lng }; dumps.push(site); }
      events.push({ type: 'dump', dumpId: site.id, lat: w.lat, lng: w.lng, t: w.t });
      continue;
    }
    const name = w.name.replace(/^#\d+\s*/, '');
    let stop = nearest(w, routeStops.filter(s => !used.has(s.id) && s.active !== false), matchRadius)?.item;
    if (!stop) {
      stop = { id: db.uid(), routeId: route.id, lat: w.lat, lng: w.lng, name, address: '', note: '', active: true, source: 'gpx', createdAt: w.t };
      routeStops.push(stop); newStops.push(stop);
    }
    used.add(stop.id);
    events.push({ type: 'stop', stopId: stop.id, lat: w.lat, lng: w.lng, t: w.t });
  }
  await db.putMany('stops', newStops);
  await db.setSetting('dumps', dumps);
  await db.putMany('points', points.map(p => ({ runId, lat: p.lat, lng: p.lng, t: p.t, acc: null })));
  await db.put('runs', { id: runId, routeId: route.id, startedAt, endedAt, events, gaps: [], pauses: [], imported: true });
  return { runId, duplicate: false, stops: events.filter(e => e.type === 'stop').length, newStops: newStops.length };
}
