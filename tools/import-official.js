// Buduje public/data/parks.json z oficjalnej listy punktów Odkrywcy Krakowskich Parków.
// Źródło: https://odkrywca-parkow.pl/park_data.json
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const OUT = path.join(__dirname, '..', 'public', 'data');
const rawPath = process.argv[2] || path.join(DATA, 'official-parks.json');
const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));

const CATEGORY = {
  historical: { label: 'Historyczny', color: '#d2402e' },
  waterside: { label: 'Wodny', color: '#2563eb' },
  forest: { label: 'Leśny', color: '#2e7d32' },
  common: { label: 'Zwykły', color: '#2b2b2b' },
};

const parks = raw
  .slice()
  .sort((a, b) => a.id - b.id)
  .map((p) => {
    const cat = CATEGORY[p.category] ? p.category : 'common';
    return {
      id: `p${p.id}`,
      number: p.id,
      name: String(p.name).trim(),
      category: cat,
      categoryLabel: CATEGORY[cat].label,
      color: CATEGORY[cat].color,
      hint: (p.hint || '').trim(),
      detailsUrl: p.detailsUrl || 'https://zzm.krakow.pl/lista-parkow.html',
      center: [Number(p.coordinates.latitude), Number(p.coordinates.longitude)],
    };
  })
  .filter((p) => Number.isFinite(p.center[0]) && Number.isFinite(p.center[1]));

const payload = {
  fetchedAt: new Date().toISOString(),
  source: 'odkrywca-parkow.pl (park_data.json) — punkty ZZM Kraków',
  count: parks.length,
  categories: Object.entries(CATEGORY).map(([id, c]) => ({
    id,
    label: c.label,
    color: c.color,
    count: parks.filter((p) => p.category === id).length,
  })),
  parks,
};

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'parks.json'), JSON.stringify(payload, null, 1));
console.log(`Zapisano ${parks.length} punktów w public/data/parks.json.`);
console.log(payload.categories);
