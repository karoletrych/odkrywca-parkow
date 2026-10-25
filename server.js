'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec, execFile } = require('child_process');
const { promisify } = require('util');
const { solve } = require('./lib/route');

const execFileP = promisify(execFile);

const PORT = Number(process.env.PORT || 7777);
const HOST = '0.0.0.0';
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const PUBLIC = path.join(ROOT, 'public');
const TILES = path.join(DATA, 'tiles');
const OPEN_BROWSER = !process.argv.includes('--no-open');

fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(TILES, { recursive: true });

/* ------------------------------------------------------------- logowanie */

const LOG_FILE = path.join(DATA, 'server.log');
const rawLog = console.log.bind(console);
const rawErr = console.error.bind(console);
const fmtLog = (v) =>
  v instanceof Error ? v.stack || v.message : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
function appendLog(level, args) {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    }
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${level} ${args.map(fmtLog).join(' ')}\n`);
  } catch {}
}
console.log = (...args) => {
  rawLog(...args);
  appendLog('INFO', args);
};
console.error = (...args) => {
  rawErr(...args);
  appendLog('ERROR', args);
};
process.on('uncaughtException', (err) => console.error('Nieoczekiwany błąd:', err));
process.on('unhandledRejection', (err) => console.error('Nieobsłużony błąd asynchroniczny:', err));

const OSRM = 'https://routing.openstreetmap.de/routed-foot';
const VALHALLA = 'https://valhalla1.openstreetmap.de';
const UA = 'krakow-parks-explorer/1.0 (local app; kontakt: lokalny uzytkownik)';

/* ------------------------------------------------------------------ dane */

const parksData = JSON.parse(fs.readFileSync(path.join(DATA, 'parks.json'), 'utf8'));
const parks = parksData.parks;
const parkById = new Map(parks.map((p) => [p.id, p]));
const categories = parksData.categories || [];
const kindOrder = categories.length ? categories.map((c) => c.id) : ['common'];

const STATE_FILE = path.join(DATA, 'state.json');
let state = { version: 1, visited: {}, routes: [], settings: {} };
try {
  state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
} catch {}
state.visited ||= {};
state.routes ||= [];
state.settings ||= {};

function saveState() {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

/* --------------------------------------------------- macierz odległości */

const MATRIX_FILE = path.join(DATA, 'matrix.json');
let matrix = null;
const matrixStatus = { ready: false, progress: 0, total: 1, phase: 'start', approx: false };

const haversine = (a, b) => {
  const R = 6371000;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLon = ((b[1] - a[1]) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a[0] * Math.PI) / 180) * Math.cos((b[0] * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};
const airDist = (a, b) => haversine(a, b) * 1.32; // przybliżony objazd ulicami

async function getJson(url, timeout = 90000) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeout) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 100)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Odpowiedź nie jest JSON-em');
  }
}

async function osrmDistances(fromIdx, toIdx, coords) {
  const coordStr = coords.map((c) => `${c[1]},${c[0]}`).join(';');
  const url =
    `${OSRM}/table/v1/foot/${coordStr}?sources=${fromIdx.join(';')}` +
    `&destinations=${toIdx.join(';')}&annotations=distance`;
  const json = await getJson(url);
  if (!json.distances) throw new Error('brak macierzy');
  return json.distances;
}

async function buildMatrix() {
  const coords = parks.map((p) => p.center);
  const n = coords.length;
  matrixStatus.phase = 'matrix';
  matrixStatus.total = Math.ceil(n / 60) ** 2;
  matrixStatus.progress = 0;

  // próbujemy wczytać cache
  const hash = crypto.createHash('sha1').update(JSON.stringify(coords)).digest('hex').slice(0, 12);
  try {
    const cached = JSON.parse(fs.readFileSync(MATRIX_FILE, 'utf8'));
    if (cached.hash === hash && cached.d.length === n) {
      matrix = cached.d.map((row) => Float64Array.from(row));
      matrixStatus.ready = true;
      matrixStatus.approx = !!cached.approx;
      matrixStatus.phase = 'ready';
      console.log(`Macierz tras wczytana z cache (${n}x${n}).`);
      return;
    }
  } catch {}

  const d = Array.from({ length: n }, () => new Float64Array(n));
  let approx = false;
  const CH = 60;
  for (let a = 0; a < n; a += CH) {
    for (let b = 0; b < n; b += CH) {
      const from = [];
      const to = [];
      for (let i = a; i < Math.min(a + CH, n); i++) from.push(i);
      for (let j = b; j < Math.min(b + CH, n); j++) to.push(j);
      let usedFallback = true;
      for (let attempt = 0; attempt < 2 && usedFallback; attempt++) {
        try {
          const block = await osrmDistances(from, to, coords);
          for (let i = 0; i < from.length; i++) {
            for (let j = 0; j < to.length; j++) {
              const v = block[i]?.[j];
              if (Number.isFinite(v)) {
                d[from[i]][to[j]] = v;
              } else {
                d[from[i]][to[j]] = airDist(coords[from[i]], coords[to[j]]);
                approx = true;
              }
            }
          }
          usedFallback = false;
        } catch (err) {
          if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
          else console.log(`  blok ${a}/${b}: ${err.message} -> przybliżenie`);
        }
      }
      if (usedFallback) {
        approx = true;
        for (const i of from) for (const j of to) d[i][j] = airDist(coords[i], coords[j]);
      }
      matrixStatus.progress++;
      if (matrixStatus.progress % 2 === 0) {
        console.log(`  macierz ${matrixStatus.progress}/${matrixStatus.total}`);
      }
    }
  }
  // symetria (pieszo w obie strony praktycznie tyle samo)
  for (let i = 0; i < n; i++) {
    d[i][i] = 0;
    for (let j = i + 1; j < n; j++) {
      const v = (d[i][j] + d[j][i]) / 2 || airDist(coords[i], coords[j]);
      d[i][j] = v;
      d[j][i] = v;
    }
  }

  matrix = d;
  matrixStatus.ready = true;
  matrixStatus.phase = 'ready';
  matrixStatus.approx = approx;
  try {
    fs.writeFileSync(MATRIX_FILE, JSON.stringify({ hash, builtAt: new Date().toISOString(), approx, d: d.map((r) => Array.from(r, (v) => Math.round(v))) }));
  } catch (err) {
    console.log('Nie udało się zapisać macierzy:', err.message);
  }
  console.log('Macierz tras gotowa.');
}

/* ------------------------------------------- odległości od punktu startu */

const startCache = new Map();
async function startRow(start) {
  const key = `${start.lat.toFixed(5)},${start.lon.toFixed(5)}`;
  if (startCache.has(key)) return startCache.get(key);
  const coords = parks.map((p) => p.center);
  const ds = new Float64Array(coords.length);

  // Valhalla: 1 źródło, maks. ~100 par na zapytanie -> paczki po 85
  let ok = true;
  const CH = 85;
  for (let i = 0; i < coords.length && ok; i += CH) {
    const targets = coords.slice(i, i + CH).map(([lat, lon]) => ({ lat, lon }));
    const body = { sources: [{ lat: start.lat, lon: start.lon }], targets, costing: 'pedestrian' };
    try {
      const json = await getJson(`${VALHALLA}/sources_to_targets?json=${encodeURIComponent(JSON.stringify(body))}`, 30000);
      const row = json.sources_to_targets?.[0] || [];
      for (let j = 0; j < targets.length; j++) {
        const item = row[j];
        ds[i + j] = item && Number.isFinite(item.distance) ? item.distance * 1000 : airDist([start.lat, start.lon], coords[i + j]);
      }
    } catch (err) {
      ok = false;
      console.log('Valhalla niedostępna, używam OSRM:', err.message);
    }
  }

  let approx = false;
  if (!ok) {
    approx = true;
    try {
      const idx = coords.map((_, i) => i);
      const row = await osrmDistances([0], idx, [[start.lat, start.lon], ...coords]);
      for (let j = 0; j < coords.length; j++) ds[j] = Number.isFinite(row[0]?.[j]) ? row[0][j] : airDist([start.lat, start.lon], coords[j]);
      approx = false;
    } catch (err) {
      console.log('OSRM też zawiódł, liczę w linii prostej:', err.message);
      for (let j = 0; j < coords.length; j++) ds[j] = airDist([start.lat, start.lon], coords[j]);
    }
  }

  const result = { ds, approx };
  if (startCache.size > 40) startCache.delete(startCache.keys().next().value);
  startCache.set(key, result);
  return result;
}

/* ------------------------------------------------------------ narzędzia */

const KIND_LABEL = Object.fromEntries(categories.map((c) => [c.id, c.label]));

function publicPark(p) {
  return {
    id: p.id,
    number: p.number,
    name: p.name,
    category: p.category,
    categoryLabel: p.categoryLabel || KIND_LABEL[p.category] || 'Park',
    color: p.color,
    hint: p.hint || '',
    detailsUrl: p.detailsUrl,
    center: p.center,
  };
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 2e6) reject(new Error('za duże'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('nieprawidłowy JSON'));
      }
    });
    req.on('error', reject);
  });
}

/* --------------------------------------------------------------- trasa */

async function handleRoute(body) {
  const start = {
    lat: Number(body.start?.lat),
    lon: Number(body.start?.lon),
    label: typeof body.start?.label === 'string' ? body.start.label.slice(0, 120) : '',
  };
  if (!Number.isFinite(start.lat) || !Number.isFinite(start.lon)) throw new Error('Brak punktu startowego');

  const wanted = Math.max(1, Math.min(30, Math.round(Number(body.n) || 5)));
  const kinds = Array.isArray(body.kinds) && body.kinds.length ? body.kinds.slice() : kindOrder.slice();
  const skipDone = body.skipDone !== false;
  const loop = !!body.loop;

  const usable = parks.filter((p) => kinds.includes(p.category) && !(skipDone && state.visited[p.id]));
  if (!usable.length) {
    return { ok: true, empty: true, total: 0, stops: [], count: 0 };
  }
  if (!matrixStatus.ready || !matrix) {
    return { ok: false, pending: true, progress: matrixStatus };
  }

  const row = await startRow(start);
  const dsAll = row.ds;
  const idxMap = usable.map((p) => parks.indexOf(p));
  const m = usable.length;
  const ds = new Float64Array(m);
  for (let i = 0; i < m; i++) ds[i] = dsAll[idxMap[i]];
  const d = Array.from({ length: m }, (_, i) => {
    const row = new Float64Array(m);
    for (let j = 0; j < m; j++) row[j] = matrix[idxMap[i]][idxMap[j]];
    return row;
  });

  const k = Math.min(wanted, m);
  const t0 = Date.now();
  const { order } = solve(m, k, ds, d, loop);
  const solveMs = Date.now() - t0;

  const stops = [];
  let cum = 0;
  let prev = -1;
  for (const i of order) {
    const legMeters = prev < 0 ? ds[i] : d[prev][i];
    cum += legMeters;
    const p = usable[i];
    stops.push({ ...publicPark(p), done: !!state.visited[p.id], legFromPrev: Math.round(legMeters), cum: Math.round(cum) });
    prev = i;
  }
  let total = cum;
  if (loop && order.length) {
    const back = ds[order[order.length - 1]];
    stops.push({
      id: '__start',
      name: 'Powrót do startu',
      center: [start.lat, start.lon],
      legFromPrev: Math.round(back),
      cum: Math.round(total + back),
      isStart: true,
    });
    total += back;
  }

  return {
    ok: true,
    start,
    loop,
    count: order.length,
    requested: wanted,
    total: Math.round(total),
    walkMinutes: Math.round(total / 78),
    approx: matrixStatus.approx || row.approx,
    solveMs,
    stops,
  };
}

const geometryCache = new Map();
async function handleGeometry(body) {
  const pts = Array.isArray(body.points) ? body.points.filter((p) => Array.isArray(p) && p.length === 2) : [];
  if (pts.length < 2) return { ok: true, coords: [] };
  const key = pts.map((p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join('|');
  if (geometryCache.has(key)) return { ok: true, coords: geometryCache.get(key) };
  const coordStr = pts.map(([lat, lon]) => `${lon},${lat}`).join(';');
  const url = `${OSRM}/route/v1/foot/${coordStr}?overview=full&geometries=geojson&steps=false`;
  try {
    const json = await getJson(url, 45000);
    const geom = json.routes?.[0]?.geometry?.coordinates || [];
    const coords = geom.map(([lon, lat]) => [lat, lon]);
    if (geometryCache.size > 60) geometryCache.delete(geometryCache.keys().next().value);
    geometryCache.set(key, coords);
    return { ok: true, coords };
  } catch (err) {
    return { ok: false, coords: [], error: err.message };
  }
}

const geocodeCache = new Map();
async function handleGeocode(lat, lon) {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  if (geocodeCache.has(key)) return geocodeCache.get(key);
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=17&accept-language=pl`;
  try {
    const json = await getJson(url, 20000);
    const addr = json.address || {};
    const label =
      addr.park ||
      addr.garden ||
      addr.leisure ||
      [addr.road || addr.pedestrian || addr.footway, addr.suburb || addr.neighbourhood].filter(Boolean).join(', ') ||
      json.display_name?.split(',')[0] ||
      '';
    geocodeCache.set(key, label);
    return label;
  } catch {
    return '';
  }
}

/* -------------------------------------------------------------- statyka */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return sendJson(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Nie znaleziono');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': rel.startsWith('/vendor/') ? 'public, max-age=604800' : 'no-cache',
    });
    res.end(buf);
  });
}

const tileInFlight = new Map();
async function serveTile(res, z, x, y) {
  const file = path.join(TILES, String(z), String(x), `${y}.png`);
  try {
    const buf = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=2592000' });
    return res.end(buf);
  } catch {}
  const key = `${z}/${x}/${y}`;
  let promise = tileInFlight.get(key);
  if (!promise) {
    promise = (async () => {
      for (const host of ['https://tile.openstreetmap.org', 'https://a.tile.openstreetmap.fr/osmfr']) {
        try {
          const r = await fetch(`${host}/${z}/${x}/${y}.png`, {
            headers: { 'User-Agent': UA, Referer: 'http://localhost' },
            signal: AbortSignal.timeout(20000),
          });
          if (r.ok) {
            const ab = Buffer.from(await r.arrayBuffer());
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, ab);
            return ab;
          }
        } catch {}
      }
      return null;
    })();
    tileInFlight.set(key, promise);
    promise.finally(() => tileInFlight.delete(key));
  }
  const buf = await promise;
  if (!buf) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=2592000' });
  res.end(buf);
}

/* --------------------------------------------------------------- serwer */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  if (!p.startsWith('/tiles/') && !/\.(js|css|png|ico|svg|woff2?)$/i.test(p)) {
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').replace('::ffff:', '');
    console.log(`REQ ${req.method} ${p} <- ${ip}`);
  }

  try {
    if (p.startsWith('/tiles/')) {
      const m = p.match(/^\/tiles\/(\d+)\/(\d+)\/(\d+)\.png$/);
      if (m) return serveTile(res, Number(m[1]), Number(m[2]), Number(m[3]));
      return sendJson(res, 404, { error: 'zły kafel' });
    }

    if (p === '/api/bootstrap') {
      return sendJson(res, 200, {
        parks: parks.map(publicPark),
        state,
        kinds: categories,
        meta: {
          count: parks.length,
          fetchedAt: parksData.fetchedAt,
          source: parksData.source,
          matrix: matrixStatus,
          today: new Date().toISOString().slice(0, 10),
        },
      });
    }

    if (p === '/api/ping') return sendJson(res, 200, { ok: true, time: new Date().toISOString() });

    if (p === '/api/network') return sendJson(res, 200, await networkInfo());

    if (p === '/api/state' && req.method === 'GET') return sendJson(res, 200, state);

    if (p === '/api/settings' && req.method === 'POST') {
      const body = await readBody(req);
      state.settings = { ...state.settings, ...body };
      saveState();
      return sendJson(res, 200, { ok: true, settings: state.settings });
    }

    if (p === '/api/visited' && req.method === 'POST') {
      const body = await readBody(req);
      const park = parkById.get(body.id);
      if (!park) return sendJson(res, 404, { ok: false, error: 'nie ma takiego parku' });
      if (body.done === false) {
        delete state.visited[park.id];
      } else {
        state.visited[park.id] = {
          doneAt: /^\d{4}-\d{2}-\d{2}$/.test(body.doneAt || '') ? body.doneAt : new Date().toISOString().slice(0, 10),
          note: typeof body.note === 'string' ? body.note.slice(0, 500) : state.visited[park.id]?.note || '',
          savedAt: new Date().toISOString(),
        };
      }
      saveState();
      return sendJson(res, 200, { ok: true, state });
    }

    if (p === '/api/visited/bulk' && req.method === 'POST') {
      const body = await readBody(req);
      const ids = [...new Set(Array.isArray(body.ids) ? body.ids : [])].filter((id) => parkById.has(id));
      if (!ids.length) return sendJson(res, 400, { ok: false, error: 'brak parków do oznaczenia' });
      const doneAt = /^\d{4}-\d{2}-\d{2}$/.test(body.doneAt || '')
        ? body.doneAt
        : new Date().toISOString().slice(0, 10);
      let added = 0;
      const now = new Date().toISOString();
      for (const id of ids) {
        if (state.visited[id]) continue;
        state.visited[id] = { doneAt, note: '', savedAt: now };
        added++;
      }
      if (added) saveState();
      return sendJson(res, 200, { ok: true, added, state });
    }

    if (p === '/api/routes' && req.method === 'POST') {
      const body = await readBody(req);
      const ids = Array.isArray(body.ids) ? body.ids.filter((id) => parkById.has(id)) : [];
      if (!ids.length) return sendJson(res, 400, { ok: false, error: 'pusta trasa' });
      const route = {
        id: crypto.randomBytes(5).toString('hex'),
        createdAt: new Date().toISOString(),
        start: body.start,
        label: String(body.label || 'Trasa').slice(0, 120),
        ids,
        total: Math.round(Number(body.total) || 0),
        walkMinutes: Math.round(Number(body.walkMinutes) || 0),
        loop: !!body.loop,
      };
      state.routes.unshift(route);
      state.routes = state.routes.slice(0, 60);
      saveState();
      return sendJson(res, 200, { ok: true, route, routes: state.routes });
    }

    if (p.startsWith('/api/routes/') && req.method === 'DELETE') {
      const id = p.split('/').pop();
      state.routes = state.routes.filter((r) => r.id !== id);
      saveState();
      return sendJson(res, 200, { ok: true, routes: state.routes });
    }

    if (p === '/api/route' && req.method === 'POST') {
      const body = await readBody(req);
      const result = await handleRoute(body);
      return sendJson(res, 200, result);
    }

    if (p === '/api/geometry' && req.method === 'POST') {
      const body = await readBody(req);
      return sendJson(res, 200, await handleGeometry(body));
    }

    if (p === '/api/geocode' && req.method === 'GET') {
      const label = await handleGeocode(Number(url.searchParams.get('lat')), Number(url.searchParams.get('lon')));
      return sendJson(res, 200, { label });
    }

    if (p.startsWith('/api/')) return sendJson(res, 404, { ok: false, error: 'nie ma takiego endpointu' });

    return serveStatic(req, res, p);
  } catch (err) {
    console.error(p, err);
    sendJson(res, 500, { ok: false, error: err.message });
  }
});

function lanAddresses() {
  const all = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) all.push(net.address);
    }
  }
  const isPrivate = (ip) =>
    /^192\.168\./.test(ip) || /^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  return [...all.filter(isPrivate), ...all.filter((ip) => !isPrivate(ip))];
}

let netCache = { time: 0, value: null };
async function networkInfo() {
  if (netCache.value && Date.now() - netCache.time < 30000) return netCache.value;

  const lan = [];
  let tailIp = null;
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      const isTail = /tailscale/i.test(name) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(net.address);
      if (isTail) tailIp = net.address;
      else lan.push(net.address);
    }
  }

  let dns = null;
  let https = null;
  try {
    const status = JSON.parse((await execFileP('tailscale', ['status', '--json'], { timeout: 4000, windowsHide: true })).stdout);
    dns = (status.Self?.DNSName || '').replace(/\.$/, '') || null;
    if (dns) {
      const cfg = JSON.parse(
        (await execFileP('tailscale', ['serve', 'status', '--json'], { timeout: 4000, windowsHide: true })).stdout || '{}'
      );
      const web = Object.keys(cfg.Web || {})[0];
      if (web) https = `https://${web.replace(/:443$/, '')}/`;
    }
  } catch {}

  const value = {
    hostname: os.hostname(),
    lan: lan.map((ip) => `http://${ip}:${PORT}`),
    vpn: tailIp ? { ip: tailIp, http: `http://${tailIp}:${PORT}`, dns, https } : null,
  };
  netCache = { time: Date.now(), value };
  return value;
}

server.listen(PORT, HOST, () => {
  const lan = lanAddresses();
  console.log('');
  console.log('  🥬  Odkrywca krakowskich parków');
  console.log(`  Lokalnie:  http://localhost:${PORT}`);
  for (const ip of lan) console.log(`  W sieci:   http://${ip}:${PORT}  (telefon w tej samej Wi-Fi)`);
  networkInfo()
    .then((net) => {
      if (net.vpn?.https) console.log(`  VPN:       ${net.vpn.https}  (Tailscale — dowolna sieć)`);
      else if (net.vpn) console.log(`  VPN:       ${net.vpn.http}  (Tailscale)`);
    })
    .catch(() => {});
  console.log('');
  buildMatrix();
  if (OPEN_BROWSER) {
    exec(`start "" "http://localhost:${PORT}"`);
  }
});
