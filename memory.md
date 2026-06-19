# Bitcraft Companion — Roadmap & Design Memory

> Living design doc so we don't lose context between sessions. Three planned work items, in build order:
> 1. **Craft-vs-Buy** feature (client-only) — BUILD FIRST
> 2. **Profit-per-Travel** feature (client-only) — BUILD SECOND
> 3. **Tier 1–2 Backend** (smart `proxy.js` + SQLite) — BUILD LAST
>
> Build the two client features first (no infra risk, immediate value), get them solid, then do the backend.

---

## App architecture (current state, for orientation)

- **Single-file app:** `C:\Bitcraft Companion App\index.html` (HTML + CSS + one big `<script>`). All client code lives here.
- **Proxy:** `proxy.js` (Node, port 3000). Today a "dumb pipe": serves `index.html`, `/crafting-data` (craftingData.json), `/mapassets/*`, and proxies `/api/*`→bitjita.com, `/bcexports/*`→exports.bitjita.com/bitcraftmap, `/bcmap/*`→bcmap-api.bitjita.com.
- **Launch configs:** `.claude/launch.json` — "Bitcraft Companion" (node proxy.js :3000) and "Bitcraft Static Preview" (npx serve :5173, autoPort). App fetches the proxy at `:3000` (CORS) regardless of where the HTML is served.
- **Verify loop:** extract last `<script>` block → `node --check`; load in Claude Preview (5173) with the proxy on 3000; check console errors.

### Key data shapes
- **Crafting** (`craftingData`, served `/crafting-data`): `items[] {id,name,description,tier,tag,rarity,rarityStr}`; `recipes[] {id,name,inputs:[{itemId,quantity}],outputs:[{itemId,quantity}],skillId,skillLevel,buildingType,buildingTier,actionsRequired,timeRequirement}`. Indexes built at load: `itemsById`, `recipesByOutput` (itemId→recipes[]), `recipesById`, `skillsById`.
- **Market list** (`/api/market?hasOrders=true`): items carry `sellOrders`/`buyOrders` as **numeric counts** (not arrays), plus `hasSellOrders/hasBuyOrders`, `tier`, `tag`, `rarity`, `rarityStr`, `itemType` (0=item,1=cargo).
- **Market detail** (`/api/market/{item|cargo}/{id}` via `fetchWithCache(type,id)`): returns `{sellOrders:[], buyOrders:[]}`. Each order: `{price, priceThreshold, quantity, claimName, settlementName, regionId, regionName}` (confirm `claimEntityId` presence at build time). Price helper used everywhere: `p = o => +(o.price||o.priceThreshold||0)`.
- **Claims** (`/bcexports/claims.geojson`, via `bcLoadGeo('claims.geojson')`): features with `properties {name, tier, entityId, has_bank, has_market, has_waystone}` + geometry → map coords via `bcFeatLatLng(f)` returning `{lat (N), lng (E)}` in map space. Player coords from `/api/players/{id}` are `locationX/locationZ`, already in the same map space.

### Important infra already in place (don't re-derive)
- `fetchWithCache(type,id)` / `isCached(type,id)` — per-item detail cache, **in-memory `Map` `_mktCache`** with 5-min TTL (moved off localStorage to fix quota exhaustion). `clearMarketCache()` clears it.
- `safeSetItem(key,val)` — quota-safe localStorage write; evicts big regenerable snapshots (`bc_market_cache_v1`, `bc_deals_cache_v1`, legacy `bc_mkt_*`) and retries. **Use this for any new persisted preference.**
- `buildBuildingSteps()` → `{gather:[{itemId,qty}], craft:[{itemId,qty,inputs:[{itemId,qty}]}]}`. `gather` = leaf/raw materials with total quantities for the whole plan. This is the backbone for Craft-vs-Buy.
- `plannerBestRecipe(itemId, preferredId?)`, `plannerRealRecipes(itemId)` (excludes unpack/research/seasonal-input recipes).
- Deals: `dealsData[]` routes `{item, sellOrder, buyOrder, profitPerUnit, maxUnits, maxProfit}`; `renderDealResults()` filters/sorts; `startDealScan()` (background-aware, non-destructive); cached to `bc_deals_cache_v1`.
- Formatting: `fmtCoin`, `fmtCount` (commas), `fmtNum` (K/M), `fmtRegion(o)`, `escHtml`.

---

## FEATURE 1 — Craft-vs-Buy  (client-only, BUILD FIRST)

**Goal:** For any craftable item, show whether it's cheaper to **craft from materials** or **buy outright** on the market — at the per-item level in the Planner, and ideally in the market item-detail popup too.

### Cost model
- **Buy cost** of item I (qty N) = N × cheapest sell price of I.
  - cheapest sell price = `min(p(o))` over `detail.sellOrders` (optionally region-filtered to a chosen region).
- **Craft cost** of item I (qty N) = Σ over leaf materials m in the recipe tree of `qty(m) × cheapest sell price(m)`.
  - Use `buildBuildingSteps()`-style recursion **scoped to a single item** (factor out a helper `craftLeafMaterials(itemId, qty)` → `{itemId:qty}` using `plannerBestRecipe`), OR run a single-item plan through the existing accReq logic.
  - Leaf materials = items with no real recipe (the `gather` set).
- **Decision:** cheaper of the two; show savings (absolute + %).

### Algorithm
1. `craftLeafMaterials(itemId, qty)` — recurse via `plannerBestRecipe`; accumulate leaf-item quantities (mirror `accReq` in `buildBuildingSteps`, single root).
2. Gather the set of itemIds needing prices = {target item} ∪ {all leaf materials}.
3. `await Promise.all(...)` `fetchWithCache` for each (in-memory cached, so repeat views are instant). Map type via `itemType`/tag (item vs cargo) — reuse the `isCargo` detection used in deals scan.
4. `cheapestSell(detail, regionId?)` helper → number or `null` if no sell orders.
5. Compute buyCost, craftCost; handle `null`s (see edge cases).

### UI
- **Planner — per plan item:** small line under each item: `Craft ≈ 1,250 ⬡ · Buy ≈ 1,800 ⬡ → Craft (save 31%)`. Color the winner.
- **Planner — total:** in the building-steps / summary header: total craft cost vs total buy cost for the whole plan.
- **(Optional, nice) Market detail popup:** if the item is craftable, add a "Craft for ≈ X (save Y)" line.
- Respect a region selector if present (reuse market region concept) — default all-regions cheapest.
- Prices are async → render a tiny "…" placeholder then fill in (don't block the planner render).

### Edge cases
- **Material has no sell listings** (pure gather item): can't price it. Show craft cost as a **partial estimate** with a marker (e.g. "+ N gathered items (no market price)") rather than pretending it's free. Make this explicit so the comparison isn't misleading.
- **Item itself has no sell listings:** show "not currently for sale — craft only".
- **No recipe:** item is gather-only; show buy price only.
- **Seasonal/blocked recipes:** already excluded by `plannerRealRecipes`.
- **Cargo vs item** id namespace: detect correctly for `fetchWithCache`.
- Don't double-count intermediate crafts — only leaf materials are bought; intermediates are crafted.

### Functions to add (names)
`craftLeafMaterials(itemId, qty)`, `cheapestSell(detail, regionId)`, `craftVsBuy(itemId, qty, regionId)` (returns `{buyCost, craftCost, craftPartial, missing[], winner, savingsPct}`), plus render hooks in planner item rows + building-steps header.

---

## FEATURE 2 — Profit-per-Travel  (client-only, BUILD SECOND)

**Goal:** Rank/inform arbitrage deals by **profit relative to travel distance** between the buy settlement and the sell settlement — not just raw profit. "+5,000 ⬡ but 4 regions away" vs "+3,000 ⬡ next door" becomes a real decision.

### Distance model
- Build a **settlement→coordinates lookup** from `claims.geojson` (loaded once; cache module-level): `claimCoords[normalizedName] = {lat,lng}` and, if orders carry `claimEntityId`, also `claimCoordsById[entityId]`.
  - Prefer exact join on `claimEntityId` if present on orders; else match `claimName` (normalized lowercased/trimmed), disambiguating by `regionId` when names collide.
- **v1 distance** = Euclidean distance in map space between sell settlement and buy settlement (`Math.hypot(dx,dy)`), in tiles. Expose as "distance" and "profit per 1,000 tiles" = `maxProfit / (dist/1000)`.
- If either settlement can't be located → distance unknown; sort such deals last / show "distance n/a".

### UI (Deals tab)
- Add a **sort toggle**: "Max profit" (current) vs "Profit / travel" (new default option, user choice). Persist choice via `safeSetItem`.
- On each deal card: add a line `~12,400 tiles · 410 ⬡ per 1k tiles` near the existing per-unit/units meta.
- When "Profit / travel" sort active, compute `profitPerDist` for each filtered deal and sort desc.
- Keep raw profit visible; this is an additional lens, not a replacement.

### Edge cases
- Same settlement buy & sell (dist 0) → infinite efficiency; treat as "local — no travel" and rank at top (or its own bucket).
- Missing coords → bucket to bottom with "n/a".
- Name collisions across regions → disambiguate by regionId.
- claims.geojson load is async — ensure the lookup is ready before computing (lazy-load + recompute on arrival, like other map data).

### v2 enhancements (note, don't build yet)
- Account for **waystone network**: claims with `has_waystone` allow ~instant travel between them. Effective distance = `min(direct, distTo(nearestWaystoneToSell) + distTo(nearestWaystoneToBuy))` (or 0 between two waystone towns). Big realism win.
- Factor player's current position (from tracked player) as the route origin.

### Functions to add (names)
`bcBuildClaimCoordLookup()` (from claims.geojson, memoized), `dealDistance(deal)` (tiles, or null), `dealProfitPerDist(deal)`, sort-mode state + persistence, render hook in `renderDealResults()` cards + a sort control in `renderDeals()`.

---

## FEATURE 3 — Tier 1–2 Backend  (BUILD LAST)

**Goal:** Make `proxy.js` "smart": shared server-side cache + precomputed deals + permanent preference storage (kills the localStorage 5MB ceiling) + price history (SQLite) for trend charts. The browser then downloads small, finished payloads instead of fetching/ computing megabytes.

### Tier 1 — Smart proxy (in-memory cache + precompute), no DB
**New responsibilities for `proxy.js`:**
1. **Server-side market cache:** fetch `/api/market?hasOrders=true` on a timer (e.g. every 2–5 min) into server memory; serve clients from it. One upstream fetch shared by all sessions/reloads/devices.
2. **Server-side deal precompute:** run the arbitrage scan on the server on a timer; expose `GET /deals` returning finished routes (already filtered to a min profit / top-N). Client deals tab just renders → instant, no client scan, far less browser memory.
   - Move the per-item detail fetching + `processItem` arbitrage logic from `startDealScan` into the server. Keep the AIMD throttle (respect 429s) server-side so only the server talks to bitjita.
3. **Preference storage:** `GET/PUT /prefs/:key` writing to a JSON file (e.g. `data/prefs.json`). Move hidden items, shopping lists, map selections off localStorage. **Cross-device sync** as a bonus; localStorage becomes a fallback/cache only.
4. **Endpoints (sketch):** `GET /market` (cached list), `GET /deals?minProfit=&region=`, `GET /item/:type/:id` (cached detail), `GET/PUT /prefs/:key`. Keep existing proxy routes as fallback.

**Client changes:** point market/deals/prefs reads at the new endpoints; keep a **direct-to-bitjita fallback** if the smart backend is down/stale (so the app degrades gracefully to today's behavior).

### Tier 2 — Add SQLite
- Add `better-sqlite3` (or similar). On each server market refresh, **snapshot prices** (item, cheapest sell, best buy, ts).
- **Unlocks:** price-history sparklines/charts per item; "is this cheap right now?" vs trailing average; trend badges; deal quality scored against history.
- Endpoints: `GET /history/:type/:id?range=`.

### Pros / Cons recap
- **Pros:** smaller client payloads → less browser memory + faster render; centralized polite rate-limiting of bitjita; no localStorage quota ceiling; cross-device prefs; historical data → charts/trends; the "background refresh / persist" features become trivial (server keeps data fresh, client just displays).
- **Cons:** `proxy.js` becomes **stateful** (can crash / hold stale cache / must be running); more to deploy & debug; for a single-user local app the *shared-cache* benefit is modest — the precompute + no-quota + history benefits are the real wins.
- **Protect:** keep **live player tracking** as a direct browser→`wss://live.bitjita.com` WebSocket. Don't route it through the backend.
- **Mitigation:** always provide a client fallback to direct bitjita calls so a down/stale backend never bricks the app.

### Migration order (when we get here)
1. Add server market cache + `GET /market`; switch client read; verify.
2. Add server deal precompute + `GET /deals`; switch deals tab; keep client scan as fallback.
3. Add `/prefs` JSON storage; migrate hidden/shopping/map prefs; keep localStorage fallback.
4. Add SQLite + price snapshots + `/history`; build history UI.

---

## Build status
- [x] Feature 1 — Craft-vs-Buy  ✅ DONE
      - Helpers: `cheapestSell(detail,region)`, `fetchItemDetailSafe(id)` (item/cargo probe + `_cvbTypeHint` cache),
        `cvbCoin` (note: `fmtCoin` already includes ⬡), `cvbLineHtml(r)`, `renderCraftVsBuy()` (token-guarded, batches
        price fetches, fills `#cvb-<itemId>` per-item lines + `#planner-cvb-total`). Reuses `flattenToRawMaterials`.
      - Wired into `renderPlanPanel()`; per-item line + total box (id `planner-cvb-total`) added to markup.
      - Behavior verified: fully-priced items show "Craft X · Buy Y → cheaper saves Z%" with green winner; partial
        craft shows "Craft ≥X*"; unlisted item → "Buy —, craft only"; gather-only mats → "Craft: mats not listed".
- [x] Feature 2 — Profit-per-Travel  ✅ DONE
      - SIMPLER than planned: market orders already carry their claim coords as `claimLocationX`/`claimLocationZ`
        (plus `claimEntityId`), so NO claims.geojson lookup is needed. Distance = `Math.hypot(dx,dz)` between the
        sell order's and buy order's claim coords.
      - Added `claimLocationX/Z` + `claimEntityId` to `trimOrderForCache` so cached deals retain coords across reload.
      - Helpers: `dealDistance(d)` (tiles or null), `dealProfitPerDist(d)` (maxProfit per 1k tiles; 0-dist→Infinity),
        `dealTravelHtml(d)` (card line). State: `dealsSortMode` ('profit'|'travel'), persisted `bc_deals_sort` via
        `safeSetItem`; setter `setDealsSort(mode)`. Sort applied in `renderDealResults` (unknown-distance → bottom).
      - UI: "Sort" dropdown in deals toolbar (Max profit | Profit / travel); travel line on each card
        ("5.0K tiles · 10.0K ⬡/1k", "same settlement — no travel", or "distance n/a"); header reflects sort mode.
      - Verified: distance math, profit/1k, sort order (incl. local→top, n/a→bottom), persistence, dropdown re-sync.
      - v2 ideas still open: waystone-network travel (`has_waystone`), route from a tracked player's position.
- [x] Feature 3 — Backend Tier 1 & 2  ✅ DONE (restart `node proxy.js` to activate)
      Additional client wiring completed after the deals work below:
        - MARKET tab → `GET /market` via `fetchMarketList()` (full cached list; renderMarketResults already
          applies buy/sell/tier/rarity filters client-side). `marketServerOk` null→true/false; falls back to
          `/api/market`. Verified: 2451 items from server, clean fallback to passthrough.
        - PREFS: `safeSetItem` now mirrors every pref to `PUT /prefs/:key` (best-effort backup; skips the big
          regenerable caches). `restorePrefsFromServer()` runs FIRST at startup (async IIFE, 1.2s timeout) and
          fills keys MISSING locally → restores a fresh/cleared browser from backup without clobbering local
          edits. Server stores values as OPAQUE STRINGS (some prefs are JSON, some bare like "market"); bulk
          `GET /prefs` returns {key:string}. `prefsServerOk` gates the mirror. ⚠️ Ordering matters: restore must
          precede the initial `switchTab` (which writes bc_tab) — fixed by the restore-first async IIFE.
          `initMarketHidden` IIFE → named `loadMarketHiddenPrefs()` so restore can re-apply it.
        - HISTORY (Tier 2, ZERO-DEP JSON chosen over SQLite): backend records a price snapshot in
          `getItemDetail` (piggybacks on existing fetches, throttled 20-min, capped 120 pts/item, flushed to
          `data/history.json` every 60s). `GET /history/(item|cargo)/:id` → {points:[{t,s,b}]}. Client shows a
          sparkline + "% vs avg / cheaper-pricier-than-usual" badge in the market item-detail view
          (`renderPriceHistory` + `priceHistoryHtml`); omitted if backend absent or <2 points.
      Verified all paths against a 3001 test proxy + the live 3000 fallback; no console errors.
      Data files: `data/prefs.json`, `data/history.json` (auto-created by the proxy; safe to delete).
      Tier 2 SQLite remains an option if history ever needs heavier querying — see note below.
      DONE (proxy.js, dependency-free, all existing routes preserved):
        - In-memory market list cache (`getMarketList`, 3-min TTL) → `GET /market` → {ts, items}.
        - Shared per-item detail cache (`getItemDetail`, 5-min TTL) → `GET /item/(item|cargo)/:id`.
        - Server-side deal precompute (`computeDeals`: ports the arbitrage logic; concurrency 8 + paced
          429-aware throttle; runs on boot + every ≤5 min) → `GET /deals` {ts,computing,scanned,total,deals}
          and `GET /deals/refresh` (force). Routes are TRIMMED incl. claimLocationX/Z (profit-per-travel).
        - Prefs storage → `GET/PUT /prefs/:key` backed by `data/prefs.json`.
        - PORT now `process.env.PORT||3000` (so a test instance can run on 3001).
        DONE (client index.html):
        - `API` is now overridable via localStorage `bc_api_override` (dev/testing).
        - Deals tab wired to backend: `loadServerDeals()` on tab open (downloads finished routes, no client
          scan), `pollServerDeals()`, `refreshServerDeals()` for the "Refresh deals" button; falls back to the
          in-browser `startDealScan()` when `/deals` is unreachable (`dealsServerOk` null→true/false).
          Verified both paths against a 3001 test proxy + the live 3000 fallback. No console errors.
      REMAINING for Tier 1:
        - Wire MARKET tab to `GET /market` (currently still uses `/api/market`; fine — client cache makes it
          fast). Needs a small client-side order-filter (buy/sell) move since `/market` returns the full list.
        - Migrate prefs (hidden items, shopping lists, map selections) to `GET/PUT /prefs/:key` with
          localStorage fallback. (Quota bug already fixed client-side, so this is sync/convenience, not urgent.)
        - ⚠️ User must restart their proxy (`node proxy.js` on :3000) to pick up the new backend; until then the
          client auto-falls back to the in-browser scan.
- [x] Feature 3 — Backend Tier 2 (price history)  ✅ DONE — folded into the Tier 1&2 entry above (zero-dep JSON).
      - Future option if history grows: swap `data/history.json` for SQLite (better-sqlite3) for time-range
        queries; the `recordHistory`/`/history` seam is isolated so only those two spots change.

## Keeping data current after a game update (procedure)
Game updates (e.g. "Uncharted Islands", 2026-06-11) add items/recipes/regions. What each data source needs:
- **Market, item detail/orders, regions, map terrain/claims/POIs/players** = LIVE from bitjita APIs → auto-update,
  no action. Verified the update did NOT change any API response shape (same keys, itemType 0/1, claimLocationX/Z).
- **Crafting/Planner/Crafts/Craft-vs-Buy** = `craftingData.json`, scraped from bitcraft-timer.com via
  `node extract-crafting-data.js`. The chunk filename is hashed and changes on every site rebuild, so the
  extractor now AUTO-DISCOVERS it (scans `/planner` + `/` for `/_next/static/chunks/*.js`, picks the one
  containing `d=[{id:` and `Assemble Empty Bucket`). Just re-run the script after an update. bitjita has
  `/api/items` (live, no recipes) — items+recipes are kept together from bitcraft-timer for ID consistency
  (both use canonical game IDs, verified). `craftingData.backup.json` is the pre-refresh rollback.
- **Map resource/enemy tracking list** = `mapassets/resourceIndex.json` (544) + `creatureIndex.json` (42),
  keyed by id → {tier,name,tag}. ✅ NOW REBUILDABLE LIVE: run `node build-map-index.js`, which pulls
  bitjita `/api/resources` (id) + `/api/creatures` (enemyType) — those ids ARE the same space bcmap-api uses
  for `/region{rid}/{resource|enemy}/{id}` (verified: resource 125=Ferns, creature enemyType 5=Nubi Goat),
  so the indexes map 1:1 to live point data. The script drops only `^TEST` dev spawns (keeps real "Depleted"
  states). This REPLACED the old fragile bitcraftmap.com SPA scrape. After the Uncharted Islands update it
  added the event resources (Beach Sand, Volcanic Rock, Tropical Grains/Tree, Peach Tree, Maker's Tree) +
  creatures (Swift Cervus, Giant Hexite Skitch); verified tracking Beach Sand in event region R3 returned
  ~28k live points. `*.backup.json` in mapassets/ are the pre-rebuild rollbacks.
  Note: a few resources (e.g. Maker's Tree, watchtower-only) have an index entry but bcmap-api has no point
  layer for them → they list but show 0 nodes when tracked (graceful, expected).
- **World events (Hexite Vault)** = NOT a resource (bcmap-api 404s its id) — served live from
  `/bcexports/events.geojson` (array of `{geometry:Point[x,y], properties:{name,timer,type:"vault-event"}}`).
  Added as its own toggleable map layer "Hexite Vaults" (default on, teal vault icon, popup shows reset
  timer countdown). `bcEventsLayer` + `bcRefreshEvents()` (rebuilds markers; auto-refreshes every 120s on the
  map tab + on visibilitychange). Registered in `bcLayerReg.events`. Verified: 4 vaults render, toggle
  persists, timer shows. If bitjita adds more world-event types to events.geojson they'll appear automatically.

## Conventions / guardrails (apply to all of the above)
- Single-file client; no build step. Validate by extracting the last `<script>` and `node --check`.
- Any new persisted preference uses `safeSetItem` (never raw `localStorage.setItem`).
- Heavy per-item market data stays in the in-memory `_mktCache` (never localStorage).
- New async UI: render a placeholder, fill when data arrives; never block a tab render on network.
- End commit messages with the Co-Authored-By trailer when committing (only when the user asks to commit).
