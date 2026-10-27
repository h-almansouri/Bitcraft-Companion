// Rebuild the Map tab's track list: the resource + creature indexes from bitjita's live API, and
// untrackable.json (the types the list leaves out) from live node counts on the prism relay.
// Run: node build-map-index.js   (Node 22+; re-run after a game update or a change of season)
//
// Why this works: bitjita's /api/resources ids and /api/creatures enemyTypes are the SAME id space the
// relays use (prism's resource_location.resource_id, the bitcraftsync roster's enemy_type), so the
// indexes map 1:1 to live point data.
//
// The untrackable list keeps types with too few nodes to be worth listing out of the way (doors,
// dungeon-interior props, depleted states, drop-only rares):
//  - Every resource type the list doesn't already show (hidden last time, or new to the index) is counted
//    world-wide on the prism relay: one indexed query each, ~25k rows in all (Oct 2026). Types already
//    listed stay listed, so a build never re-downloads the million-row commons (Sticks alone is 112 MB).
//  - Hidden: fewer than MIN_NODES live nodes, or a Depleted/Hidden Resource tag whatever the count.
//  - Seasonal types are never hidden for a low count: out of season they have no nodes at all, which is
//    how a July build kept the autumn Pumpkins and Sunflowers out of the list once they spawned.
//  - Creatures aren't counted: there are ~50 types, all real animals and monsters. The ones hidden
//    before (Practice Dummy and three event/boss variants) stay hidden; new creature types are listed.
const https = require('https');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'mapassets');
const PRISM_WS = 'wss://st.prism.brico.app/v1/database/prism-relay/subscribe';
const MIN_NODES = 5;                                       // the counted types jump 3 -> 7 (Oct 2026); 15, July's cut, would split the Quarry Rock tiers
const SEASONAL = /season|summer|winter|autumn/i;           // tags "Seasonal", "Seasonal Resource", "Summer Resource"
const ALWAYS_HIDDEN = /^(Depleted Resource|Hidden Resource)$/;

function getJson(p) {
  return new Promise((resolve, reject) => {
    https.get({ hostname: 'bitjita.com', path: p, headers: { 'User-Agent': 'BitcraftCompanion/1.0', 'x-app-identifier': 'BitcraftCompanion' } }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('bad json from ' + p)); } });
    }).on('error', reject);
  });
}
const readAsset = f => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch (e) { return null; } };

// World-wide live node count per resource id. One socket, one legacy Subscribe per id in turn: each
// InitialSubscription replaces the previous set and carries just that id's rows.
function countNodes(ids) {
  return new Promise((resolve, reject) => {
    const counts = {}, todo = [...ids];
    const ws = new WebSocket(PRISM_WS, ['v1.json.spacetimedb']);
    let cur = null, req = 0;
    const next = () => {
      cur = todo.shift();
      if (cur == null){ ws.close(); resolve(counts); return; }
      ws.send(JSON.stringify({ Subscribe: { query_strings: [`SELECT * FROM resource_location WHERE resource_id = ${cur}`], request_id: ++req } }));
    };
    ws.onmessage = ev => {
      const m = JSON.parse(String(ev.data));
      if (m.IdentityToken) return next();
      if (m.InitialSubscription){
        let n = 0;
        for (const t of m.InitialSubscription.database_update.tables || []) for (const u of t.updates || []) n += (u.inserts || []).length;
        counts[cur] = n;
        if (req % 100 === 0) console.log(`  …${req} of ${ids.length}`);
        return next();
      }
      if (m.SubscriptionError){ ws.close(); reject(new Error(`relay refused the query for resource ${cur}`)); }
    };
    ws.onerror = () => reject(new Error('prism relay unreachable'));
    ws.onclose = () => { if (cur != null) reject(new Error('prism relay closed mid-count')); };
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

  // What the list showed before this build: indexed, and not hidden.
  const oldRes = readAsset('resourceIndex.json') || {}, oldUn = readAsset('untrackable.json') || {};
  const oldHidden = new Set((oldUn.resources || []).map(String)), oldHiddenCre = new Set((oldUn.enemies || []).map(String));
  const recount = Object.keys(resIndex).filter(id => !(id in oldRes) || oldHidden.has(id));
  console.log(`Counting live nodes for ${recount.length} resource types on the prism relay…`);
  const counts = await countNodes(recount);   // throws (and writes nothing) if the relay is down

  const hidden = recount.filter(id => {
    const tag = resIndex[id].tag || '';
    if (ALWAYS_HIDDEN.test(tag)) return true;
    return !SEASONAL.test(tag) && counts[id] < MIN_NODES;
  });
  const hiddenSet = new Set(hidden);
  const seasonal = Object.keys(resIndex).filter(id => SEASONAL.test(resIndex[id].tag || ''));
  const hiddenCre = Object.keys(creIndex).filter(id => oldHiddenCre.has(id));
  const untrackable = {
    _meta: {
      source: 'prism relay resource_location: live nodes world-wide, counted for every type the list did not already show (see build-map-index.js)',
      built: new Date().toISOString().slice(0, 10),
      minNodes: MIN_NODES, seasonalTags: String(SEASONAL),
      resourcesTotal: Object.keys(resIndex).length, resourcesHidden: hidden.length,
      enemiesTotal: Object.keys(creIndex).length, enemiesHidden: hiddenCre.length,
    },
    resources: hidden, enemies: hiddenCre,
    seasonal,   // the Map list says "off-season" when one of these has no nodes anywhere
  };

  fs.writeFileSync(path.join(DIR, 'resourceIndex.json'), JSON.stringify(resIndex));
  fs.writeFileSync(path.join(DIR, 'creatureIndex.json'), JSON.stringify(creIndex));
  fs.writeFileSync(path.join(DIR, 'untrackable.json'), JSON.stringify(untrackable));
  const added = recount.filter(id => !hiddenSet.has(id));
  console.log(`Wrote resourceIndex.json (${Object.keys(resIndex).length}) + creatureIndex.json (${Object.keys(creIndex).length}) + untrackable.json (${hidden.length} resources, ${hiddenCre.length} creatures hidden).`);
  if (added.length) console.log(`Newly listed (${added.length}): ` + added.map(id => `${resIndex[id].name} (${counts[id]})`).join(', '));
})().catch(e => { console.error(e.message + ' — aborting (kept existing indexes).'); process.exit(1); });
