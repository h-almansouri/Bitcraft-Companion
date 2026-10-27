# Live Map Data — prism-relay (SpacetimeDB) integration plan

Goal: replace the Map tab's 60-second aggregate REST poll (`bcmap-api`) with a **live** feed of
animals + resource nodes, using the community-run **`prism-relay`** SpacetimeDB relay that
[bitcraftmap](https://github.com/BitCraftToolBox/bitcraftmap) uses. This gives us per-entity IDs,
region filtering, and instant spawn/move/kill/harvest/respawn updates — the thing REST can't do.

Usage has been cleared with the relay operator (Brico). Reference implementation:
`BitCraftToolBox/bitcraftmap` (`src/lib/services/relay-service.ts`, `src/relay-bindings/`).

## What we get

**Relay:** `st.prism.brico.app`, database/module **`prism-relay`**, via the **`spacetimedb`** SDK (v2.x).
Auth is **anonymous** — the relay issues an identity token on first connect; we store it and reuse it on
reconnect (no game credentials).

**Tables (exact schemas, from the generated bindings):**

| Table | Fields | Use |
|---|---|---|
| `enemy_location` | `entityId u64 PK, enemyType i32, x i32, z i32, regionId u8` | live animals — insert=spawn, update=move, delete=killed/despawn |
| `resource_location` | `entityId u64 PK, resourceId i32, regionId u8, x i32, z i32` | resource nodes currently UP — delete=harvested |
| `growth_timers` | `entityId u64 PK, resourceId i32, x i32, z i32, regionId u8, endTimestamp` | depleted nodes + when they respawn |
| `player_location` | `entityId u64 PK, x i32, z i32, regionId u8` | (optional) players |
| `player_state` | `entityId u64 PK, regionId u8, online bool, name string` | (optional) players |

- `enemyType` / `resourceId` are **type** ids → map straight onto our existing `bcCreatureIndex` /
  `bcResourceIndex` (names, icons, tiers).
- **Coordinate scale differs per table** (verified in gating): `enemy_location` x/z are **milli-hex**
  (÷1000 → map space, e.g. `27555312 → 27555`); `resource_location` / `growth_timers` x/z are **plain
  Small-Hex** (÷1, e.g. `27120`). Both then plot via `L.latLng(z, x)`, the same space as player markers.

## Gating results (verified against the live relay)

- ✅ **Anonymous connect works** — relay issues an identity + token, no game auth.
- ✅ **Live animals with per-entity IDs** — `enemy_location WHERE regionId=19` streams
  `{entityId, enemyType, x, z, regionId}`; `onInsert/onUpdate/onDelete` fire (spawn / move / kill).
- ✅ **Region + type filters work**; coordinate scale confirmed (above); reused bitcraftmap's generated
  bindings with SDK 2.6.1.
- ⚠️ **Volume is the deciding factor:**
  - A single **animal type** in a region ≈ **1,400 rows** (Sagi Bird = 1,392). Fine for a canvas layer
    with throttled redraw — and live movement is the whole reason to do this.
  - A single **resource type** in a region ≈ **125,000 rows** (Sticks = 125,650). That's a firehose to
    stream/hold live, and our existing aggregate poll returns the same set as one compressed fetch. **The
    relay is not worth it for resources.**
- ⚠️ The SDK logs "updating a row not present in cache" for deltas that arrive before the initial
  snapshot applies — benign; **gate row callbacks on `onApplied`** (as bitcraftmap does).

## Refined strategy (post-gating)

- **Animals → relay.** Subscribe per tracked enemy type × region; this is the real, tractable win.
- **Resources → keep the aggregate REST poll** (or a static dataset). Do **not** stream `resource_location`
  live (125k+/type). Optionally overlay `growth_timers` (small, sparse) to show which nodes are respawning
  and when — a light enhancement on top of the aggregate layer.
  - **Exception (shipped):** `bcmap-api`'s static tiles omit transient/dynamic cargo — e.g. **Uncharted
    Shipment** (`resourceId 278317122`) returns 404 in every region on `bcmap-api` but has ~28k live rows in
    `resource_location`. So a tracked resource whose REST poll returns **0 points** is flagged `t.relay=true`
    and streamed from `resource_location` per type × region, exactly like enemies. This only ever fires for
    resources bcmap-api lacks (rare cargo = few rows), so the 125k firehose types never hit the relay.
    Persisted via the `relay` flag in `bc_map_tracked_res_v1`.
- **Players →** stay on the bitjita WS for now.

## How subscription works (from `relay-service.ts`)

```js
DbConnection.builder()
  .withUri("https://st.prism.brico.app")   // SDK converts to wss://
  .withDatabaseName("prism-relay")
  .withToken(storedToken ?? undefined)     // anonymous; persisted in localStorage
  .onConnect((conn, identity, token) => { /* persist token; register callbacks + subscribe */ })
  .onDisconnect(...).onConnectError(...)
  .build()
```

Subscriptions are **typed queries, one per (type × region)**, unioned in the client cache:

```js
conn.subscriptionBuilder()
  .onApplied(() => populateFromCache())     // bulk draw once
  .subscribe(regions.map(rg =>
     tables.enemy_location.where(r => r.enemyType.eq(typeId).and(r.regionId.eq(rg)))))
// then incremental patches:
conn.db.enemy_location.onInsert / onUpdate / onDelete
```

So: subscribe per **tracked type**, filtered to the **current region(s)**; the SDK maintains a
client-side cache; `onApplied` → bulk draw, then row callbacks patch it live. This is a 1:1 replacement
for our current "track a type → fetch its points" flow — just live instead of a 60 s poll.

## Architecture decision — browser-direct

The map is entirely client-side (Leaflet), the relay is designed for direct client subscriptions with
anonymous tokens, and it's how bitcraftmap itself works. Our app runs as a **local, ~single-user** tool,
so per-user connections ≈ 1. Proxy-side (one relay connection → SSE fanout, like our existing bitjita
`/live`) would be politer *at scale* but adds an npm dependency + ESM/bindings handling to the currently
zero-dep proxy and re-implements cross-client subscription refcounting — not worth it here.

**One-time setup** (the only real friction with our no-build single-file frontend):

- **Vendor the SDK** — commit `spacetimedb`'s ESM bundle into the repo (e.g. `mapassets/spacetimedb.js`)
  and `import` it locally. No CDN runtime dep, no build step.
- **Vendor the bindings** — produce JS bindings for `prism-relay` (compile bitcraftmap's
  `src/relay-bindings/` TS → JS, or `spacetime generate`) and commit as `mapassets/relay-bindings.js`.
  One-time codegen; static afterwards.

## Concrete changes

**New files:** `mapassets/spacetimedb.js` (vendored SDK), `mapassets/relay-bindings.js` (generated).

**`index.html` — new `bcRelay*` block** (next to the existing `bcPlayerSocket` code):

- `bcRelayConnect()` — build/connect; anonymous token in `localStorage['bc_relay_token']`; register the
  enemy / resource / growth `onInsert/onUpdate/onDelete` callbacks once.
- Lifecycle: **connect when the Map tab is active AND ≥1 resource/enemy is tracked; disconnect on leaving
  the map / untracking all** — reuse the exact conditions from `bcScheduleResourcePoll` / `bcStopResourcePoll`.
- `bcRelaySubscribe()` — rebuild the subscription array from the tracked **enemy** entries in
  `bcTrackedRes` (`kind==='enemy'`) × `bcMapRegion` (require a region — don't subscribe region-wide).
  Re-subscribe on track/untrack (`bcToggleMapItem`) and region change (`bcSetMapRegion`).
- Callbacks patch `bcTrackedRes[key].pts` from the SDK cache and call `bcRedrawTracked()`, throttled with
  `requestAnimationFrame` (animals move continuously; ~1.4k points/type).

**Old path stays for resources:** `bcFetchResourcePts` + `bcScheduleResourcePoll` (the 60 s aggregate poll)
remain the resource path — the relay's `resource_location` is a 125k+/type firehose and not worth it.
For **enemies**, the relay replaces the poll (behind a flag `bcUseRelay`, default on, so the REST path is
an instant fallback if the relay is down).

**Rendering:**
- Enemies (relay): canvas dots that move / spawn / disappear live — the bccodex behavior.
- Resources (aggregate, unchanged) + optional `growth_timers` relay overlay: faded dots + respawn
  countdown (`endTimestamp`) for depleted nodes. Sparse, cheap — a nice-to-have layered on top.

**Players:** leave on the bitjita WS for now (it works); optionally migrate to `player_location` /
`player_state` later for a single live source.

## Open items to confirm (gating)

1. **Coordinate scale** — verify relay `x/z` plot directly via `L.latLng(z, x)` (should match players).
   Compare a logged node against its position on bitcraftmap.com.
2. **Bindings** — confirm we can produce JS bindings (compile bitcraftmap's TS, or `spacetime generate`).
   This is the gating setup task.
3. **Region default** — subscribing with *no* region filter hits large tables; default to the selected
   region, and require a region (or cap) when unset, to be polite.
4. **Reconnect/backoff** — wrap the SDK's `onDisconnect`/`onConnectError` with backoff like `bcEnsureSocket`.

## Build order (one feature, staged commits)

1. ~~**Gating setup**~~ ✅ done.
2. ~~**Vendor** the SDK + bindings~~ ✅ done → `mapassets/prism-relay.js` (107 KB, browser ESM). Recipe below.
3. ~~**Enemies** end-to-end~~ ✅ done — `bcRelay*` in `index.html` connects on enemy-track, subscribes per
   type × region, rebuilds points from the SDK cache on live insert/update/delete (200 ms throttle),
   coords ÷1000. Behind `bcUseRelay` (localStorage `bc_use_relay=0` to disable); on connect failure it
   flips to the REST poll. Verified live: 1,397 Sagi Birds, movement streaming, clean untrack/retrack.
4. ~~**Polish:** unsubscribe when leaving the Map tab~~ ✅ done — relay is gated on the Map tab
   (`bcRelaySync` from `switchTab` + `visibilitychange`); redraw skipped while `document.hidden`. Verified.
5. ~~**Respawn overlay**~~ ✅ done — "Respawn timers" toggle in the Live-map panel (persisted). Subscribes
   `growth_timers` for the selected region on the shared relay connection and draws each depleted node as a
   Leaflet marker with a live respawn countdown (`endTimestamp.toMillis()`, coords ÷1, names from
   `bcResourceIndex`). 1 s tick updates tooltips; keeps the relay up on the Map tab even with no tracked
   enemies. Verified: ~20 markers in region 19 ("Depleted Hexite Deposit — respawns in 68h"), clean
   teardown on toggle-off / leave-map.
6. ~~**Trim the trackable list**~~ ✅ done — the Map "track" list was cluttered with ~un-trackable entries
   (doors, boulders, planted saplings, dungeon-interior props, ultra-rare drop-only ores like Auric/Argent
   Ore, taming drops like Owl Feathers). Fix: `mapassets/untrackable.json` lists type ids to hide;
   `bcLoadIndexes` loads it into `bcUntrackable` and `bcAllEntries` skips them. Cut the list 586 → 246
   (resources 544 → 208, creatures 42 → 38).
7. **Optional:** per-animal icons / a brief fade on kill.

### Regenerating `untrackable.json`

`node build-map-index.js` rebuilds all three files: `resourceIndex.json` + `creatureIndex.json` from
bitjita's `/api/resources` and `/api/creatures`, then `untrackable.json`. Re-run it after a game update
(new types) or when a season turns.

The authoritative "is this worth tracking?" signal is **how many nodes actually exist world-wide** — *not*
tier or tag (Auric Ore is tier −1 / tag "Ore Vein" exactly like legit veins). The script counts them on the
prism relay (`SELECT * FROM resource_location WHERE resource_id = X`, one per type, sequentially), but only
for the types the list doesn't already show: the ones hidden last time and the ones new to the index
(~540 types, ~25k rows, under a minute). Types already listed stay listed; recounting them would pull
millions of rows (Sticks alone is 1.2M / 112 MB).

Rules: **hide resources with < 5 live nodes**, plus the Depleted Resource / Hidden Resource tags whatever the
count. **Seasonal tags (Seasonal, Seasonal Resource, Summer Resource) are never hidden for a low count** —
out of season they have none, which is how the July build (bcmap-api counts, < 15 nodes) kept Pumpkin and
Sunflower out of the list when they spawned in October. Their ids go in `seasonal`, and a tracked one with no
nodes world-wide reads "off-season" instead of "none found". Why 5 and not July's 15: in October the
counted types jump 3 → 7, and 15 would split the new Quarry Rock tiers (their counts move by ±10 within
minutes). Creatures aren't counted (~50 types, all real): the four hidden in July (Practice Dummy, Swift
Cervus, Enraged Alpha Jakyl, Giant Hexite Skitch) stay hidden and new creature types are listed. Output shape:

```json
{ "_meta": { "source": "...", "built": "2026-10-27", "minNodes": 5, ... },
  "resources": ["<id>", ...], "enemies": ["<id>", ...], "seasonal": ["<id>", ...] }
```

### Rebuilding the vendored bundle

Bindings are bitcraftmap's generated `src/relay-bindings/` (SpacetimeDB CLI 2.4; SDK `spacetimedb@^2`).
```
# entry.ts: export { DbConnection, tables } from "./relay-bindings/index";
npm i spacetimedb esbuild
npx esbuild entry.ts --bundle --format=esm --platform=browser --target=es2020 --minify \
  --outfile=mapassets/prism-relay.js
```
`index.html` loads it via `import(`${API}/mapassets/prism-relay.js`)` (proxy serves `.js` as
`text/javascript` with `Access-Control-Allow-Origin: *`, so the cross-origin module import works).

### Landmarks the geojson lists leave out (`bcLm*`, 2026-10-27)

prism's geojson lists come from the game's world claims, sorted by the building that anchors each claim
(`prism-features/src/features.ts`); claim types its switch doesn't name are dropped. Live mainland types it drops:
**Quarry Building Center** T1/T4/T7 (32; a T1 quarry holds T1–T3 Quarry Rocks within ~18 units, T4 → T4–T6,
T7 → T7–T9), **Giant Berry Bush Event** T1/T2/T3 (24, one of each per region: Strawberry, Savory, Zesty),
**Sunken Ruins** (4, one per corner region) and **Ancient Crumbled Pillar / Platform** (3,371 + 910 — bitjita's
"ruins"). Hexite Deposits *are* in `empireResources.geojson`, but the layer reads them with the rest. Maker's Trees,
Volcanic Geysers, Hermit Crab Dens and the other Uncharted sites only exist on the dead island regions.

The prism relay has them all in **`claim_meta`** (`entity_id, region_id, x, z, building_desc_id`, btree on
`building_desc_id`) — not in our vendored bindings, so the map reads it over a raw v1.json scratch socket
(`bcPrismFetchOnce`): `claim_meta` per building + `resource_location` for the 9 giant-bush states, the 2 hexite states
and the 50 quarry rocks ≈ 60 KB, re-read with the 15-minute lists while a layer is on. A bush and a deposit sit exactly
on their claim, so the resource at the claim's spot is its state (Withering = needs Nutrient Rich Water from the three
Gentle Springs 2–3 tiles away; Bountiful/Citric = gatherable). Ancient ruins (~470 KB) load with their layer and are
cached in localStorage (`bc_map_ruins_v1`, 67 KB, three days). Region borders come from prism's `grids.geojson`
(the weight-2 lines + the nine name points; its fine chunk grid is skipped). Markets is a claim filter like Waystones
(`has_market` in `claims.geojson`, 455 of 1,856).

Popup coordinates (`bcNE`) are the game's: N = round(z/3); E = (x + table[x mod 3][N odd][z − 3N + 1]) / 3 — fitted to
the names of 8,115 world claims, all matching. The popups printed raw map units (3× the game's) until then.

## References

- Relay consumer / bindings: https://github.com/BitCraftToolBox/bitcraftmap
- Node index backend: https://github.com/BitCraftToolBox/bitcraft-nodeindex
- SDK: `spacetimedb` (npm, v2.x)
- Config: `relayHost=https://st.prism.brico.app`, `relayModule=prism-relay`, `exportsCdn=https://prism.brico.app`
