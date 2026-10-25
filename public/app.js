'use strict';

/* ------------------------------------------------------------------ stan */

const DEFAULT_START = { lat: 50.0617, lon: 19.9373, label: 'Rynek Główny' };

const app = {
  parks: [],
  byId: new Map(),
  categories: [],
  catById: new Map(),
  visited: {},
  routes: [],
  activeCats: new Set(),
  settings: { n: 5, skipDone: true, loop: false, start: DEFAULT_START },
  matrix: { ready: false, progress: 0, total: 1 },
  route: null,
  routeCoords: null,
  seq: 0,
  variantsSeq: 0,
  variantsTimer: null,
  map: null,
  markers: new Map(),
  routeLayer: null,
  previewLayer: null,
  startMarker: null,
  currentLine: null,
  picking: false,
  selectedId: null,
  listFilter: 'all',
  search: '',
  toastTimer: null,
  pendingTimer: null,
  settingsTimer: null,
  currentTab: 'route',
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* -------------------------------------------------------------- narzędzia */

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtKm = (m) => (Math.round((m || 0) / 100) / 10).toFixed(1).replace('.', ',') + ' km';

const fmtTime = (min) => {
  min = Math.max(0, Math.round(min));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const r = min % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
};

const fmtDate = (iso) => {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
};

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const fmtCoord = (v) => v.toFixed(5).replace('.', ',');

function plural(n, one, few, many) {
  if (n === 1) return one;
  const r10 = n % 10;
  const r100 = n % 100;
  if (r10 >= 2 && r10 <= 4 && !(r100 >= 12 && r100 <= 14)) return few;
  return many;
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(app.toastTimer);
  app.toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

async function api(path, body) {
  const opts = body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : {};
  if (body && body.__delete) {
    opts.method = 'DELETE';
    delete opts.body;
  }
  const res = await fetch(path, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok && !json.pending) throw new Error(json.error || `Błąd ${res.status}`);
  return json;
}

function saveSettings() {
  clearTimeout(app.settingsTimer);
  app.settingsTimer = setTimeout(() => {
    api('/api/settings', {
      n: app.settings.n,
      kinds: [...app.activeCats],
      skipDone: app.settings.skipDone,
      loop: app.settings.loop,
      start: app.settings.start,
    }).catch(() => {});
  }, 400);
}

/* ------------------------------------------------------------------ mapa */

function setupMap() {
  const map = L.map('map', {
    zoomControl: false,
    minZoom: 10,
    maxZoom: 19,
    zoomSnap: 0.25,
  }).setView([50.055, 19.945], 12);

  L.control.zoom({ position: 'topright' }).addTo(map);
  L.control.scale({ position: 'bottomright', imperial: false }).addTo(map);

  const FitAll = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const bar = L.DomUtil.create('div', 'leaflet-bar');
      const a = L.DomUtil.create('a', 'fit-all', bar);
      a.href = '#';
      a.title = 'Pokaż całą Kraków';
      a.setAttribute('aria-label', 'Pokaż całą Kraków');
      a.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4"/><circle cx="12" cy="12" r="2.2"/></svg>';
      L.DomEvent.on(a, 'click', (e) => {
        L.DomEvent.stop(e);
        fitAllParks();
      });
      return bar;
    },
  });
  map.addControl(new FitAll());

  L.tileLayer('/tiles/{z}/{x}/{y}.png', {
    maxZoom: 19,
    minZoom: 10,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  }).addTo(map);

  app.map = map;
  const updateZoomLook = () => map.getContainer().classList.toggle('zoomed-out', map.getZoom() < 12.5);
  map.on('zoomend', () => {
    updateZoomLook();
    updateParkMarkers();
  });
  setTimeout(updateZoomLook, 0);
  map.on('click', (e) => {
    if (app.picking) {
      stopPicking();
      setStart(e.latlng.lat, e.latlng.lng, null, { fit: true });
      return;
    }
    if (app.selectedId) {
      app.selectedId = null;
      updateParkMarkers();
    }
  });
}

function pinIcon(p) {
  const done = !!app.visited[p.id];
  const onRoute = inRoute(p.id);
  const selected = app.selectedId === p.id;
  const cls = `park-pin${done ? ' is-done' : ''}${onRoute ? ' is-on-route' : ''}${selected ? ' is-selected' : ''}`;
  return L.divIcon({
    className: 'park-marker',
    html: `<div class="${cls}" style="--cat:${p.color}"><span class="pin-num">${p.number}</span><span class="pin-check">✓</span></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -11],
  });
}

function buildParkMarkers() {
  for (const p of app.parks) {
    const marker = L.marker(p.center, {
      icon: pinIcon(p),
      riseOnHover: true,
      keyboard: true,
      title: `${p.number}. ${p.name}`,
    });
    marker.bindTooltip(`${p.number}. ${esc(p.name)}`, {
      direction: 'top',
      offset: [0, -13],
      className: 'park-tip',
    });
    marker.bindPopup(() => popupHtml(p), { closeButton: true, offset: [0, -8], maxWidth: 290 });
    marker.on('click', () => focusPark(p.id, false));
    marker.addTo(app.map);
    app.markers.set(p.id, marker);
  }
}

function inRoute(id) {
  return !!app.route?.stops?.some((s) => s.id === id);
}

function updateParkMarkers() {
  for (const p of app.parks) {
    const marker = app.markers.get(p.id);
    if (!marker) continue;
    const done = !!app.visited[p.id];
    const onRoute = inRoute(p.id);
    const selected = app.selectedId === p.id;
    const served = app.activeCats.has(p.category);
    marker.setIcon(pinIcon(p));
    marker.setOpacity(served || done || selected ? 1 : 0.3);
    marker.setZIndexOffset(done ? 200 : onRoute ? 400 : selected ? 320 : 0);
  }
}

function fitAllParks() {
  if (!app.parks.length) return;
  app.map.fitBounds(L.latLngBounds(app.parks.map((p) => p.center)), { padding: [40, 50], animate: false });
}

function renderStartMarker() {
  if (app.startMarker) app.startMarker.remove();
  const s = app.settings.start || DEFAULT_START;
  const icon = L.divIcon({
    className: '',
    html: '<div class="start-marker"><span>A</span></div>',
    iconSize: [34, 34],
    iconAnchor: [17, 32],
  });
  app.startMarker = L.marker([s.lat, s.lon], {
    icon,
    zIndexOffset: 900,
    keyboard: false,
    draggable: true,
    title: 'Przeciągnij, aby zmienić start',
  }).addTo(app.map);
  app.startMarker.on('click', () => app.map.setView([s.lat, s.lon], Math.max(app.map.getZoom(), 15)));
  app.startMarker.on('dragend', () => {
    const ll = app.startMarker.getLatLng();
    setStart(ll.lat, ll.lng, null, { fit: true });
  });
}

/* ----------------------------------------------------------------- start */

function renderStart() {
  const s = app.settings.start || DEFAULT_START;
  $('#startName').textContent = s.label || 'Wybrany punkt';
  $('#startCoords').textContent = `${fmtCoord(s.lat)} · ${fmtCoord(s.lon)}`;
  renderStartMarker();
}

async function setStart(lat, lon, label, { fit = false } = {}) {
  app.settings.start = { lat, lon, label: label || 'Wybrany punkt' };
  renderStart();
  saveSettings();
  computeRoute({ fit });
  if (!label) {
    api(`/api/geocode?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`)
      .then((r) => {
        if (r.label && app.settings.start.lat === lat && app.settings.start.lon === lon) {
          app.settings.start.label = r.label;
          renderStart();
          saveSettings();
        }
      })
      .catch(() => {});
  }
}

function startPicking() {
  app.picking = true;
  document.body.classList.add('picking');
  $('#mapHint').hidden = false;
  $('#btnPick').setAttribute('aria-pressed', 'true');
  toast('Kliknij na mapie, aby ustawić punkt startowy');
}

function stopPicking() {
  app.picking = false;
  document.body.classList.remove('picking');
  $('#mapHint').hidden = true;
  $('#btnPick').setAttribute('aria-pressed', 'false');
}

/* ---------------------------------------------------------------- trasa */

function showLoading(text) {
  $('#routeLoading').hidden = false;
  $('#loadingText').textContent = text;
  $('#routeBody').hidden = true;
  $('#routeEmpty').hidden = true;
}

function showEmpty(html) {
  $('#routeLoading').hidden = true;
  $('#routeBody').hidden = true;
  const el = $('#routeEmpty');
  el.hidden = false;
  el.innerHTML = html;
}

function renderRoute(res) {
  $('#routeLoading').hidden = true;
  $('#routeBody').hidden = false;
  $('#routeEmpty').hidden = true;

  $('#totalKm').textContent = fmtKm(res.total);
  const parts = [`<strong>${res.count} ${plural(res.count, 'park', 'parki', 'parków')}</strong>`];
  parts.push(`≈ ${fmtTime(res.walkMinutes)} pieszo`);
  if (res.loop) parts.push('powrót do startu');
  let meta = parts.join(' · ');
  meta += `<br><span class="soft">${res.approx ? 'przybliżone (linia prosta)' : 'po ulicach i ścieżkach'}</span>`;
  $('#totalMeta').innerHTML = meta;

  const stops = $('#stops');
  stops.innerHTML = '';
  res.stops.forEach((s, i) => {
    const li = document.createElement('li');
    li.dataset.id = s.id;
    if (s.isStart) li.className = 'is-start';
    const leg = i === 0 ? 'start' : `${fmtKm(s.legFromPrev)} · ${Math.round(s.legFromPrev / 78)} min`;
    li.innerHTML = `
      <div class="stop-num"><span>${s.isStart ? 'A' : i + 1}</span></div>
      <div class="stop-body">
        <div class="stop-name">${esc(s.name)}</div>
        <div class="stop-meta">${s.isStart ? 'meta' : `${leg} · <span class="cat-dot" style="background:${s.color}"></span>${esc(s.categoryLabel)}`}</div>
      </div>
      ${
        s.isStart
          ? ''
          : `<button class="stop-done" type="button" data-act="stop-done" data-id="${s.id}" title="Oznacz jako zrobione" aria-label="Oznacz ${esc(
              s.name
            )} jako zrobione"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7"/></svg></button>`
      }`;
    if (!s.isStart) {
      li.addEventListener('click', (e) => {
        if (e.target.closest('[data-act]')) return;
        focusPark(s.id, false);
      });
    }
    stops.appendChild(li);
  });

  $('#routeNote').innerHTML = res.approx
    ? 'Część odległości policzona w linii prostej — serwer tras był chwilowo niedostępny.'
    : 'Długość liczona po pieszych szlakach z OpenStreetMap, tempo ok. 4,8 km/h.';

  const missing = res.requested - res.count;
  if (missing > 0) {
    $('#routeNote').innerHTML += ` W dostępnych kategoriach zostało tylko ${res.count} ${plural(
      res.count,
      'park',
      'parki',
      'parków'
    )}.`;
  }

  updateParkMarkers();
  renderStats();
  renderListMeta();
  renderParkList();
}

async function computeRoute({ fit = false } = {}) {
  const seq = ++app.seq;
  app.variantsSeq++;
  clearTimeout(app.variantsTimer);
  $('#nDeltas')?.classList.add('is-loading');
  clearTimeout(app.pendingTimer);
  showLoading(app.matrix.ready ? 'Liczę trasę…' : 'Układam siatkę pieszych tras…');

  let res;
  try {
    res = await api('/api/route', {
      start: app.settings.start,
      n: app.settings.n,
      kinds: [...app.activeCats],
      skipDone: app.settings.skipDone,
      loop: app.settings.loop,
    });
  } catch (err) {
    if (seq !== app.seq) return;
    hideVariants();
    showEmpty(`<strong>Nie udało się policzyć trasy.</strong><br>${esc(err.message)}<br>Spróbuj ponownie za chwilę.`);
    return;
  }
  if (seq !== app.seq) return;

  if (res.pending) {
    hideVariants();
    app.matrix = res.progress || app.matrix;
    const pct = Math.min(99, Math.round((100 * app.matrix.progress) / Math.max(1, app.matrix.total)));
    showLoading(`Układam siatkę pieszych tras… ${pct}%`);
    app.pendingTimer = setTimeout(() => computeRoute({ fit }), 1200);
    return;
  }

  if (!res.ok) {
    hideVariants();
    showEmpty('Nie udało się policzyć trasy.');
    return;
  }

  if (res.empty) {
    app.route = null;
    clearRouteLayers();
    hideVariants();
    showEmpty(
      `<strong>Brak parków do odwiedzenia.</strong><br>Wszystkie w wybranych kategoriach są już zrobione.
       Wyłącz „Pomiń już zrobione” albo dodaj inną kategorię.`
    );
    updateParkMarkers();
    return;
  }

  app.route = res;
  app.routeCoords = null;
  renderRoute(res);
  drawRoute(res);
  loadGeometry(res, seq);
  scheduleVariants();
  if (fit) fitRoute(res);
  else ensureRouteVisible(res);
}

function clearRouteLayers() {
  if (app.routeLayer) {
    app.routeLayer.remove();
    app.routeLayer = null;
  }
}

function routePoints(res) {
  return [[res.start.lat, res.start.lon], ...res.stops.map((s) => s.center)];
}

function drawRoute(res) {
  clearRouteLayers();
  const group = L.layerGroup();

  const pts = routePoints(res);
  L.polyline(pts, {
    color: '#ffffff',
    weight: 8,
    opacity: 0.9,
    lineCap: 'round',
    lineJoin: 'round',
  }).addTo(group);
  const line = L.polyline(pts, {
    color: '#d2712a',
    weight: 4,
    opacity: 0.95,
    dashArray: '1 7',
    lineCap: 'round',
    lineJoin: 'round',
  }).addTo(group);

  res.stops.forEach((s, i) => {
    if (s.isStart) return;
    const icon = L.divIcon({
      className: '',
      html: `<div class="stop-marker">${i + 1}</div>`,
      iconSize: [27, 27],
      iconAnchor: [13.5, 13.5],
    });
    const marker = L.marker(s.center, { icon, zIndexOffset: 500 + (res.stops.length - i) }).addTo(group);
    marker.on('click', () => focusPark(s.id, false));
    marker.bindTooltip(`${i + 1}. ${esc(s.name)}`, { direction: 'top', offset: [0, -12] });
  });

  group.addTo(app.map);
  app.routeLayer = group;
  app.currentLine = line;
  updateParkMarkers();
}

function fitRoute(res) {
  const pts = routePoints(res);
  if (!pts.length) return;
  app.map.fitBounds(L.latLngBounds(pts), {
    paddingTopLeft: [50, 60],
    paddingBottomRight: [50, 60],
    maxZoom: 15.5,
    animate: false,
  });
}

function ensureRouteVisible(res) {
  const pts = routePoints(res);
  if (!pts.length) return;
  const bounds = L.latLngBounds(pts);
  const view = app.map.getBounds();
  if (!view.pad(-0.06).contains(bounds)) fitRoute(res);
}

async function loadGeometry(res, seq) {
  const pts = routePoints(res);
  try {
    const r = await api('/api/geometry', { points: pts });
    if (seq !== app.seq || !app.currentLine) return;
    if (r.ok && r.coords && r.coords.length > 2) {
      app.currentLine.setLatLngs(r.coords);
      app.currentLine.setStyle({ dashArray: null });
      app.routeCoords = r.coords;
      if (app.routeLayer) {
        const casing = app.routeLayer.getLayers()[0];
        if (casing) casing.setLatLngs(r.coords);
      }
    }
  } catch {}
}

/* --------------------------------------------------------------- eksport */

const xmlEsc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

function routeFileName(res, ext = 'gpx') {
  const n = res.stops.filter((s) => !s.isStart).length;
  return `odkrywca-parkow-${n}-${today()}.${ext}`;
}

function buildGpx(res, coords) {
  const stops = res.stops.filter((s) => !s.isStart);
  const start = res.start || DEFAULT_START;
  const name = `Odkrywca parków: ${stops.length} ${plural(stops.length, 'park', 'parki', 'parków')} · ${fmtKm(res.total)}`;

  const wpts = [
    ` <wpt lat="${start.lat.toFixed(6)}" lon="${start.lon.toFixed(6)}"><name>Start: ${xmlEsc(
      start.label || app.settings.start?.label || 'punkt startowy'
    )}</name><sym>Flag, Blue</sym></wpt>`,
  ];
  stops.forEach((s, i) => {
    const desc = [`Park nr ${s.number}`, s.categoryLabel, s.hint ? `Pieczątka: ${s.hint}` : ''].filter(Boolean).join(' · ');
    wpts.push(
      ` <wpt lat="${s.center[0].toFixed(6)}" lon="${s.center[1].toFixed(6)}"><name>${i + 1}. ${xmlEsc(
        s.name
      )}</name><desc>${xmlEsc(desc)}</desc><sym>${xmlEsc(s.categoryLabel)}</sym></wpt>`
    );
  });

  const pts = coords && coords.length > 1 ? coords : routePoints(res);
  const trkpts = pts.map(([lat, lon]) => `   <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"/>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Odkrywca parków (aplikacja lokalna)" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
 <metadata>
  <name>${xmlEsc(name)}</name>
  <time>${new Date().toISOString()}</time>
 </metadata>
${wpts.join('\n')}
 <trk>
  <name>${xmlEsc(name)}</name>
  <type>walking</type>
  <trkseg>
${trkpts}
  </trkseg>
 </trk>
</gpx>
`;
}

function downloadFile(text, filename, mime = 'application/gpx+xml') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function coordsForPoints(pts) {
  try {
    const g = await api('/api/geometry', { points: pts });
    if (g.ok && g.coords && g.coords.length > 2) return g.coords;
  } catch {}
  return pts;
}

async function coordsForRoute(res) {
  if (res === app.route && app.routeCoords && app.routeCoords.length > 2) return app.routeCoords;
  return coordsForPoints(routePoints(res));
}

async function exportGpx() {
  if (!app.route) return;
  const coords = await coordsForRoute(app.route);
  downloadFile(buildGpx(app.route, coords), routeFileName(app.route));
  toast('Pobrano GPX — otwórz go w OsmAnd, Locus, Komoot lub Garminie');
}

async function exportSavedGpx(id) {
  const r = app.routes.find((x) => x.id === id);
  if (!r) return;
  const stops = r.ids.map((pid) => app.byId.get(pid)).filter(Boolean);
  if (!stops.length) return toast('Ta trasa nie ma już dostępnych punktów');
  const start = r.start || DEFAULT_START;
  const pts = [[start.lat, start.lon], ...stops.map((p) => p.center)];
  if (r.loop) pts.push([start.lat, start.lon]);
  toast('Przygotowuję GPX…');
  const coords = await coordsForPoints(pts);
  const fake = { start, stops: stops.map((p) => ({ ...p, isStart: false })), total: r.total };
  downloadFile(buildGpx(fake, coords), routeFileName(fake));
  toast('Pobrano GPX zapisanej trasy');
}

function mapsUrlForPoints(start, stops) {
  if (!stops || !stops.length) return '';
  start = start || DEFAULT_START;
  const dest = stops[stops.length - 1].center;
  const mids = stops.slice(0, -1).slice(0, 9);
  let url =
    `https://www.google.com/maps/dir/?api=1&origin=${start.lat},${start.lon}` +
    `&destination=${dest[0]},${dest[1]}&travelmode=walking`;
  if (mids.length) url += `&waypoints=${encodeURIComponent(mids.map((s) => `${s.center[0]},${s.center[1]}`).join('|'))}`;
  return url;
}

function mapsUrlFor(res) {
  return mapsUrlForPoints(
    res.start || DEFAULT_START,
    res.stops.filter((s) => !s.isStart)
  );
}

function navigateSaved(id) {
  const r = app.routes.find((x) => x.id === id);
  if (!r) return;
  const stops = r.ids.map((pid) => app.byId.get(pid)).filter(Boolean);
  if (!stops.length) return toast('Ta trasa nie ma już dostępnych punktów');
  if (stops.length > 10) toast('Google Maps przyjmie 10 punktów — cała trasa jest w GPX');
  window.open(mapsUrlForPoints(r.start, stops), '_blank', 'noopener');
}

async function completeSavedRoute(id) {
  const r = app.routes.find((x) => x.id === id);
  if (!r) return;
  const missing = r.ids.filter((pid) => app.byId.has(pid) && !app.visited[pid]);
  if (!missing.length) return toast('Wszystkie punkty tej trasy są już zrobione');
  const msg = `Oznaczyć ${missing.length} ${plural(
    missing.length,
    'park',
    'parki',
    'parków'
  )} z trasy „${r.label || 'Trasa'}” jako zrobione?`;
  if (!confirm(msg)) return;

  let added = 0;
  try {
    const res = await api('/api/visited/bulk', { ids: missing, doneAt: today() });
    added = res.added || 0;
    if (res.state) {
      app.visited = res.state.visited || app.visited;
      app.routes = res.state.routes || app.routes;
    }
  } catch {
    return toast('Nie udało się zapisać. Spróbuj ponownie.');
  }

  updateParkMarkers();
  renderStats();
  renderParkList();
  renderListMeta();
  renderSaved();
  if (app.settings.skipDone) computeRoute();
  toast(`Oznaczono ${added} ${plural(added, 'park', 'parki', 'parków')} jako zrobione`);
}

/* ------------------------------------------------------------ odwiedzone */

async function setVisited(id, done, date) {
  const park = app.byId.get(id);
  if (!park) return;
  const before = app.visited[id];

  if (done) app.visited[id] = { doneAt: date || today(), note: before?.note || '' };
  else delete app.visited[id];

  app.map.closePopup();
  updateParkMarkers();
  renderStats();
  renderParkList();
  renderListMeta();
  if (app.route) {
    const stop = app.route.stops.find((s) => s.id === id);
    if (stop) stop.done = !!done;
  }

  try {
    const r = await api('/api/visited', { id, done, doneAt: date || today() });
    if (r.state) {
      app.visited = r.state.visited || {};
      app.routes = r.state.routes || app.routes;
    }
  } catch {
    if (done) delete app.visited[id];
    else if (before) app.visited[id] = before;
    toast('Nie udało się zapisać. Spróbuj ponownie.');
  }

  updateParkMarkers();
  renderStats();
  renderParkList();
  renderListMeta();

  if (app.settings.skipDone) computeRoute();
  else if (app.route && inRoute(id)) {
    drawRoute(app.route);
    loadGeometry(app.route, app.seq);
  }

  if (done) {
    const n = Object.keys(app.visited).length;
    toast(`Zapisano: ${park.name}${n === app.parks.length ? ' — komplet! 🎉' : ''}`);
  } else {
    toast(`Cofnięto: ${park.name}`);
  }
}

function renderStats() {
  const total = app.parks.length;
  const done = Object.keys(app.visited).length;
  $('#parkCount').textContent = total;
  $('#allCount').textContent = total;
  $('#doneCount').textContent = done;
  $('#barFill').style.width = total ? `${(100 * done) / total}%` : '0%';
  $('#availableHint').textContent = `${available()} dostępnych`;
}

function available() {
  return app.parks.filter((p) => app.activeCats.has(p.category) && !(app.settings.skipDone && app.visited[p.id])).length;
}

/* --------------------------------------------------------------- popup */

function focusPark(id, fly = true) {
  const p = app.byId.get(id);
  const marker = app.markers.get(id);
  if (!p) return;
  app.selectedId = id;
  updateParkMarkers();

  const zoom = fly ? Math.max(app.map.getZoom(), 16) : app.map.getZoom() < 13 ? 15 : app.map.getZoom();
  const open = () => {
    if (!marker) return;
    marker.setPopupContent(popupHtml(p));
    marker.openPopup();
  };

  if (fly) {
    let opened = false;
    const once = () => {
      if (opened) return;
      opened = true;
      open();
    };
    app.map.once('moveend', once);
    app.map.flyTo(p.center, zoom, { duration: 0.5 });
    setTimeout(once, 750);
  } else {
    app.map.panTo(p.center, { animate: true, duration: 0.3 });
    setTimeout(open, 120);
  }
}

function popupHtml(p) {
  const v = app.visited[p.id];
  const hint = p.hint
    ? `<div class="pop-hint"><span>Wskazówka</span>${esc(p.hint)}</div>`
    : '';
  return `
    <div class="pop" data-id="${p.id}">
      <div class="pop-kind"><span class="cat-dot" style="background:${p.color}"></span>${esc(p.categoryLabel)} · nr ${p.number}</div>
      <div class="pop-name">${esc(p.name)}</div>
      ${hint}
      ${
        v
          ? `<div class="pop-done"><span>Zrobione ${fmtDate(v.doneAt)}</span><button type="button" data-act="undo" data-id="${p.id}">Cofnij</button></div>`
          : `<div class="pop-actions">
               <input class="pop-date" type="date" value="${today()}" max="${today()}" aria-label="Data odwiedzenia">
               <button class="pop-btn primary" type="button" data-act="done" data-id="${p.id}">
                 <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7"/></svg>
                 Zrobione
               </button>
             </div>`
      }
      <div class="pop-links">
        <a href="${esc(p.detailsUrl)}" target="_blank" rel="noopener">Szczegóły ↗</a>
        <a href="https://www.google.com/maps/dir/?api=1&destination=${p.center[0]},${p.center[1]}" target="_blank" rel="noopener">Nawiguj ↗</a>
      </div>
      <button class="pop-btn" type="button" data-act="start-here" data-id="${p.id}" style="width:100%;margin-top:7px;justify-content:center">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Z"/><circle cx="12" cy="10" r="2.4"/></svg>
        Ustaw jako start
      </button>
    </div>`;
}

/* ----------------------------------------------------- zdarzenia globalne */

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const id = btn.dataset.id;
  if (act === 'done') {
    const date = btn.closest('.pop')?.querySelector('.pop-date')?.value || today();
    setVisited(id, true, date);
  } else if (act === 'undo') {
    setVisited(id, false);
  } else if (act === 'stop-done') {
    setVisited(id, true, today());
  } else if (act === 'start-here') {
    const p = app.byId.get(id);
    if (p) {
      app.map.closePopup();
      setStart(p.center[0], p.center[1], `${p.number}. ${p.name}`, { fit: true });
      toast(`Start: ${p.name}`);
    }
  }
});

/* --------------------------------------------------------------- lista */

function renderListMeta() {
  const done = Object.keys(app.visited).length;
  $('#listMeta').textContent = `${done} z ${app.parks.length} zrobionych · ${app.parks.length - done} przed Tobą`;
}

function renderParkList() {
  const list = $('#parkList');
  const q = app.search.trim().toLowerCase();
  let items = app.parks.slice().sort((a, b) => a.number - b.number);
  if (q) items = items.filter((p) => p.name.toLowerCase().includes(q));
  if (app.listFilter === 'done') items = items.filter((p) => app.visited[p.id]);
  if (app.listFilter === 'todo') items = items.filter((p) => !app.visited[p.id]);

  if (!items.length) {
    list.innerHTML = `<div class="empty-state">Nic tu nie ma. Zmień filtr lub wyszukaj inaczej.</div>`;
    return;
  }

  list.innerHTML = items
    .map((p) => {
      const v = app.visited[p.id];
      return `<div class="park-row ${v ? 'is-done' : ''}" data-id="${p.id}" role="button" tabindex="0">
        <span class="park-num" style="--cat:${p.color}" aria-hidden="true">${p.number}</span>
        <span>
          <span class="park-name">${esc(p.name)}</span>
          <span class="park-sub">${esc(p.categoryLabel)}${inRoute(p.id) ? ' · na trasie' : ''}${
        app.visited[p.id] ? ' · zrobione' : ''
      }</span>
        </span>
        <span class="park-area">
          <span class="check" data-act="toggle" data-id="${p.id}" role="checkbox" aria-checked="${!!v}" aria-label="Zrobione: ${esc(
        p.name
      )}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7"/></svg></span>
          ${v ? `<span class="done-date">${fmtDate(v.doneAt)}</span>` : ''}
        </span>
      </div>`;
    })
    .join('');
}

/* ------------------------------------------------------------- zapisane */

function renderSaved() {
  const wrap = $('#savedList');
  $('#savedBadge').textContent = app.routes.length;
  $('#savedBadge').dataset.empty = app.routes.length ? 'false' : 'true';
  if (!app.routes.length) {
    wrap.innerHTML = `<div class="empty-state"><strong>Jeszcze nic tu nie ma.</strong><br>Ułóż trasę i kliknij „Zapisz”, żeby wrócić do niej później.</div>`;
    return;
  }
  wrap.innerHTML = app.routes
    .map((r) => {
      const names = r.ids.map((id) => app.byId.get(id)).filter(Boolean);
      const date = new Date(r.createdAt);
      const doneInRoute = r.ids.filter((pid) => app.visited[pid]).length;
      const allDone = r.ids.length > 0 && doneInRoute === r.ids.length;
      return `<div class="saved-card" data-id="${r.id}">
        <div class="saved-top">
          <div>
            <div class="saved-title">${esc(r.label || 'Trasa')}</div>
            <div class="saved-date">${date.toLocaleDateString('pl-PL', { day: 'numeric', month: 'long', year: 'numeric' })}${
        r.loop ? ' · pętla' : ''
      }</div>
          </div>
          <div class="saved-actions">
            <button class="icon-btn" type="button" data-act="show-route" data-id="${r.id}" title="Pokaż na mapie" aria-label="Pokaż na mapie">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6.5 9 4l6 2.5L21 4v13.5L15 20l-6-2.5L3 20Z"/><path d="M9 4v13.5M15 6.5V20"/></svg>
            </button>
            <button class="icon-btn danger" type="button" data-act="del-route" data-id="${r.id}" title="Usuń" aria-label="Usuń trasę">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>
            </button>
          </div>
        </div>
        <div class="saved-stats">${r.ids.length} ${plural(r.ids.length, 'park', 'parki', 'parków')} · ${fmtKm(r.total)} · ${fmtTime(r.walkMinutes)}</div>
        <div class="saved-actions-row">
          <button class="saved-btn" type="button" data-act="gpx-route" data-id="${r.id}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v11m0 0 4-4m-4 4-4-4"/><path d="M4 17v3h16v-3"/></svg>
            GPX
          </button>
          <button class="saved-btn" type="button" data-act="nav-route" data-id="${r.id}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m21 3-9.5 18-2-7.5L2 11.5Z"/></svg>
            Nawiguj
          </button>
          <button class="saved-btn ${allDone ? 'is-done' : ''}" type="button" data-act="complete-route" data-id="${
        r.id
      }" ${allDone ? 'disabled' : ''} title="Oznacz wszystkie punkty trasy jako zrobione">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7"/></svg>
            ${allDone ? 'Zrobione' : 'Oznacz zrobione'}
          </button>
        </div>
        <details><summary>${r.ids.length} ${plural(r.ids.length, 'przystanek', 'przystanki', 'przystanków')}</summary>
          <ol class="saved-names">${names.map((p) => `<li>${esc(p.name)}</li>`).join('')}</ol>
        </details>
      </div>`;
    })
    .join('');
}

function markerForStop(p, label, done = false) {
  return L.marker(p.center, {
    icon: L.divIcon({
      className: '',
      html: `<div class="stop-marker${done ? ' is-done' : ''}">${label}</div>`,
      iconSize: [27, 27],
      iconAnchor: [13.5, 13.5],
    }),
    zIndexOffset: 400,
  });
}

async function showSavedRoute(id) {
  const r = app.routes.find((x) => x.id === id);
  if (!r) return;
  clearPreview();
  const stops = r.ids.map((pid) => app.byId.get(pid)).filter(Boolean);
  if (!stops.length) return;
  const start = r.start || DEFAULT_START;
  const pts = [[start.lat, start.lon], ...stops.map((p) => p.center)];

  const group = L.layerGroup();
  const line = L.polyline(pts, { color: '#1f5f43', weight: 4, opacity: 0.9, dashArray: '8 7', lineCap: 'round' }).addTo(
    group
  );
  L.marker([start.lat, start.lon], {
    icon: L.divIcon({ className: '', html: '<div class="start-marker"><span>A</span></div>', iconSize: [34, 34], iconAnchor: [17, 32] }),
    zIndexOffset: 900,
  }).addTo(group);
  stops.forEach((p, i) => {
    markerForStop(p, i + 1, true)
      .bindTooltip(`${i + 1}. ${esc(p.name)}`, { direction: 'top', offset: [0, -12] })
      .addTo(group);
  });
  group.addTo(app.map);
  app.previewLayer = group;
  app.map.fitBounds(L.latLngBounds(pts), { padding: [50, 60], maxZoom: 15.5, animate: false });
  toast(`Podgląd: ${r.label} · ${fmtKm(r.total)}`);

  api('/api/geometry', { points: pts })
    .then((g) => {
      if (app.previewLayer === group && g.ok && g.coords?.length > 2) {
        line.setLatLngs(g.coords);
        line.setStyle({ dashArray: null, color: '#2f7d57' });
      }
    })
    .catch(() => {});
}

function clearPreview() {
  if (app.previewLayer) {
    app.previewLayer.remove();
    app.previewLayer = null;
  }
}

/* ------------------------------------------------------------------ UI */

/* ------------------------------------------- ile doda kolejny park (delty) */

function hideVariants() {
  clearTimeout(app.variantsTimer);
  app.variantsSeq++;
  const el = $('#nDeltas');
  if (!el) return;
  el.hidden = true;
  el.innerHTML = '';
}

function scheduleVariants() {
  clearTimeout(app.variantsTimer);
  app.variantsTimer = setTimeout(computeVariants, 140);
}

async function computeVariants() {
  const el = $('#nDeltas');
  if (!el) return;
  if (!app.route) return hideVariants();

  const seq = ++app.variantsSeq;
  const base = app.settings.n;
  const baseTotal = app.route.total;
  const maxAvail = available();
  const opts = [-1, 1, 2, 3, 4]
    .map((d) => ({ d, n: base + d }))
    .filter((o) => o.n >= 1 && o.n <= 20 && o.n <= maxAvail);

  if (!opts.length) return hideVariants();

  el.hidden = false;
  el.classList.remove('is-loading');
  el.innerHTML = opts
    .map(
      (o) => `<button type="button" data-n="${o.n}" class="${o.d < 0 ? 'is-less' : 'is-more'}" aria-label="Ustaw ${o.n} ${plural(
        o.n,
        'park',
        'parki',
        'parków'
      )}">
        <span class="d">${o.d < 0 ? '−' : '+'}${Math.abs(o.d)}</span>
        <span class="km">…</span>
      </button>`
    )
    .join('');

  const results = await Promise.all(
    opts.map(async (o) => {
      try {
        const r = await api('/api/route', {
          start: app.settings.start,
          n: o.n,
          kinds: [...app.activeCats],
          skipDone: app.settings.skipDone,
          loop: app.settings.loop,
        });
        if (r.ok && !r.pending && !r.empty && Number.isFinite(r.total)) return { ...o, total: r.total };
      } catch {}
      return { ...o, total: null };
    })
  );
  if (seq !== app.variantsSeq) return;

  el.querySelectorAll('button[data-n]').forEach((btn) => {
    const res = results.find((x) => String(x.n) === btn.dataset.n);
    const km = btn.querySelector('.km');
    if (!res || res.total === null) {
      km.textContent = '—';
      btn.disabled = true;
      return;
    }
    const diff = res.total - baseTotal;
    if (Math.abs(diff) < 25) {
      km.textContent = '0 km';
      btn.classList.remove('is-more', 'is-less');
    } else {
      km.textContent = `${diff > 0 ? '+' : '−'}${(Math.abs(diff) / 1000).toFixed(1).replace('.', ',')} km`;
      btn.classList.toggle('is-more', diff > 0);
      btn.classList.toggle('is-less', diff < 0);
    }
    btn.title = `Ustaw ${res.n} ${plural(res.n, 'park', 'parki', 'parków')} — razem ${fmtKm(res.total)}`;
  });
}

function setN(n, { recompute = true } = {}) {
  n = Math.max(1, Math.min(20, Math.round(Number(n) || 1)));
  app.settings.n = n;
  $('#nInput').value = n;
  $('#nRange').value = n;
  $('#nRange').style.setProperty('--fill', `${((n - 1) / 19) * 100}%`);
  $$('#nChips button').forEach((b) => b.classList.toggle('is-active', Number(b.dataset.n) === n));
  saveSettings();
  if (recompute) computeRoute();
}

function renderCatChips() {
  $('#kindChips').innerHTML = app.categories
    .map(
      (c) => `<button type="button" data-cat="${c.id}" class="${app.activeCats.has(c.id) ? 'is-active' : ''}">
        <span class="cat-dot" style="background:${c.color}"></span>${esc(c.label)} <span class="n">${c.count}</span>
      </button>`
    )
    .join('');

  $('#catLegend').innerHTML = app.categories
    .map((c) => `<span><i class="dot" style="background:${c.color}"></i>${esc(c.label.toLowerCase())}</span>`)
    .join('');
}

function toggleCat(cat) {
  if (app.activeCats.has(cat)) {
    if (app.activeCats.size === 1) {
      toast('Zostaw przynajmniej jedną kategorię');
      return;
    }
    app.activeCats.delete(cat);
  } else {
    app.activeCats.add(cat);
  }
  renderCatChips();
  updateParkMarkers();
  renderStats();
  saveSettings();
  computeRoute();
}

/* ------------------------------------------------------- dostęp z telefonu */

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

async function openNetDialog() {
  const dlg = $('#netDialog');
  const list = $('#netList');
  const qrBox = $('#netQr');
  list.innerHTML = '<div class="net-loading">Sprawdzam adresy…</div>';
  qrBox.innerHTML = '';
  if (!dlg.open) dlg.showModal();

  try {
    const n = await api('/api/network');
    const rows = [];
    if (n.vpn?.https) rows.push(['VPN Tailscale (HTTPS)', n.vpn.https]);
    if (n.vpn?.http) rows.push(['VPN Tailscale (HTTP)', n.vpn.http]);
    for (const u of n.lan || []) rows.push(['Sieć lokalna', u]);
    rows.push(['Ten komputer', `http://localhost:${location.port || 7777}`]);

    list.innerHTML = rows
      .map(
        ([label, url]) => `<div class="net-row">
          <div><div class="net-label">${esc(label)}</div><div class="net-url">${esc(url)}</div></div>
          <button class="net-copy" type="button" data-url="${esc(url)}">Kopiuj</button>
        </div>`
      )
      .join('');
    if (!n.vpn) {
      list.innerHTML += `<div class="net-note">Nie wykryto Tailscale na tym komputerze — dostępny jest tylko adres w sieci lokalnej.</div>`;
    }

    const qrUrl = n.vpn?.http || n.vpn?.https || (n.lan || [])[0];
    if (qrUrl && typeof qrcode === 'function') {
      try {
        const qr = qrcode(0, 'M');
        qr.addData(qrUrl);
        qr.make();
        qrBox.innerHTML =
          qr.createSvgTag({ cellSize: 5, margin: 1, scalable: true }) +
          `<div class="net-qr-label">Zeskanuj aparatem — otworzy się ${esc(qrUrl.replace(/^https?:\/\//, ''))}</div>`;
      } catch {}
    }
  } catch (err) {
    list.innerHTML = `<div class="net-loading">Nie udało się pobrać adresów: ${esc(err.message)}</div>`;
  }
}

function switchTab(tab) {
  app.currentTab = tab;
  $$('.tab').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === tab));
  $$('.tabpane').forEach((p) => p.classList.toggle('is-active', p.id === `pane-${tab}`));
  if (tab === 'parks') renderParkList();
  if (tab === 'saved') renderSaved();
  setTimeout(() => app.map.invalidateSize(), 50);
}

function bindUI() {
  $$('.tab').forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

  $('#btnNet').addEventListener('click', openNetDialog);
  $('#btnNetClose').addEventListener('click', () => $('#netDialog').close());
  $('#netList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-url]');
    if (!b) return;
    const ok = await copyText(b.dataset.url);
    if (ok) {
      b.textContent = 'Skopiowano ✓';
      setTimeout(() => (b.textContent = 'Kopiuj'), 1600);
    } else {
      toast('Skopiuj ręcznie: ' + b.dataset.url);
    }
  });

  $('#btnPick').addEventListener('click', () => (app.picking ? stopPicking() : startPicking()));
  $('#btnCancelPick').addEventListener('click', stopPicking);

  $('#nChips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-n]');
    if (b) setN(b.dataset.n);
  });
  $('#nDeltas').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-n]');
    if (b && !b.disabled) setN(b.dataset.n);
  });
  $$('.step').forEach((b) => b.addEventListener('click', () => setN(app.settings.n + Number(b.dataset.step))));

  $('#nInput').addEventListener('change', (e) => setN(e.target.value));
  $('#nInput').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    if (v >= 1 && v <= 20) {
      $('#nRange').value = v;
      $('#nRange').style.setProperty('--fill', `${((v - 1) / 19) * 100}%`);
      $$('#nChips button').forEach((b) => b.classList.toggle('is-active', Number(b.dataset.n) === v));
      app.settings.n = v;
    }
  });
  $('#nInput').addEventListener('blur', (e) => setN(e.target.value));
  $('#nRange').addEventListener('input', (e) => setN(e.target.value, { recompute: false }));
  $('#nRange').addEventListener('change', (e) => setN(e.target.value));

  $('#kindChips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (b) toggleCat(b.dataset.cat);
  });

  $('#skipDone').addEventListener('change', (e) => {
    app.settings.skipDone = e.target.checked;
    renderStats();
    saveSettings();
    computeRoute();
    renderParkList();
  });
  $('#loopChk').addEventListener('change', (e) => {
    app.settings.loop = e.target.checked;
    saveSettings();
    computeRoute();
  });

  $('#btnSaveRoute').addEventListener('click', async () => {
    if (!app.route) return;
    const ids = app.route.stops.filter((s) => !s.isStart).map((s) => s.id);
    const label = `${ids.length} ${plural(ids.length, 'park', 'parki', 'parków')}`;
    try {
      const r = await api('/api/routes', {
        ids,
        start: app.settings.start,
        label,
        total: app.route.total,
        walkMinutes: app.route.walkMinutes,
        loop: app.settings.loop,
      });
      if (r.routes) app.routes = r.routes;
      renderSaved();
      toast('Trasa zapisana — jest w zakładce „Zapisane”');
    } catch {
      toast('Nie udało się zapisać trasy');
    }
  });

  $('#btnGpx').addEventListener('click', () => exportGpx());

  $('#btnNav').addEventListener('click', () => {
    if (!app.route) return;
    const parks = app.route.stops.filter((s) => !s.isStart);
    if (parks.length > 10) toast('Google Maps przyjmie 10 punktów — cała trasa jest w pliku GPX');
    window.open(mapsUrlFor(app.route), '_blank', 'noopener');
  });

  $('#btnGeo').addEventListener('click', () => {
    if (!navigator.geolocation) return toast('Przeglądarka nie udostępnia lokalizacji');
    toast('Szukam Twojej lokalizacji…');
    navigator.geolocation.getCurrentPosition(
      (pos) => setStart(pos.coords.latitude, pos.coords.longitude, 'Moja lokalizacja', { fit: true }),
      () => toast('Nie udało się ustalić lokalizacji (wymaga HTTPS lub zgody)'),
      { enableHighAccuracy: true, timeout: 12000 }
    );
  });

  const search = $('#searchInput');
  search.addEventListener('input', () => {
    app.search = search.value;
    renderParkList();
  });

  $('#parkFilter').addEventListener('click', (e) => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    app.listFilter = b.dataset.filter;
    $$('#parkFilter button').forEach((x) => x.classList.toggle('is-active', x === b));
    renderParkList();
  });

  $('#parkList').addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-act="toggle"]');
    const row = e.target.closest('.park-row');
    if (!row) return;
    if (toggle) {
      e.stopPropagation();
      setVisited(row.dataset.id, !app.visited[row.dataset.id]);
      return;
    }
    focusPark(row.dataset.id, true);
  });
  $('#parkList').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('.park-row');
    if (!row) return;
    e.preventDefault();
    focusPark(row.dataset.id, true);
  });

  $('#savedList').addEventListener('click', async (e) => {
    const show = e.target.closest('[data-act="show-route"]');
    const gpx = e.target.closest('[data-act="gpx-route"]');
    const nav = e.target.closest('[data-act="nav-route"]');
    const complete = e.target.closest('[data-act="complete-route"]');
    const del = e.target.closest('[data-act="del-route"]');
    if (show) return showSavedRoute(show.dataset.id);
    if (gpx) return exportSavedGpx(gpx.dataset.id);
    if (nav) return navigateSaved(nav.dataset.id);
    if (complete) return completeSavedRoute(complete.dataset.id);
    if (del) {
      const r = app.routes.find((x) => x.id === del.dataset.id);
      if (!confirm(`Usunąć zapisaną trasę „${r?.label || ''}”?`)) return;
      try {
        const res = await api(`/api/routes/${del.dataset.id}`, { __delete: true });
        app.routes = res.routes || app.routes.filter((x) => x.id !== del.dataset.id);
        renderSaved();
        clearPreview();
        toast('Trasa usunięta');
      } catch {
        toast('Nie udało się usunąć trasy');
      }
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) return;
    if (e.key === 'Escape') {
      if (app.picking) stopPicking();
      clearPreview();
      app.map.closePopup();
      if (app.selectedId) {
        app.selectedId = null;
        updateParkMarkers();
      }
    }
    if (e.key === '+' || e.key === '=') setN(app.settings.n + 1);
    if (e.key === '-' || e.key === '_') setN(app.settings.n - 1);
  });
}

/* ------------------------------------------------------------------ start */

async function init() {
  setupMap();
  bindUI();
  try {
    const boot = await api('/api/bootstrap');
    app.parks = boot.parks;
    app.byId = new Map(app.parks.map((p) => [p.id, p]));
    app.categories = boot.kinds || [];
    app.catById = new Map(app.categories.map((c) => [c.id, c]));
    app.visited = boot.state.visited || {};
    app.routes = boot.state.routes || [];
    app.matrix = boot.meta.matrix || app.matrix;
    app.activeCats = new Set(app.categories.map((c) => c.id));

    const s = boot.state.settings || {};
    app.settings = {
      n: Math.max(1, Math.min(20, Number(s.n) || 5)),
      skipDone: s.skipDone !== false,
      loop: !!s.loop,
      start: s.start && Number.isFinite(s.start.lat) ? s.start : { ...DEFAULT_START },
    };
    if (Array.isArray(s.kinds) && s.kinds.length) {
      const valid = s.kinds.filter((k) => app.catById.has(k));
      if (valid.length) app.activeCats = new Set(valid);
    }

    $('#skipDone').checked = app.settings.skipDone;
    $('#loopChk').checked = app.settings.loop;
    setN(app.settings.n, { recompute: false });
    renderCatChips();
    renderStart();
    buildParkMarkers();
    renderStats();
    renderListMeta();
    renderParkList();
    renderSaved();

    if (app.parks.length) {
      fitAllParks();
    }

    computeRoute({ fit: true });
  } catch (err) {
    console.error(err);
    showEmpty(`<strong>Nie udało się wczytać danych.</strong><br>${esc(err.message)}<br>Sprawdź, czy serwer działa.`);
  }
}

init();
