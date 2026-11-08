// Fetches vacant / abandoned buildings in the Phoenix metro from OpenStreetMap (Overpass)
// and writes them to osm.json so the app and the export page load instantly.
// Run nightly by .github/workflows/osm.yml. Usage: node scripts/fetch-osm.mjs
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const METRO = { s: 33.20, w: -112.65, n: 33.80, e: -111.50 };
const b = `${METRO.s},${METRO.w},${METRO.n},${METRO.e}`;
const q = `[out:json][timeout:180];(nwr["shop"="vacant"](${b});nwr["disused:shop"](${b});nwr["disused:amenity"](${b});nwr["abandoned:shop"](${b});nwr["abandoned:amenity"](${b});nwr["abandoned:building"](${b});nwr["building"]["disused"="yes"](${b});nwr["building"]["abandoned"="yes"](${b});nwr["vacant"="yes"](${b});nwr["disused"="yes"]["shop"](${b}););out tags center;`;

let elements = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
outer: for (let attempt = 0; attempt < 4 && !elements; attempt++) {
  for (const url of OVERPASS) {
    try {
      console.log('trying', url, 'attempt', attempt + 1);
      const r = await fetch(url, { method: 'POST', body: q, headers: { 'Content-Type': 'text/plain', 'User-Agent': 'valley-lot-finder/1.0 (github actions; nightly vacant-buildings refresh)' }, signal: AbortSignal.timeout(240000) });
      if (!r.ok) { console.log('  status', r.status); continue; }
      elements = (await r.json()).elements; break outer;
    } catch (e) { console.log('  failed:', e.message); }
  }
  console.log('all mirrors busy, waiting 45s…'); await sleep(45000);
}
if (!elements) {
  console.error('All Overpass mirrors failed — keeping the previous osm.json');
  process.exit(existsSync('osm.json') ? 0 : 1);
}

const lots = [];
for (const el of elements) {
  const t = el.tags || {}; const c = el.center || (el.lat != null ? { lat: el.lat, lon: el.lon } : null); if (!c) continue;
  const kind = t['disused:shop'] || t['abandoned:shop'] || t['disused:amenity'] || t['abandoned:amenity'] || t['abandoned:building'] || t.shop || t.building || t.amenity;
  if (!kind || /railway|pipeline|canal|mine|quarry/.test(kind)) continue;
  const abandoned = !!(t['abandoned:shop'] || t['abandoned:amenity'] || t['abandoned:building'] || t.abandoned === 'yes');
  const addr = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
  lots.push({
    id: 'osm-' + el.type + el.id,
    name: t.name || (t['old_name'] ? `Former ${t['old_name']}` : `${abandoned ? 'Abandoned' : 'Vacant'} ${String(kind).replace(/_/g, ' ')}`),
    address: addr ? `${addr}${t['addr:city'] ? ', ' + t['addr:city'] : ''}` : 'Address not mapped',
    lat: +c.lat.toFixed(6), lng: +c.lon.toFixed(6),
    status: abandoned ? 'abandoned' : 'vacant',
    note: `Tagged on OpenStreetMap as ${abandoned ? 'abandoned' : 'vacant/disused'}${t['old_name'] ? ' (formerly ' + t['old_name'] + ')' : ''}. Community-mapped — confirm on site.`,
    source: { label: 'OpenStreetMap (© OSM contributors, ODbL)', url: `https://www.openstreetmap.org/${el.type}/${el.id}` }
  });
}
lots.sort((a, b2) => a.id.localeCompare(b2.id));
const out = { updated: new Date().toISOString(), count: lots.length, lots };
const prev = existsSync('osm.json') ? JSON.parse(readFileSync('osm.json', 'utf8')) : null;
if (prev && JSON.stringify(prev.lots) === JSON.stringify(lots)) { console.log('no change,', lots.length, 'lots'); process.exit(0); }
writeFileSync('osm.json', JSON.stringify(out));
console.log('wrote osm.json with', lots.length, 'lots');
