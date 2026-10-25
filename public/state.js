'use strict';
/*
 * Lokalny magazyn danych aplikacji: walidacja, scalanie, import/eksport.
 * Ten moduł nie dotyka DOM ani sieci — dzięki temu można go testować osobno.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ParkState = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const STORAGE_KEY = 'odkrywca-parkow.state.v1';
  const STORAGE_VERSION = 2;
  const MAX_ROUTES = 200;
  const MAX_ROUTE_STOPS = 30;
  const DEFAULT_START = { lat: 50.0617, lon: 19.9373, label: 'Rynek Główny' };

  // Aplikacja dotyczy Krakowa; odrzucamy start spoza sensownego obszaru.
  const AREA = { minLat: 49.7, maxLat: 50.45, minLon: 19.5, maxLon: 20.35 };

  function cleanText(value, max = 120) {
    if (typeof value !== 'string') return '';
    return value
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max);
  }

  function clampInt(value, min, max, fallback) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  function cleanDate(value) {
    if (typeof value !== 'string') return null;
    const m = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const date = new Date(Date.UTC(y, mo - 1, d));
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
    return `${m[1]}-${m[2]}-${m[3]}`;
  }

  function cleanIso(value) {
    if (typeof value !== 'string') return null;
    const t = Date.parse(value);
    if (!Number.isFinite(t)) return null;
    return new Date(t).toISOString();
  }

  function cleanStart(raw, fallback) {
    const base = fallback || DEFAULT_START;
    if (!raw || typeof raw !== 'object') return { ...base };
    const lat = Number(raw.lat);
    const lon = Number(raw.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { ...base };
    if (lat < AREA.minLat || lat > AREA.maxLat || lon < AREA.minLon || lon > AREA.maxLon) return { ...base };
    return { lat, lon, label: cleanText(raw.label, 120) || 'Wybrany punkt' };
  }

  function defaultSettings(categories = []) {
    return {
      n: 5,
      kinds: categories.map((c) => c.id),
      skipDone: true,
      loop: false,
      start: { ...DEFAULT_START },
    };
  }

  function defaultState(categories = []) {
    return { version: STORAGE_VERSION, visited: {}, routes: [], settings: defaultSettings(categories) };
  }

  function cleanSettings(raw, categoryIds, fallback) {
    const out = { ...fallback };
    if (!raw || typeof raw !== 'object') return out;
    out.n = clampInt(raw.n, 1, 20, fallback.n);
    out.skipDone = raw.skipDone !== false;
    out.loop = !!raw.loop;
    out.start = cleanStart(raw.start, fallback.start);
    out.kinds = Array.isArray(raw.kinds) ? [...new Set(raw.kinds.filter((k) => categoryIds.has(k)))] : [];
    if (!out.kinds.length) out.kinds = [...categoryIds];
    return out;
  }

  function cleanVisited(raw, parkIds) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const id of Object.keys(raw)) {
      if (!parkIds.has(id)) continue;
      const value = raw[id];
      const rec = typeof value === 'string' ? { doneAt: value } : value;
      if (!rec || typeof rec !== 'object') continue;
      const doneAt = cleanDate(rec.doneAt);
      if (!doneAt) continue;
      out[id] = { doneAt, note: cleanText(rec.note, 500) };
      const savedAt = cleanIso(rec.savedAt);
      if (savedAt) out[id].savedAt = savedAt;
    }
    return out;
  }

  function makeId(used) {
    let id;
    do {
      id =
        'r' +
        Math.random().toString(36).slice(2, 8) +
        Math.random().toString(36).slice(2, 6);
    } while (used.has(id));
    return id;
  }

  function cleanRoute(raw, parkIds, fallbackStart, used) {
    if (!raw || typeof raw !== 'object') return null;
    let ids = Array.isArray(raw.ids)
      ? raw.ids.filter((id) => typeof id === 'string' && parkIds.has(id))
      : [];
    ids = [...new Set(ids)].slice(0, MAX_ROUTE_STOPS);
    if (!ids.length) return null;

    const id = /^[A-Za-z0-9_-]{4,40}$/.test(raw.id || '') ? raw.id : makeId(used);
    const total = Number(raw.total);
    const totalSafe = Number.isFinite(total) ? Math.max(0, Math.min(total, 1e7)) : 0;
    const walk = Number(raw.walkMinutes);

    return {
      id,
      createdAt: cleanIso(raw.createdAt) || new Date().toISOString(),
      start: cleanStart(raw.start, fallbackStart),
      label: cleanText(raw.label, 120) || 'Trasa',
      ids,
      total: totalSafe,
      walkMinutes: Number.isFinite(walk) ? Math.max(0, Math.min(Math.round(walk), 100000)) : Math.round(totalSafe / 78),
      loop: !!raw.loop,
    };
  }

  /**
   * Zamienia dowolny (także uszkodzony lub wrogi) obiekt na bezpieczny stan.
   * @param {any} raw
   * @param {{parks: Array<{id:string}>, categories: Array<{id:string}>}} ctx
   */
  function sanitizeState(raw, ctx = {}) {
    const parks = Array.isArray(ctx.parks) ? ctx.parks : [];
    const categories = Array.isArray(ctx.categories) ? ctx.categories : [];
    const parkIds = new Set(parks.map((p) => p.id));
    const categoryIds = new Set(categories.map((c) => c.id));
    const fallback = defaultState(categories);
    const warnings = [];

    let src = raw;
    if (src && typeof src === 'object' && !Array.isArray(src) && src.data && typeof src.data === 'object') {
      src = src.data;
    }
    if (!src || typeof src !== 'object' || Array.isArray(src)) {
      return { ...fallback, warnings: ['Nieprawidłowy format danych'] };
    }

    const settings = cleanSettings(src.settings, categoryIds, fallback.settings);
    const visited = cleanVisited(src.visited, parkIds);

    const rawVisitedCount =
      src.visited && typeof src.visited === 'object' && !Array.isArray(src.visited)
        ? Object.keys(src.visited).length
        : 0;
    const skippedVisits = rawVisitedCount - Object.keys(visited).length;
    if (skippedVisits > 0) {
      warnings.push(`Pominięto ${skippedVisits} nieprawidłowych wpisów odwiedzin`);
    }

    const routes = [];
    const used = new Set();
    const rawRoutes = Array.isArray(src.routes) ? src.routes : [];
    for (const item of rawRoutes.slice(0, MAX_ROUTES * 2)) {
      const route = cleanRoute(item, parkIds, settings.start, used);
      if (!route) {
        warnings.push('Pominięto nieprawidłową trasę');
        continue;
      }
      if (used.has(route.id)) route.id = makeId(used);
      used.add(route.id);
      routes.push(route);
      if (routes.length >= MAX_ROUTES) break;
    }
    if (rawRoutes.length > routes.length) {
      const skipped = rawRoutes.length - routes.length;
      if (skipped > 0) warnings.push(`Pominięto ${skipped} tras (limit lub błędy)`);
    }

    return { version: STORAGE_VERSION, visited, routes, settings, warnings };
  }

  function mergeStates(current, incoming) {
    const visited = { ...current.visited };
    for (const [id, value] of Object.entries(incoming.visited || {})) {
      if (!visited[id]) visited[id] = value;
    }
    const routes = Array.isArray(current.routes) ? current.routes.slice() : [];
    const ids = new Set(routes.map((r) => r.id));
    for (const route of incoming.routes || []) {
      if (ids.has(route.id)) continue;
      routes.push(route);
      ids.add(route.id);
      if (routes.length >= MAX_ROUTES) break;
    }
    return {
      version: STORAGE_VERSION,
      visited,
      routes,
      settings: { ...current.settings },
    };
  }

  function exportPayload(state) {
    return {
      app: 'odkrywca-parkow',
      version: STORAGE_VERSION,
      exportedAt: new Date().toISOString(),
      visited: state.visited,
      routes: state.routes,
      settings: state.settings,
    };
  }

  function load(ctx = {}) {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { state: defaultState(ctx.categories), fresh: true };
      const parsed = JSON.parse(raw);
      const state = sanitizeState(parsed, ctx);
      return { state, fresh: false };
    } catch (err) {
      return {
        state: defaultState(ctx.categories),
        error: err && err.message ? err.message : 'Nie udało się wczytać danych',
      };
    }
  }

  function save(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(exportPayload(state)));
      return true;
    } catch {
      return false;
    }
  }

  function summary(state) {
    return {
      visited: Object.keys(state.visited || {}).length,
      routes: (state.routes || []).length,
      n: state.settings?.n || 5,
    };
  }

  return {
    STORAGE_KEY,
    STORAGE_VERSION,
    DEFAULT_START,
    sanitizeState,
    mergeStates,
    exportPayload,
    defaultState,
    defaultSettings,
    load,
    save,
    summary,
    cleanText,
  };
});
