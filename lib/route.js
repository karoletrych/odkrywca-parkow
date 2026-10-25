'use strict';
// Heurystyka wyznaczania trasy pieszej: wybór k parków + kolejność zwiedzania.
// Koszty to rzeczywiste odległości z sieci dróg (macierz), nie linie proste.

function makeLeg(ds, d) {
  // -1 = punkt startowy
  return (a, b) => {
    if (a < 0 && b < 0) return 0;
    if (a < 0) return ds[b];
    if (b < 0) return ds[a];
    return d[a][b];
  };
}

function pathLength(path, leg, loop) {
  let total = 0;
  for (let i = 0; i < path.length; i++) {
    total += leg(i === 0 ? -1 : path[i - 1], path[i]);
  }
  if (loop && path.length) total += leg(path[path.length - 1], -1);
  return total;
}

function twoOpt(path, leg, loop, maxPasses = 40) {
  const n = path.length;
  const p = path.slice();
  let passes = 0;
  let improved = true;
  while (improved && passes++ < maxPasses) {
    improved = false;
    outer: for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const before = i === 0 ? -1 : p[i - 1];
        const after = j + 1 < n ? p[j + 1] : null;
        const a = p[i];
        const b = p[j];
        let delta = leg(before, b) - leg(before, a);
        if (after !== null) delta += leg(a, after) - leg(b, after);
        else if (loop) delta += leg(a, -1) - leg(b, -1);
        if (delta < -0.5) {
          // odwróć fragment i..j
          for (let x = i, y = j; x < y; x++, y--) {
            const t = p[x];
            p[x] = p[y];
            p[y] = t;
          }
          improved = true;
          break outer;
        }
      }
    }
  }
  return p;
}

// Wstawianie najmniejszym kosztem: od startu dokładamy za każdym razem park,
// który najmniej wydłuża trasę (i wstawiamy go w najlepsze miejsce).
function cheapestInsertion(leg, m, k, loop, seed) {
  const path = [];
  const used = new Uint8Array(m);
  if (seed != null) {
    path.push(seed);
    used[seed] = 1;
  }
  while (path.length < k) {
    let bestCost = Infinity;
    let bestPark = -1;
    let bestPos = 0;
    for (let p = 0; p < m; p++) {
      if (used[p]) continue;
      for (let pos = 0; pos <= path.length; pos++) {
        const prev = pos === 0 ? -1 : path[pos - 1];
        const next = pos === path.length ? null : path[pos];
        let cost = leg(prev, p);
        if (next !== null) cost += leg(p, next) - leg(prev, next);
        else if (loop) cost += leg(p, -1);
        if (cost < bestCost) {
          bestCost = cost;
          bestPark = p;
          bestPos = pos;
        }
      }
    }
    if (bestPark < 0) break;
    path.splice(bestPos, 0, bestPark);
    used[bestPark] = 1;
  }
  return path;
}

/** Zamienia jeden przystanek na park spoza trasy, jeśli skraca całość. */
function exchange(path, leg, loop, m, rounds = 2) {
  let best = path.slice();
  let bestLen = pathLength(best, leg, loop);
  const inPath = new Set(best);
  for (let round = 0; round < rounds; round++) {
    let improved = false;
    for (let i = 0; i < best.length; i++) {
      // kandydaci: najbliżsi sieciowo względem obecnego przystanku
      const cands = [];
      for (let u = 0; u < m; u++) {
        if (inPath.has(u)) continue;
        cands.push([leg(best[i], u), u]);
      }
      cands.sort((a, b) => a[0] - b[0]);
      const limit = Math.min(cands.length, 24);
      for (let c = 0; c < limit; c++) {
        const u = cands[c][1];
        const trial = best.slice();
        trial[i] = u;
        const opt = twoOpt(trial, leg, loop, 8);
        const len = pathLength(opt, leg, loop);
        if (len < bestLen - 0.5) {
          best = opt;
          bestLen = len;
          inPath.delete(path[i]);
          inPath.add(u);
          improved = true;
          break;
        }
      }
    }
    if (!improved) break;
  }
  return best;
}

/**
 * @param {number} m liczba dostępnych parków
 * @param {number} k ile chcemy odwiedzić
 * @param {Float64Array} ds odległości start -> park
 * @param {number[][]} d macierz park <-> park
 * @param {boolean} loop czy wracamy do startu
 */
function solve(m, k, ds, d, loop) {
  k = Math.max(1, Math.min(k, m));
  const leg = makeLeg(ds, d);

  // kandydaci na pierwszy przystanek: kilka najbliższych startowi
  const seeds = [...ds.keys()].sort((a, b) => ds[a] - ds[b]).slice(0, Math.min(6, m));

  let best = null;
  let bestLen = Infinity;

  for (const seed of seeds) {
    const path = cheapestInsertion(leg, m, k, loop, seed);
    const opt = twoOpt(path, leg, loop);
    const len = pathLength(opt, leg, loop);
    if (len < bestLen) {
      bestLen = len;
      best = opt;
    }
  }

  // druga faza: wymiana przystanków na lepsze + dopracowanie kolejności
  best = exchange(best, leg, loop, m);
  best = twoOpt(best, leg, loop);
  bestLen = pathLength(best, leg, loop);

  return { order: best, total: bestLen, leg };
}

module.exports = { solve };
