'use strict';
/*
 * Buduje public/data/matrix.json — macierz odległości pieszych między parkami.
 * Źródło: publiczny OSRM (router.project-osrm.org). Uruchamiaj rzadko;
 * aplikacja używa gotowej macierzy i nie pyta OSRM o pary park–park.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const PARKS_FILE = path.join(ROOT, 'public', 'data', 'parks.json');
const OUT_FILE = path.join(ROOT, 'public', 'data', 'matrix.json');
const OSRM = 'https://router.project-osrm.org';

const parks = JSON.parse(fs.readFileSync(PARKS_FILE, 'utf8')).parks;
if (!Array.isArray(parks) || parks.length < 2) throw new Error('Brak parków w public/data/parks.json');

const coords = parks.map((p) => `${p.center[1]},${p.center[0]}`).join(';');
const hash = crypto.createHash('sha1').update(JSON.stringify(parks.map((p) => p.center))).digest('hex').slice(0, 12);
const url = `${OSRM}/table/v1/foot/${coords}?annotations=distance`;

async function main() {
  console.log(`Pobieram macierz ${parks.length}×${parks.length} z OSRM…`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  let json;
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'odkrywca-krakowskich-parkow/2.0 (GitHub Pages static app)',
      },
    });
    if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);
    json = await res.json();
  } finally {
    clearTimeout(timer);
  }

  const distances = json.distances;
  if (!Array.isArray(distances) || distances.length !== parks.length) {
    throw new Error('OSRM zwrócił nieoczekiwaną macierz');
  }
  const d = distances.map((row, i) => {
    if (!Array.isArray(row) || row.length !== parks.length) throw new Error(`Zły wiersz ${i}`);
    return row.map((v, j) => {
      if (i === j) return 0;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new Error(`Zła odległość ${i},${j}`);
      return Math.round(n);
    });
  });

  const payload = {
    hash,
    builtAt: new Date().toISOString(),
    approx: false,
    source: 'OSRM foot table',
    d,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload));
  console.log(`Zapisano ${OUT_FILE} (${Math.round(fs.statSync(OUT_FILE).size / 1024)} KB).`);
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
