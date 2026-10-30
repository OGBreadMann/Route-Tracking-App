// Tiny IndexedDB wrapper. All data lives on the phone; nothing is uploaded.
//
// Stores:
//   settings  key -> value          (home, dump sites, active run id, ...)
//   routes    {id, name, createdAt, plan?}
//   stops     {id, routeId|null, lat, lng, name, address, note, active, source}
//   runs      {id, routeId, startedAt, endedAt, events:[...], stats?}
//   points    {id(auto), runId, lat, lng, t, acc, spd}
//   legs      key "lat,lng>lat,lng" -> {dur, dist}   (cached drive times)

const DB_NAME = 'route-tracker';
const DB_VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('settings');
      db.createObjectStore('routes', { keyPath: 'id' });
      db.createObjectStore('stops', { keyPath: 'id' }).createIndex('routeId', 'routeId');
      db.createObjectStore('runs', { keyPath: 'id' }).createIndex('routeId', 'routeId');
      db.createObjectStore('points', { keyPath: 'id', autoIncrement: true }).createIndex('runId', 'runId');
      db.createObjectStore('legs');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(store, mode, fn) {
  const db = await open();
  const t = db.transaction(store, mode);
  const result = fn(t.objectStore(store));
  await new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
  return result instanceof IDBRequest ? result.result : result;
}

export const get = (store, key) => tx(store, 'readonly', s => s.get(key));
export const put = (store, value, key) => tx(store, 'readwrite', s => s.put(value, key));
export const del = (store, key) => tx(store, 'readwrite', s => s.delete(key));
export const all = (store) => tx(store, 'readonly', s => s.getAll());
export const byIndex = (store, index, value) => tx(store, 'readonly', s => s.index(index).getAll(value));

export async function putMany(store, values) {
  return tx(store, 'readwrite', s => { for (const v of values) s.put(v); });
}

export async function getSetting(key, fallback = null) {
  const v = await get('settings', key);
  return v === undefined ? fallback : v;
}
export const setSetting = (key, value) => put('settings', value, key);

export async function getLegs(keys) {
  const db = await open();
  const s = db.transaction('legs', 'readonly').objectStore('legs');
  const out = new Map();
  await Promise.all(keys.map(k => wrap(s.get(k)).then(v => { if (v) out.set(k, v); })));
  return out;
}

export async function putLegs(entries) {
  return tx('legs', 'readwrite', s => { for (const [k, v] of entries) s.put(v, k); });
}

export async function deleteRun(runId) {
  const db = await open();
  const t = db.transaction(['runs', 'points'], 'readwrite');
  t.objectStore('runs').delete(runId);
  const idx = t.objectStore('points').index('runId');
  const keys = await wrap(idx.getAllKeys(runId));
  for (const k of keys) t.objectStore('points').delete(k);
  await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
}

export async function exportAll() {
  const out = { app: 'route-tracker', version: 1, exportedAt: new Date().toISOString() };
  for (const s of ['routes', 'stops', 'runs', 'points']) out[s] = await all(s);
  const db = await open();
  const t = db.transaction('settings', 'readonly').objectStore('settings');
  const [keys, vals] = await Promise.all([wrap(t.getAllKeys()), wrap(t.getAll())]);
  out.settings = Object.fromEntries(keys.map((k, i) => [k, vals[i]]));
  delete out.settings.activeRunId;
  return out;
}

export async function importAll(data, { replace = false } = {}) {
  if (data?.app !== 'route-tracker') throw new Error('Not a Route Tracker backup file');
  const db = await open();
  const stores = ['routes', 'stops', 'runs', 'points', 'settings'];
  const t = db.transaction(stores, 'readwrite');
  if (replace) for (const s of stores) t.objectStore(s).clear();
  for (const s of ['routes', 'stops', 'runs', 'points']) for (const v of data[s] || []) t.objectStore(s).put(v);
  for (const [k, v] of Object.entries(data.settings || {})) t.objectStore('settings').put(v, k);
  await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
}

export async function wipeAll() {
  const db = await open();
  const stores = ['routes', 'stops', 'runs', 'points', 'settings', 'legs'];
  const t = db.transaction(stores, 'readwrite');
  for (const s of stores) t.objectStore(s).clear();
  await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
