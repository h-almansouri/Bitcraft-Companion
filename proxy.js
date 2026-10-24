const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
// Map export hosts for /bcexports/*, primary first, as [hostname, path prefix]. prism.brico.app (BitCraftToolBox) serves
// the same file layout bitjita's old export host did — terrain re-rendered from the game daily, roads hourly, the
// GeoJSON lists every 15 minutes — while bitjita's copy still has June terrain, so it is only the fallback for when
// prism errors out. Override without a deploy: BC_EXPORT_HOSTS="host/prefix,host/prefix" (no scheme).
const BC_EXPORT_HOSTS = (process.env.BC_EXPORT_HOSTS || 'prism.brico.app,exports.bitjita.com/bitcraftmap')
  .split(',').map(s => { const t = s.trim(); const i = t.indexOf('/'); return i < 0 ? [t, ''] : [t.slice(0, i), t.slice(i)]; });
const TARGET = 'bitjita.com';
const DATA_DIR = path.join(__dirname, 'data');

// Safety net: never let a single async hiccup take down the whole service. Node 18+ EXITS the
// process on an unhandled promise rejection (and on an uncaught exception), which on a host like
// Render turns one transient error — a client aborting a proxied stream, a rejected upstream fetch —
// into a crash/restart loop (the "waking up" page that never resolves). Log and keep serving.
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', (e && e.stack) || e));
process.on('uncaughtException',  (e) => console.error('[uncaughtException]',  (e && e.stack) || e));

// ────────────────────────────────────────────────────────────────────────────
// Tier 1 backend: in-memory caches + server-side deal precompute.
// The server now does the heavy lifting (one shared market fetch, one shared item-detail cache, and
// a periodic arbitrage scan) so the browser just downloads small, finished payloads instead of
// fetching ~2400 items and computing thousands of routes itself. Everything degrades gracefully:
// the client falls back to talking to bitjita directly if these endpoints are unavailable.
// Dependency-free on purpose (only Node built-ins) so it stays "just run node proxy.js".
// ────────────────────────────────────────────────────────────────────────────

const MARKET_TTL = 15 * 60 * 1000;  // market list cache lifetime (served from cache within this window; refetched on demand after)
const DETAIL_TTL = 5 * 60 * 1000;   // per-item detail cache TTL
const DEALS_TTL  = 5 * 60 * 1000;   // recompute deals at most this often (only when the Deals tab asks)

// Fetch JSON from bitjita (same upstream + headers the passthrough uses).
function bitjitaJson(reqPath) {
  return new Promise((resolve, reject) => {
    const r = https.request({
      hostname: TARGET, path: reqPath, method: 'GET',
      headers: { 'User-Agent': 'BitcraftCompanion/1.0', 'x-app-identifier': 'BitcraftCompanion' }
    }, (apiRes) => {
      const chunks = [];
      apiRes.on('data', c => chunks.push(c));
      apiRes.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (apiRes.statusCode === 429) return reject(Object.assign(new Error('429'), { status: 429 }));
        if (apiRes.statusCode < 200 || apiRes.statusCode >= 300) return reject(new Error('HTTP ' + apiRes.statusCode));
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('bad json')); }
      });
    });
    r.on('error', reject);
    r.setTimeout(15000, () => r.destroy(new Error('timeout')));
    r.end();
  });
}

// ── Market list cache ──
let marketList = { ts: 0, items: [] };
let marketRefreshing = null;
async function getMarketList(force) {
  if (!force && marketList.items.length && (Date.now() - marketList.ts) < MARKET_TTL) return marketList.items;
  if (marketRefreshing) return marketRefreshing;       // coalesce concurrent refreshes
  marketRefreshing = (async () => {
    try {
      const d = await bitjitaJson('/api/market?hasOrders=true');
      const items = (d.data && d.data.items) ? d.data.items : (d.items || []);
      if (items.length) marketList = { ts: Date.now(), items };
    } catch (e) { /* keep stale list on failure */ }
    marketRefreshing = null;
    return marketList.items;
  })();
  return marketRefreshing;
}

// ── Per-item detail cache (used by the deal precompute) ──
const detailCache = new Map(); // `${type}_${id}` -> { ts, data }
async function getItemDetail(type, id) {
  const key = `${type}_${id}`;
  const c = detailCache.get(key);
  if (c && (Date.now() - c.ts) < DETAIL_TTL) return c.data;
  const data = await bitjitaJson(`/api/market/${type}/${id}`);
  detailCache.set(key, { ts: Date.now(), data });
  recordHistory(type, id, data); // Tier 2: snapshot prices opportunistically (no extra API calls)
  return data;
}

// ── Price history (Tier 2) ──
// Rolling per-item price snapshots, recorded whenever an item detail is (re)fetched — so it piggybacks
// on the deal precompute / client lookups with zero extra upstream load. Dependency-free JSON storage.
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const HISTORY_MIN_GAP = 20 * 60 * 1000; // at most one snapshot per item per 20 min
const HISTORY_MAX_PTS = 120;            // cap points per item (rolling window)
let history = null, historyDirty = false;
function loadHistory() { if (!history) { try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch (e) { history = {}; } } return history; }
function priceFromDetail(detail) {
  const p = o => +(o.price || o.priceThreshold || 0);
  const sells = (detail.sellOrders || []).map(p).filter(v => v > 0);
  const buys  = (detail.buyOrders  || []).map(p).filter(v => v > 0);
  return { s: sells.length ? Math.min(...sells) : null, b: buys.length ? Math.max(...buys) : null };
}
function recordHistory(type, id, detail) {
  const h = loadHistory(); const key = `${type}_${id}`;
  const arr = h[key] || (h[key] = []);
  const last = arr[arr.length - 1];
  if (last && (Date.now() - last.t) < HISTORY_MIN_GAP) return; // throttle
  const { s, b } = priceFromDetail(detail);
  if (s == null && b == null) return;
  arr.push({ t: Date.now(), s, b });
  if (arr.length > HISTORY_MAX_PTS) arr.splice(0, arr.length - HISTORY_MAX_PTS);
  historyDirty = true;
}

// POST variant of bitjitaJson, for /api/market/prices/bulk.
function bitjitaPost(reqPath, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const r = https.request({
      hostname: TARGET, path: reqPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length,
        'User-Agent': 'BitcraftCompanion/1.0', 'x-app-identifier': 'BitcraftCompanion' }
    }, (apiRes) => {
      const chunks = [];
      apiRes.on('data', c => chunks.push(c));
      apiRes.on('end', () => {
        if (apiRes.statusCode < 200 || apiRes.statusCode >= 300) return reject(new Error('HTTP ' + apiRes.statusCode));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new Error('bad json')); }
      });
    });
    r.on('error', reject);
    r.setTimeout(20000, () => r.destroy(new Error('timeout')));
    r.write(data); r.end();
  });
}

// ── Deal precompute ──
let dealsCache = { ts: 0, deals: [], computing: false, scanned: 0, total: 0 };

// Drop items that CANNOT yield a deal, before paying for their order book.
// processItem only ever profits when some settlement's buy price exceeds another's sell price. The bulk
// endpoint gives the GLOBAL lowest sell and highest buy, so if highestBuy <= lowestSell then for every
// pair bp <= highestBuy <= lowestSell <= sp — no route can profit, and the detail fetch is wasted. An
// item missing either side entirely can't arbitrage at all. Measured on the live market: the scan queue
// drops from 1216 to 296 (76% fewer detail fetches) for 13 bulk requests costing ~230ms total, and
// checking 100 items against their REAL order books found zero deals the filter would have missed.
// Fails OPEN: a batch that errors keeps its items, so a bulk outage costs speed, never deals.
async function dealsPrefilter(queue) {
  const byType = { itemIds: [], cargoIds: [] };
  const idOf = it => +(it.id || it.itemId);
  queue.forEach(it => byType[(it.itemType === 1 || it.isCargo || it.type === 'cargo') ? 'cargoIds' : 'itemIds'].push(idOf(it)));
  const batches = [];
  ['itemIds', 'cargoIds'].forEach(k => { for (let i = 0; i < byType[k].length; i += 100) batches.push({ [k]: byType[k].slice(i, i + 100) }); });
  if (!batches.length) return queue;
  const verdict = new Map();   // id -> true (keep) / false (skip); absent = unknown, so keep
  await Promise.all(batches.map(async b => {
    try {
      const d = await bitjitaPost('/api/market/prices/bulk', b);
      const rows = { ...((d.data || {}).items || {}), ...((d.data || {}).cargo || {}) };
      Object.entries(rows).forEach(([id, v]) => {
        const possible = v && v.lowestSellPrice != null && v.highestBuyPrice != null && v.highestBuyPrice > v.lowestSellPrice;
        verdict.set(+id, !!possible);
      });
    } catch (e) { /* leave this batch's ids unknown → kept */ }
  }));
  if (!verdict.size) return queue;                       // bulk entirely unavailable — scan everything
  return queue.filter(it => verdict.get(idOf(it)) !== false);
}

function trimOrder(o) {
  if (!o) return o;
  return { price: o.price, priceThreshold: o.priceThreshold, quantity: o.quantity,
    claimName: o.claimName, settlementName: o.settlementName, regionId: o.regionId, regionName: o.regionName,
    claimEntityId: o.claimEntityId, claimLocationX: o.claimLocationX, claimLocationZ: o.claimLocationZ };
}
// Per-item arbitrage: cheapest sell per settlement × best buy per settlement → every profitable route.
function processItem(item, detail, out) {
  const p = o => +(o.price || o.priceThreshold || 0);
  const sells = detail.sellOrders || [], buys = detail.buyOrders || [];
  if (!sells.length || !buys.length) return;
  const cheapestSell = {}, bestBuy = {};
  sells.forEach(o => { const s = o.claimName || o.settlementName || '__?__'; if (!cheapestSell[s] || p(o) < p(cheapestSell[s])) cheapestSell[s] = o; });
  buys.forEach(o  => { const s = o.claimName || o.settlementName || '__?__'; if (!bestBuy[s]    || p(o) > p(bestBuy[s]))    bestBuy[s]    = o; });
  const slim = { id: item.id || item.itemId, name: item.name, tier: item.tier, tag: item.tag, rarity: item.rarity, rarityStr: item.rarityStr };
  for (const sellOrder of Object.values(cheapestSell)) {
    for (const buyOrder of Object.values(bestBuy)) {
      const sp = p(sellOrder), bp = p(buyOrder);
      if (bp > sp && sp > 0) {
        const profitPerUnit = bp - sp;
        const maxUnits = Math.min(+(sellOrder.quantity || 0), +(buyOrder.quantity || 0));
        out.push({ item: slim, sellOrder: trimOrder(sellOrder), buyOrder: trimOrder(buyOrder),
          profitPerUnit, maxUnits, maxProfit: profitPerUnit * maxUnits });
      }
    }
  }
}

async function computeDeals() {
  if (dealsCache.computing) return;
  dealsCache.computing = true;
  try {
    const items = await getMarketList();
    const rough = items.filter(it => it.hasBuyOrders || (typeof it.buyOrders === 'number' ? it.buyOrders > 0 : true));
    const queue = await dealsPrefilter(rough);           // see above: provably can't drop a real deal
    dealsCache.total = queue.length; dealsCache.scanned = 0;
    const out = [];
    const CONCURRENCY = 8;
    let i = 0, minInterval = 45, nextSlot = 0;
    const reserve = async () => {
      const now = Date.now(); const start = Math.max(now, nextSlot); nextSlot = start + minInterval;
      const wait = start - now; if (wait > 0) await new Promise(r => setTimeout(r, wait));
    };
    const worker = async () => {
      while (i < queue.length) {
        const it = queue[i++];
        const type = (it.itemType === 1 || it.isCargo || it.type === 'cargo') ? 'cargo' : 'item';
        const id = it.id || it.itemId;
        const cached = detailCache.has(`${type}_${id}`) && (Date.now() - detailCache.get(`${type}_${id}`).ts) < DETAIL_TTL;
        if (!cached) await reserve();
        try { const det = await getItemDetail(type, id); processItem(it, det, out); }
        catch (e) { if (e && e.status === 429) { minInterval = Math.min(minInterval * 1.4 + 20, 400); await new Promise(r => setTimeout(r, 1200)); } }
        dealsCache.scanned++;
        if (!cached && minInterval > 45) minInterval = Math.max(minInterval - 4, 45);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    out.sort((a, b) => b.maxProfit - a.maxProfit);
    dealsCache.deals = out; dealsCache.ts = Date.now();
  } catch (e) { /* keep prior deals on failure */ }
  dealsCache.computing = false;
}
function maybeComputeDeals() {
  if (!dealsCache.computing && (Date.now() - dealsCache.ts) > DEALS_TTL) computeDeals();
}

// ── Game item definitions (name/icon/tier/rarity/tag keyed by RAW GAME item id) ──────────────
// The bitcraftsync relay returns raw game item ids; /crafting-data uses a DIFFERENT id space, so it
// can't resolve them. BitCraftToolBox mirrors the game's item_desc/cargo_desc with the right ids.
// Fetched once, slimmed to compact arrays [name, tier, rarityIdx, tag, icon], cached in RAM + on disk.
const ITEMDEFS_FILE = path.join(DATA_DIR, 'itemdefs.json');
const ITEMDEFS_TTL = 7 * 24 * 60 * 60 * 1000;   // game data only changes on patches
const GAMEDATA_PATH = '/BitCraftToolBox/BitCraft_GameData/refs/heads/sats-json/static/';
let itemDefs = null, itemDefsBuilding = null;
function ghJson(file) {
  return new Promise((resolve, reject) => {
    const r = https.get({ hostname: 'raw.githubusercontent.com', path: GAMEDATA_PATH + file, headers: { 'User-Agent': 'BitcraftCompanion/1.0' } }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); } });
    });
    r.on('error', reject);
    r.setTimeout(45000, () => r.destroy(new Error('timeout')));
  });
}
function slimDefs(rows) {
  const out = {};
  (Array.isArray(rows) ? rows : []).forEach(x => {
    if (x && x.id != null) {
      const rar = Array.isArray(x.rarity) ? x.rarity[0] : x.rarity;   // SATS sum: [index, {}]
      out[x.id] = [x.name || '', x.tier != null ? x.tier : -1, +rar || 0, x.tag || '', x.icon_asset_name || ''];
    }
  });
  return out;
}
// equipment_desc.stats → { item_id: [[statIdx, value, isPct], …] }. Each raw stat is a tuple
// [ [statIdx, {}], value, is_pct ] (the id is a SATS sum). statIdx indexes the game's stat enum.
function slimEquip(rows) {
  const out = {};
  (Array.isArray(rows) ? rows : []).forEach(x => {
    if (!x || x.item_id == null) return;
    const stats = (x.stats || []).map(s => {
      const id = Array.isArray(s[0]) ? s[0][0] : s[0];
      return [+id || 0, +s[1] || 0, s[2] ? 1 : 0];
    }).filter(s => s[1]);
    if (stats.length) out[x.item_id] = stats;
  });
  return out;
}
// building_desc → { id: name }. Only the name is kept (~37KB): the crafts tab resolves a station's
// name from its description id, and decoding building_desc over the relay would mean walking a nested
// variable-length array just to reach the name field.
function slimBuildings(rows) {
  const out = {};
  (Array.isArray(rows) ? rows : []).forEach(x => { if (x && x.id != null && x.name) out[x.id] = x.name; });
  return out;
}
// crafting_recipe_desc → { recipeId: [headlineItemId, qty, actionsRequired, isCargo] } — the game's OWN crafted_item_stacks[0].
// The scraped craftingData.json lies about some outputs: it pre-expands bundle items into their
// contents (e.g. recipe 210018 "Husk into {0}" really crafts 1x "Simple Wispweave Products" 2220023,
// but the scrape lists Seeds x3 + Filament x3 — the bundle's UNPACKED contents). bitjita headlines the
// real stack, so the crafts tab flickered between names as the fallback handed over to the relay path.
// This map is the authoritative headline; the scraped outputs stay for the Planner's crafting trees.
// Stack shape (SATS): [item_id, quantity, [type_variant, []], [durability...]] — the variant is 0 for an item, 1 for a
// cargo, and the client needs it: the two id spaces overlap. Without it the Crafts tab read cargo 1958049442 "Peerless
// Raw Pelt Package" as item 1958049442 "Sentinel's Stone Brazier" — 23 package recipes were misnamed that way.
// Each entry also carries the recipe's actions_required: the crafts tab's backstop for totalling a craft whose
// recipe is missing from the crafting data the page loaded (that file once sat two months stale, and the mushroom
// Identify crafts rendered their raw action count as "2400% complete").
function slimRecipeOuts(rows) {
  const out = {};
  (Array.isArray(rows) ? rows : []).forEach(x => {
    const s = x && Array.isArray(x.crafted_item_stacks) ? x.crafted_item_stacks[0] : null;
    if (x && x.id != null && Array.isArray(s) && s[0] != null) out[x.id] = [s[0], +s[1] || 1, +x.actions_required || 0, (Array.isArray(s[2]) ? s[2][0] : +s[2]) === 1 ? 1 : 0];
  });
  return out;
}
const RECIPE_OUTS_FORMAT = 3;   // bump with slimRecipeOuts' shape (2 = actions_required added, 3 = the cargo flag), so an older disk cache is rebuilt
// placeable_desc + placeable_growth_desc + placeable_interaction_desc → everything the Crafts tab's Placeables view
// shows about a placeable (the relay only says WHICH placeable sits where), keyed by placeable id:
//   [name, tier, kind (the game's tag: "Tree Seed", "Fishing Trap"…), icon, growth, actions]
//   growth  — null when it never changes by itself (a mature tree, a full net), else [minSecs, maxSecs, outcomes]
//             with outcomes [[chance, nextPlaceableId], …]. outcomes_v2 is a SATS option, [0, [[probability,
//             placeable_id, radius_min, radius_max], …]]; a next id of 0 means it vanishes (tree seeds and food
//             stashes go after 30s if nobody gathers them).
//   actions — [[verb, outputs, levels, results], …]: outputs [[itemId, qty, isCargo], …] (a stack is [item_id,
//             quantity, [typeVariant, []], …] — variant 1 = cargo), levels [[skillId, level], …], results = the
//             placeable ids doing it turns this one into (on_destroy_outcomes, same option shape as outcomes_v2) —
//             how the view tells "treat it or it withers" from "treating is optional".
const slimOutcomes = v => (Array.isArray(v) && v[0] === 0 && Array.isArray(v[1]) ? v[1] : []).filter(Array.isArray);
function slimPlaceables(descs, growth, acts) {
  const grow = {}, act = {}, out = {};
  (Array.isArray(growth) ? growth : []).forEach(g => {
    if (!g || g.placeable_id == null) return;
    const t = Array.isArray(g.time) ? g.time : [g.time, g.time];
    grow[g.placeable_id] = [+t[0] || 0, +t[1] || +t[0] || 0, slimOutcomes(g.outcomes_v2).map(o => [+o[0] || 0, +o[1] || 0])];
  });
  (Array.isArray(acts) ? acts : []).forEach(a => {
    if (!a || a.placeable_id == null || !a.verb_phrase) return;
    const outs = (a.output_item_stacks || []).filter(Array.isArray).map(s => [+s[0] || 0, +s[1] || 0, Array.isArray(s[2]) && s[2][0] === 1 ? 1 : 0]);
    const lv = (a.level_requirements || []).filter(Array.isArray).map(l => [+l[0] || 0, +l[1] || 0]);
    const res = [...slimOutcomes(a.on_destroy_outcomes).map(o => +o[1] || 0), +a.on_destroy_spawned_placeable_id || 0].filter(Boolean);
    (act[a.placeable_id] || (act[a.placeable_id] = [])).push([a.verb_phrase, outs, lv, res]);
  });
  (Array.isArray(descs) ? descs : []).forEach(p => {
    if (p && p.id != null) out[p.id] = [p.name || '', p.tier != null ? p.tier : -1, p.tag || '', p.icon_asset_name || '', grow[p.id] || null, act[p.id] || []];
  });
  return out;
}
const PLACEABLES_FORMAT = 2;   // bump with slimPlaceables' shape, so a disk cache in an older shape is rebuilt
async function getItemDefs() {
  if (itemDefs && (Date.now() - itemDefs.ts) < ITEMDEFS_TTL) return itemDefs;
  if (itemDefsBuilding) return itemDefsBuilding;
  itemDefsBuilding = (async () => {
    try {   // disk cache first (survives restarts; avoids a 4MB refetch on every cold start)
      const d = JSON.parse(fs.readFileSync(ITEMDEFS_FILE, 'utf8'));
      // recipeOuts and placeables must be non-empty — a build whose fetch failed writes {} and must not stick for 7
      // days (and a cache from before placeables existed, or with placeables or recipeOuts in an older shape, is rebuilt once)
      if (d && d.ts && (Date.now() - d.ts) < ITEMDEFS_TTL && d.equip && d.buildings && Object.keys(d.recipeOuts || {}).length && d.recipeOutsFormat === RECIPE_OUTS_FORMAT && Object.keys(d.placeables || {}).length && d.placeablesFormat === PLACEABLES_FORMAT) { itemDefs = d; itemDefsBuilding = null; return d; }
    } catch (e) { /* no/stale disk cache — rebuild */ }
    try {
      const [items, cargos, equip, buildings, recipes, placeDescs, placeGrowth, placeActs] = await Promise.all([ghJson('item_desc.json'), ghJson('cargo_desc.json'), ghJson('equipment_desc.json').catch(() => []), ghJson('building_desc.json').catch(() => []), ghJson('crafting_recipe_desc.json').catch(() => []), ghJson('placeable_desc.json').catch(() => []), ghJson('placeable_growth_desc.json').catch(() => []), ghJson('placeable_interaction_desc.json').catch(() => [])]);
      const built = { ts: Date.now(), items: slimDefs(items), cargos: slimDefs(cargos), equip: slimEquip(equip), buildings: slimBuildings(buildings), recipeOuts: slimRecipeOuts(recipes), recipeOutsFormat: RECIPE_OUTS_FORMAT, placeables: slimPlaceables(placeDescs, placeGrowth, placeActs), placeablesFormat: placeActs.length ? PLACEABLES_FORMAT : 0 };   // no actions = a failed fetch: don't let the disk copy stick
      itemDefs = built;
      try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(ITEMDEFS_FILE, JSON.stringify(built)); } catch (e) {}
      return built;
    } catch (e) {
      if (itemDefs) return itemDefs;                       // serve stale rather than nothing
      return { ts: 0, items: {}, cargos: {} };
    } finally { itemDefsBuilding = null; }
  })();
  return itemDefsBuilding;
}

// ── Crafting data (/crafting-data), kept current with the game data mirror ──────────────────────
// craftingData.json is a build of the game's tables (build-crafting-data.js) that only changed when someone reran
// the script by hand. By Oct 2026 it was two months behind, and crafts on newer recipes broke the Crafts tab. So
// the proxy keeps it current itself. At most hourly, and only when the app asks for /crafting-data, it HEADs the
// five source tables and compares their ETags (content hashes) with the ones the serving copy was built from. Only
// a change costs the ~17MB download and rebuild (~0.3s and ~140MB RSS, measured locally), which lands in
// data/craftingData.json. Requests never wait for it: they get the current copy, and serveFileCached's ETag hands
// browsers the new build on their next load. The committed file is the fallback for a failed or implausible build, and the only copy a free host
// keeps across restarts (data/ is wiped), so rerunning the script and committing now and then saves cold starts
// the rebuild.
const craftingBuild = require('./build-crafting-data.js');
const CRAFTING_FILE = path.join(__dirname, 'craftingData.json');   // committed
const CRAFTING_CACHE = path.join(DATA_DIR, 'craftingData.json');   // the proxy's own build, once the mirror has moved on
const CRAFTING_CHECK_EVERY = 60 * 60 * 1000;
let crafting = null;               // the copy being served: { file, extractedAt, sourceEtags, stats }
let craftingCheckedAt = 0, craftingRefreshing = null;
// Counts a truncated download or a renamed column would crater — the plausibility check below compares them.
function craftingStats(d) {
  const recipes = (d && Array.isArray(d.recipes)) ? d.recipes : [];
  return { items: (d && Array.isArray(d.items)) ? d.items.length : 0, recipes: recipes.length,
    acting: recipes.filter(r => r && r.actionsRequired > 0).length, skills: (d && Array.isArray(d.skills)) ? d.skills.length : 0 };
}
function craftingMeta(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { file, extractedAt: Date.parse(d.extractedAt) || 0, sourceEtags: d.sourceEtags || {}, stats: craftingStats(d) };
  } catch (e) { return null; }
}
// A build may replace the copy it's compared with only if no count fell by more than 10%: a patch adds or retires
// a handful of recipes, while a broken fetch or a renamed column loses thousands.
function craftingPlausible(s, base) {
  if (!s.items || !s.recipes || !s.acting || !s.skills) return false;
  return !base || ['items', 'recipes', 'acting', 'skills'].every(k => s[k] >= base[k] * 0.9);
}
function craftingCurrent() {
  if (crafting && fs.existsSync(crafting.file)) return crafting;
  const committed = craftingMeta(CRAFTING_FILE), cached = craftingMeta(CRAFTING_CACHE);
  // A cached build from an earlier run wins only if it's newer than the committed file (a deploy may have brought a
  // fresher one) and holds up next to it.
  crafting = (cached && (!committed || (cached.extractedAt > committed.extractedAt && craftingPlausible(cached.stats, committed.stats))))
    ? cached : committed;
  return crafting;
}
// Rebuild in the background if the mirror has moved past the serving copy. Never throws, never blocks a request.
function craftingMaybeRefresh() {
  if (craftingRefreshing || Date.now() - craftingCheckedAt < CRAFTING_CHECK_EVERY) return;
  craftingCheckedAt = Date.now();   // set before the attempt, so a failure waits the full hour too
  craftingRefreshing = (async () => {
    try {
      const cur = craftingCurrent(), had = (cur && cur.sourceEtags) || {};
      const now = await craftingBuild.sourceEtags();
      const files = Object.keys(now);
      // A table without an ETag can't be compared; fall back to age (same weekly horizon as /itemdefs).
      const blind = files.some(f => !now[f]) && (!cur || Date.now() - cur.extractedAt > ITEMDEFS_TTL);
      if (!files.some(f => now[f] && now[f] !== had[f]) && !blind) return;
      if (itemDefsBuilding) await itemDefsBuilding.catch(() => {});   // never parse two copies of the 10MB recipe table at once
      const { tables, etags } = await craftingBuild.fetchSources();
      const built = craftingBuild.buildCraftingData(tables, etags), stats = craftingStats(built);
      if (!craftingPlausible(stats, cur && cur.stats)) {
        console.warn('[crafting-data] rejected a rebuild that shrank:', JSON.stringify(stats), 'vs', JSON.stringify(cur && cur.stats));
        return;
      }
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(CRAFTING_CACHE + '.tmp', JSON.stringify(built));
      fs.renameSync(CRAFTING_CACHE + '.tmp', CRAFTING_CACHE);   // whole file or nothing: requests read it while we work
      crafting = { file: CRAFTING_CACHE, extractedAt: Date.parse(built.extractedAt), sourceEtags: etags, stats };
      console.log(`[crafting-data] rebuilt from game data: ${stats.recipes} recipes, ${stats.items} items`);
    } catch (e) {
      console.warn('[crafting-data] refresh failed, still serving', (crafting && crafting.file) || 'nothing', '-', e.message);
    } finally { craftingRefreshing = null; }
  })();
}

// ── gzip ────────────────────────────────────────────────────────────────────
// Every JSON response left here uncompressed, which is pure waste on a text payload: /api/crafts is
// 1.43MB raw and 192KB gzipped (87% off), and the Networth tab's market calls are ~16MB per cold load.
// zlib is built into Node, so this stays dependency-free. Only compress when the client asked and the
// body is big enough to be worth a compress cycle.
const zlib = require('zlib');
const GZIP_MIN = 1024;
function wantsGzip(req) { return /\bgzip\b/.test(req.headers['accept-encoding'] || ''); }
function sendJson(res, status, obj, req) {
  const body = Buffer.from(JSON.stringify(obj));
  if (req && wantsGzip(req) && body.length >= GZIP_MIN) {
    zlib.gzip(body, (err, gz) => {
      if (err) { res.writeHead(status, { 'Content-Type': 'application/json' }); return res.end(body); }
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding' });
      res.end(gz);
    });
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

// Serve a local file with ETag revalidation: the browser caches it but MUST revalidate, so a data
// refresh (craftingData/map indexes) reaches users immediately (304 when unchanged = cheap, full
// download only when the file actually changed). Replaces the old max-age=86400 that served stale data.
function serveFileCached(req, res, filePath, contentType) {
  let st;
  try { st = fs.statSync(filePath); } catch (e) { res.writeHead(404); res.end('Not found'); return; }
  const etag = '"' + st.size + '-' + Math.floor(st.mtimeMs) + '"';
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, { 'ETag': etag, 'Cache-Control': 'no-cache' }); res.end(); return; }
  const hdr = { 'Content-Type': contentType, 'Cache-Control': 'no-cache', 'ETag': etag };
  // /crafting-data is 4.4MB — the largest single response the app serves — and index.html is ~500KB.
  // Compressed once per request rather than cached, since these change on a data refresh and the ETag
  // above already spares repeat visitors the transfer entirely.
  if (wantsGzip(req)){
    return zlib.gzip(fs.readFileSync(filePath), (err, gz) => {
      if (err){ res.writeHead(200, hdr); return res.end(fs.readFileSync(filePath)); }
      res.writeHead(200, { ...hdr, 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding' });
      res.end(gz);
    });
  }
  res.writeHead(200, hdr);
  res.end(fs.readFileSync(filePath));
}

http.createServer((req, res) => {
  res.on('error', () => {}); // client aborted mid-response (common under bursty load) — ignore, don't crash
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Serve the app itself — for "/" and for any client-side ROUTE the browser navigates to directly.
  // The app's paths (/inventory, /crafts, /player/…) exist only inside the page; a reload, bookmark or
  // pasted link asks the server for them and must get index.html back (the app reads the path and opens
  // the right tab). Gated on `Accept: text/html` — a browser navigation — so the app's own fetch() calls
  // (Accept */*) to same-named JSON routes such as /deals and /market, and file requests (a dot in the
  // last segment), are untouched. /api/… is never a page.
  const urlPath = req.url.split('?')[0];
  const isPageNav = req.method === 'GET' && /\btext\/html\b/.test(req.headers.accept || '') && !urlPath.startsWith('/api/') && !/\.[A-Za-z0-9]+$/.test(urlPath);
  if (urlPath === '/' || urlPath === '/index.html' || isPageNav) {
    const filePath = path.join(__dirname, 'index.html');
    const data = fs.readFileSync(filePath);
    // The app is one big file, so this is the first and largest thing every visitor downloads.
    if (wantsGzip(req)){
      return zlib.gzip(data, (err, gz) => {
        if (err){ res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(data); }
        res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding' });
        res.end(gz);
      });
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
    return;
  }

  // Serve crafting data — the newest good copy, see "Crafting data" above (ignore any ?v= cache-bust query)
  if (req.url.split('?')[0] === '/crafting-data') {
    const cur = craftingCurrent();
    craftingMaybeRefresh();
    if (!cur) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'craftingData.json not found. Run: node build-crafting-data.js' }));
      return;
    }
    serveFileCached(req, res, cur.file, 'application/json');
    return;
  }


  // Serve local map assets (base image + GeoJSON datasets for the Map tab)
  if (req.url.startsWith('/mapassets/')) {
    const name = path.basename(req.url.split('?')[0]); // basename strips any path-traversal
    const filePath = path.join(__dirname, 'mapassets', name);
    if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(name).toLowerCase();
    const types = { '.webp':'image/webp', '.png':'image/png', '.svg':'image/svg+xml', '.json':'application/json', '.geojson':'application/json', '.js':'text/javascript', '.css':'text/css' };
    serveFileCached(req, res, filePath, types[ext] || 'application/octet-stream');
    return;
  }

  // ── Tier 1 backend endpoints ──────────────────────────────────────────────

  // Cached market list (shared across all clients/reloads). { ts, items }
  if (req.url === '/market' || req.url.startsWith('/market?')) {
    const force = new URL(req.url, 'http://x').searchParams.get('force') === '1';   // client "Refresh" bypasses the cache
    getMarketList(force).then(items => sendJson(res, 200, { ts: marketList.ts, items }, req))
                        .catch(() => sendJson(res, 502, { error: 'market unavailable', items: [] }, req));
    return;
  }

  // Precomputed deals. Returns the current snapshot immediately and kicks off a refresh if stale.
  if (req.url === '/deals' || req.url.startsWith('/deals?')) {
    maybeComputeDeals();
    sendJson(res, 200, { ts: dealsCache.ts, computing: dealsCache.computing,
      scanned: dealsCache.scanned, total: dealsCache.total, deals: dealsCache.deals }, req);
    return;
  }
  // Force a fresh recompute (the client "Rescan" button).
  if (req.url === '/deals/refresh') {
    computeDeals();
    sendJson(res, 200, { ts: dealsCache.ts, computing: true }, req);
    return;
  }

  // Game item definitions keyed by RAW GAME item id — lets the client resolve the item ids the
  // bitcraftsync relay returns (names/icons/tier/rarity) without calling bitjita. Long-cached + ETag,
  // so it's a one-time download per client per game patch.
  if (req.url === '/itemdefs' || req.url.startsWith('/itemdefs?')) {
    getItemDefs().then(d => {
      const etag = '"idf-' + d.ts + '"';
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { 'ETag': etag, 'Cache-Control': 'public, max-age=86400' }); res.end(); return; }
      // Hand-rolled rather than via sendJson because this route carries its own ETag/Cache-Control.
      // It's ~1MB of name/icon lookups, so it's the single biggest response the app requests.
      const body = Buffer.from(JSON.stringify({ items: d.items, cargos: d.cargos, equip: d.equip || {}, buildings: d.buildings || {}, recipeOuts: d.recipeOuts || {}, placeables: d.placeables || {} }));
      const hdr = { 'Content-Type': 'application/json', 'ETag': etag, 'Cache-Control': 'public, max-age=86400' };
      if (wantsGzip(req)){
        return zlib.gzip(body, (err, gz) => {
          if (err){ res.writeHead(200, hdr); return res.end(body); }
          res.writeHead(200, { ...hdr, 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding' });
          res.end(gz);
        });
      }
      res.writeHead(200, hdr);
      res.end(body);
    }).catch(() => sendJson(res, 502, { items: {}, cargos: {}, equip: {}, buildings: {} }, req));
    return;
  }

  // Price history for an item. /history/item/123 -> { key, points: [{t,s,b}] }
  let hm = req.url.match(/^\/history\/(item|cargo)\/([^/?]+)$/);
  if (hm) { const h = loadHistory(); sendJson(res, 200, { key: `${hm[1]}_${hm[2]}`, points: h[`${hm[1]}_${hm[2]}`] || [] }, req); return; }

  // Map exports → /bcexports/claims.geojson, /bcexports/maps/terrain/tiles/{z}/{x}/{y}.webp … Tries BC_EXPORT_HOSTS in
  // order: a connection error, timeout or non-2xx answer moves on to the next host, so a prism outage quietly serves
  // bitjita's (older) copy. In practice only the GeoJSON lists come through here — the browser loads tiles straight
  // from the host — and the lists are capped at 5 minutes in the browser cache so prism's 15-minute refresh shows up.
  if (req.url.startsWith('/bcexports/')) {
    const rel = req.url.slice('/bcexports'.length);
    const isTile = /\.webp(\?|$)/.test(req.url);
    const tryHost = (i) => {
      const [hostname, prefix] = BC_EXPORT_HOSTS[i];
      const last = i + 1 >= BC_EXPORT_HOSTS.length;
      // Lists are JSON: ask for gzip and hand it on as-is (claims + caves are ~820 KB raw, a fraction of that
      // compressed) — the map re-reads them every 15 minutes. Tiles are webp, already compressed.
      const enc = !isTile && wantsGzip(req) ? 'gzip' : 'identity';
      const exReq = https.request({ hostname, path: prefix + rel, method: 'GET', headers: { 'User-Agent': 'BitcraftCompanion/1.0', 'Accept-Encoding': enc } }, (apiRes) => {
        if ((apiRes.statusCode < 200 || apiRes.statusCode >= 300) && !last) { apiRes.resume(); tryHost(i + 1); return; }
        const ce = apiRes.headers['content-encoding'];
        res.writeHead(apiRes.statusCode, {
          'Content-Type': apiRes.headers['content-type'] || 'application/octet-stream',
          'Cache-Control': isTile ? 'public, max-age=86400' : 'public, max-age=300',
          ...(ce && ce !== 'identity' ? { 'Content-Encoding': ce, 'Vary': 'Accept-Encoding' } : {})
        });
        apiRes.pipe(res);
      });
      exReq.setTimeout(15000, () => exReq.destroy(new Error('timeout')));
      exReq.on('error', (err) => {
        if (!last) { tryHost(i + 1); return; }
        if (!res.headersSent) { res.writeHead(502); res.end(JSON.stringify({ error: err.message })); } else { try { res.end(); } catch (_) {} }
      });
      exReq.end();
    };
    tryHost(0);
    return;
  }

  // Forward the request body for methods that carry one. This passthrough was GET-only — it called
  // proxy.end() with nothing — so a POST arrived upstream with an empty body and came back
  // "400 Invalid JSON in request body". /api/market/prices/bulk needs it.
  const hasBody = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH';
  const options = {
    hostname: TARGET,
    path: req.url,
    method: req.method,
    headers: Object.assign({ 'User-Agent': 'BitcraftCompanion/1.0', 'x-app-identifier': 'BitcraftCompanion' },
      hasBody ? { 'Content-Type': req.headers['content-type'] || 'application/json' } : {})
  };

  const proxy = https.request(options, (apiRes) => {
    // The bulk of the host's egress goes through here — /api/crafts alone is 1.43MB raw, and the
    // Networth tab's per-item market calls add up to ~16MB on a cold load. Piping it through gzip
    // costs a little CPU and takes ~87% off the wire. Streamed, so nothing is buffered in memory.
    if (wantsGzip(req)) {
      res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding' });
      const gz = zlib.createGzip();
      gz.on('error', () => { try { res.end(); } catch (_) {} });
      apiRes.pipe(gz).pipe(res);
      return;
    }
    res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' });
    apiRes.pipe(res);
  });

  proxy.on('error', (err) => {
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  });

  if (hasBody) req.pipe(proxy); else proxy.end();
}).listen(PORT, () => {
  console.log(`Bitcraft proxy running on http://localhost:${PORT}`);
  // Bandwidth-lazy: no background market refresh or deal precompute. The market list is fetched on demand
  // (and cached for MARKET_TTL); deals are computed only when the Deals tab requests /deals and they're
  // stale. This avoids fetching ~2,400 market items every few minutes 24/7 whether or not anyone's using it.
  // Flush accumulated price-history snapshots to disk periodically (not on every record).
  setInterval(() => { if (historyDirty) { try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(HISTORY_FILE, JSON.stringify(history)); historyDirty = false; } catch (e) {} } }, 60 * 1000);
});
