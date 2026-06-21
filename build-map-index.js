// Rebuild the Map tab's trackable resource + creature indexes from bitjita's live API.
// Run: node build-map-index.js   (re-run after a game update to pick up new resources/enemies)
//
// Why this works: bitjita's /api/resources ids and /api/creatures enemyTypes are the SAME id space
// that bcmap-api uses for /region{rid}/{resource|enemy}/{id}, so the indexes map 1:1 to live point
// data. This replaces the old fragile bitcraftmap.com SPA scrape — the source is now live and current.
const https = require('https');
const fs = require('fs');
const path = require('path');

function getJson(p) {
  return new Promise((resolve, reject) => {
    https.get({ hostname: 'bitjita.com', path: p, headers: { 'User-Agent': 'BitcraftCompanion/1.0', 'x-app-identifier': 'BitcraftCompanion' } }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('bad json from ' + p)); } });
    }).on('error', reject);
  });
}

const isTest = name => /^TEST\b/i.test(name || ''); // drop dev/test spawns; keep real "Depleted" states

(async () => {
  console.log('Fetching resources + creatures from bitjita…');
  const [rj, cj] = await Promise.all([
    getJson('/api/resources?limit=5000'),
    getJson('/api/creatures?limit=5000'),
  ]);
  const resources = rj.resources || [];
  const creatures = cj.creatures || [];
  if (!resources.length || !creatures.length) { console.error('Empty response — aborting (kept existing indexes).'); process.exit(1); }

  const resIndex = {};
  resources.forEach(r => { if (isTest(r.name)) return; resIndex[r.id] = { tier: r.tier, name: r.name, tag: r.tag, icon: r.icon_asset_name }; });

  const creIndex = {};
  creatures.forEach(c => { if (isTest(c.name)) return; creIndex[c.enemyType] = { tier: c.tier, name: c.name, tag: c.tag, icon: c.iconAddress }; });

  const dir = path.join(__dirname, 'mapassets');
  fs.writeFileSync(path.join(dir, 'resourceIndex.json'), JSON.stringify(resIndex));
  fs.writeFileSync(path.join(dir, 'creatureIndex.json'), JSON.stringify(creIndex));
  console.log(`Wrote resourceIndex.json (${Object.keys(resIndex).length}) + creatureIndex.json (${Object.keys(creIndex).length}).`);
})();
