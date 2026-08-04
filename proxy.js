const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const TARGET = 'bitjita.com';
const DATA_DIR = path.join(__dirname, 'data');

// Safety net: never let a single async hiccup take down the whole service. Node 18+ EXITS the
// process on an unhandled promise rejection (and on an uncaught exception), which on a host like
// Render turns one transient error — a client aborting a proxied stream, a rejected upstream fetch —
// into a crash/restart loop (the "waking up" page that never resolves). Log and keep serving.
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', (e && e.stack) || e));
process.on('uncaughtException',  (e) => console.error('[uncaughtException]',  (e && e.stack) || e));

// ────────────────────────────────────────────────────────────────────────────
// Tier 1 backend: in-memory caches + server-side deal precompute + prefs storage.
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

// ── Per-item detail cache (shared by the precompute and /item) ──
const detailCache = new Map(); // `${type}_${id}` -> { ts, data }
let mkt429 = 0;
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

// ── Deal precompute ──
let dealsCache = { ts: 0, deals: [], computing: false, scanned: 0, total: 0 };

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
    const queue = items.filter(it => it.hasBuyOrders || (typeof it.buyOrders === 'number' ? it.buyOrders > 0 : true));
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
        catch (e) { if (e && e.status === 429) { mkt429++; minInterval = Math.min(minInterval * 1.4 + 20, 400); await new Promise(r => setTimeout(r, 1200)); } }
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
async function getItemDefs() {
  if (itemDefs && (Date.now() - itemDefs.ts) < ITEMDEFS_TTL) return itemDefs;
  if (itemDefsBuilding) return itemDefsBuilding;
  itemDefsBuilding = (async () => {
    try {   // disk cache first (survives restarts; avoids a 4MB refetch on every cold start)
      const d = JSON.parse(fs.readFileSync(ITEMDEFS_FILE, 'utf8'));
      if (d && d.ts && (Date.now() - d.ts) < ITEMDEFS_TTL && d.equip && d.buildings) { itemDefs = d; itemDefsBuilding = null; return d; }
    } catch (e) { /* no/stale disk cache — rebuild */ }
    try {
      const [items, cargos, equip, buildings] = await Promise.all([ghJson('item_desc.json'), ghJson('cargo_desc.json'), ghJson('equipment_desc.json').catch(() => []), ghJson('building_desc.json').catch(() => [])]);
      const built = { ts: Date.now(), items: slimDefs(items), cargos: slimDefs(cargos), equip: slimEquip(equip), buildings: slimBuildings(buildings) };
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

// ── Preference storage (JSON file; survives reloads, cross-device, no localStorage quota) ──
function prefsPath() { return path.join(DATA_DIR, 'prefs.json'); }
function readPrefs() {
  try { return JSON.parse(fs.readFileSync(prefsPath(), 'utf8')); } catch (e) { return {}; }
}
function writePrefs(obj) {
  try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(prefsPath(), JSON.stringify(obj)); return true; }
  catch (e) { return false; }
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Serve the app itself
  if (req.url === '/' || req.url === '/index.html') {
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

  // Serve local crafting data (ignore any ?v= cache-bust query)
  if (req.url.split('?')[0] === '/crafting-data') {
    const filePath = path.join(__dirname, 'craftingData.json');
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'craftingData.json not found. Run: node extract-crafting-data.js' }));
      return;
    }
    serveFileCached(req, res, filePath, 'application/json');
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

  // Server-cached item/cargo detail. /item/item/123 or /item/cargo/123
  let m = req.url.match(/^\/item\/(item|cargo)\/([^/?]+)$/);
  if (m) {
    getItemDetail(m[1], m[2]).then(data => sendJson(res, 200, data, req))
                             .catch(() => sendJson(res, 502, { error: 'detail unavailable' }, req));
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
      const body = Buffer.from(JSON.stringify({ items: d.items, cargos: d.cargos, equip: d.equip || {}, buildings: d.buildings || {} }));
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

  // Bulk prefs (used by the client at startup to restore from backup). Returns { key: rawString }.
  if (req.url === '/prefs') { sendJson(res, 200, readPrefs(), req); return; }

  // Per-key prefs. Values are stored as OPAQUE STRINGS — the exact localStorage value — so the client
  // can mirror/restore with perfect fidelity (some values are JSON, some are bare strings like "market").
  let pm = req.url.match(/^\/prefs\/([^/?]+)$/);
  if (pm) {
    const key = decodeURIComponent(pm[1]);
    if (req.method === 'GET') {
      const all = readPrefs();
      sendJson(res, 200, { key, value: key in all ? all[key] : null }, req);
      return;
    }
    if (req.method === 'PUT') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const value = Buffer.concat(chunks).toString('utf8'); // store verbatim
        const all = readPrefs(); all[key] = value;
        sendJson(res, writePrefs(all) ? 200 : 500, { ok: true, key }, req);
      });
      return;
    }
  }

  // Price history for an item. /history/item/123 -> { key, points: [{t,s,b}] }
  let hm = req.url.match(/^\/history\/(item|cargo)\/([^/?]+)$/);
  if (hm) { const h = loadHistory(); sendJson(res, 200, { key: `${hm[1]}_${hm[2]}`, points: h[`${hm[1]}_${hm[2]}`] || [] }, req); return; }

  // Proxy bitjita's map exports (terrain tiles + live GeoJSON) → /bcexports/maps/terrain/tiles/{z}/{x}/{y}.webp, /bcexports/claims.geojson
  if (req.url.startsWith('/bcexports/')) {
    const exReq = https.request({
      hostname: 'exports.bitjita.com',
      path: '/bitcraftmap' + req.url.slice('/bcexports'.length),
      method: 'GET',
      headers: { 'User-Agent': 'BitcraftCompanion/1.0' }
    }, (apiRes) => {
      const isTile = /\.webp(\?|$)/.test(req.url);   // terrain/road tiles never change → cache hard
      res.writeHead(apiRes.statusCode, {
        'Content-Type': apiRes.headers['content-type'] || 'application/octet-stream',
        'Cache-Control': isTile ? 'public, max-age=604800, immutable' : (apiRes.headers['cache-control'] || 'max-age=3600')
      });
      apiRes.pipe(res);
    });
    exReq.on('error', (err) => { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); });
    exReq.end();
    return;
  }

  // Proxy the bitcraftmap data backend (live resources/enemies by region) → /bcmap/region7/resource/1
  if (req.url.startsWith('/bcmap/')) {
    const bcReq = https.request({
      hostname: 'bcmap-api.bitjita.com',
      path: req.url.slice('/bcmap'.length),
      method: 'GET',
      headers: { 'User-Agent': 'BitcraftCompanion/1.0' }
    }, (apiRes) => {
      res.writeHead(apiRes.statusCode, { 'Content-Type': apiRes.headers['content-type'] || 'application/json' });
      apiRes.pipe(res);
    });
    bcReq.on('error', (err) => { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); });
    bcReq.end();
    return;
  }

  const options = {
    hostname: TARGET,
    path: req.url,
    method: req.method,
    headers: { 'User-Agent': 'BitcraftCompanion/1.0', 'x-app-identifier': 'BitcraftCompanion' }
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

  proxy.end();
}).listen(PORT, () => {
  console.log(`Bitcraft proxy running on http://localhost:${PORT}`);
  // Bandwidth-lazy: no background market refresh or deal precompute. The market list is fetched on demand
  // (and cached for MARKET_TTL); deals are computed only when the Deals tab requests /deals and they're
  // stale. This avoids fetching ~2,400 market items every few minutes 24/7 whether or not anyone's using it.
  // Flush accumulated price-history snapshots to disk periodically (not on every record).
  setInterval(() => { if (historyDirty) { try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(HISTORY_FILE, JSON.stringify(history)); historyDirty = false; } catch (e) {} } }, 60 * 1000);
});
