// Small DOM + map helpers shared by the views.
/* global L */

/** h('div.card', {onclick}, child, 'text', ...) */
export function h(tag, attrs, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs); attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
export function toast(msg, actions = [], ms = 4000) {
  const box = document.getElementById('toast');
  box.replaceChildren(h('span', msg), ...actions.map(([label, fn]) =>
    h('button.link', { onclick: () => { box.classList.remove('show'); fn(); } }, label)));
  box.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('show'), ms);
}

/** Bottom sheet modal. Returns {close, body}. */
export function sheet(title, content, { onClose } = {}) {
  const root = document.getElementById('sheet-root');
  const close = () => { wrap.remove(); onClose?.(); };
  const body = h('div.sheet-body', content);
  const wrap = h('div.sheet-wrap', { onclick: e => { if (e.target === wrap) close(); } },
    h('div.sheet',
      h('div.sheet-head', h('h3', title), h('button.icon', { onclick: close, 'aria-label': 'Close' }, '✕')),
      body));
  root.append(wrap);
  return { close, body };
}

export function confirmSheet(title, message, okLabel = 'OK', danger = false) {
  return new Promise(resolve => {
    let answered = false;
    const s = sheet(title, [
      h('p', message),
      h('div.row',
        h('button.btn.secondary', { onclick: () => { answered = true; s.close(); resolve(false); } }, 'Cancel'),
        h(`button.btn${danger ? '.danger' : ''}`, { onclick: () => { answered = true; s.close(); resolve(true); } }, okLabel)),
    ], { onClose: () => { if (!answered) resolve(false); } });
  });
}

export function promptSheet(title, label, value = '', okLabel = 'Save') {
  return new Promise(resolve => {
    let answered = false;
    const input = h('input', { type: 'text', value });
    const done = v => { answered = true; s.close(); resolve(v); };
    const s = sheet(title, [
      h('label', label, input),
      h('div.row',
        h('button.btn.secondary', { onclick: () => done(null) }, 'Cancel'),
        h('button.btn', { onclick: () => done(input.value.trim()) }, okLabel)),
    ], { onClose: () => { if (!answered) resolve(null); } });
    setTimeout(() => input.focus(), 50);
  });
}

// ---------------------------------------------------------------- maps

const EAST_TEXAS = [31.45, -94.85];

export function makeMap(el, { center, zoom = 12 } = {}) {
  const map = L.map(el, { zoomControl: true, attributionControl: true }).setView(center || EAST_TEXAS, center ? zoom : 9);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap',
  }).addTo(map);
  // Leaflet needs a size recalculation once the container is laid out.
  setTimeout(() => { if (map._container?.isConnected) map.invalidateSize(); }, 50);
  return map;
}

export function numberIcon(n, kind = 'stop') {
  return L.divIcon({
    className: '',
    html: `<div class="pin pin-${kind}">${esc(n)}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

export function placeIcon(kind) {
  const label = { home: '🏠', dump: '🗑️' }[kind] || '•';
  return L.divIcon({ className: '', html: `<div class="pin pin-place">${label}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] });
}

export function meIcon() {
  return L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
}

export function fitTo(map, latlngs, maxZoom = 16) {
  const pts = latlngs.filter(p => p && p[0] != null);
  if (pts.length === 1) map.setView(pts[0], maxZoom);
  else if (pts.length > 1) map.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom });
}

export function appleMapsUrl(p) {
  return `https://maps.apple.com/?daddr=${p.lat},${p.lng}&dirflg=d`;
}

/** Look up an address with OpenStreetMap's Nominatim. */
export async function geocode(q) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=5&countrycodes=us&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
  if (!res.ok) throw new Error(`Address lookup failed (${res.status})`);
  return res.json();
}

/**
 * Full-screen picker: drag the map so the crosshair sits on the spot, or search
 * an address, or jump to your current location. Resolves {lat,lng} or null.
 */
export function pickLocation(title, { start, fix } = {}) {
  return new Promise(resolve => {
    let answered = false;
    const mapEl = h('div.pick-map');
    const search = h('input', { type: 'search', placeholder: 'Search address or place' });
    const results = h('div.pick-results');
    const doSearch = async () => {
      results.replaceChildren(h('div.muted', 'Searching…'));
      try {
        const hits = await geocode(search.value);
        results.replaceChildren(...(hits.length ? hits.map(r => h('button.pick-hit', {
          onclick: () => { map.setView([+r.lat, +r.lon], 17); results.replaceChildren(); },
        }, r.display_name)) : [h('div.muted', 'No matches')]));
      } catch (e) { results.replaceChildren(h('div.muted', e.message)); }
    };
    search.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
    const done = v => { answered = true; s.close(); resolve(v); };
    const s = sheet(title, [
      h('div.row', search, h('button.btn.small', { onclick: doSearch }, 'Find')),
      results,
      h('div.pick-wrap', mapEl, h('div.crosshair')),
      h('div.row',
        fix ? h('button.btn.secondary', { onclick: () => map.setView([fix().lat, fix().lng], 17) }, '📍 My location') : null,
        h('button.btn', { onclick: () => { const c = map.getCenter(); done({ lat: c.lat, lng: c.lng }); } }, 'Use this spot')),
    ], { onClose: () => { if (!answered) resolve(null); } });
    const map = makeMap(mapEl, { center: start ? [start.lat, start.lng] : null, zoom: 16 });
  });
}

export function download(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const file = new File([blob], filename, { type });
  if (navigator.canShare?.({ files: [file] })) {
    return navigator.share({ files: [file], title: filename }).catch(() => {});
  }
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a); a.click(); a.remove();
}

export function fmtDate(t) {
  return new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
export function fmtTime(t) {
  return new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
