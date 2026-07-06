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
- `x/z` are Small-Hex coords (0–23040), the same space our player markers already plot in
  (`L.latLng(z, x)`). **To verify** during gating (moving entities are "floating hex" but stored as i32).

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
- `bcRelaySubscribe()` — rebuild the subscription array from `bcTrackedRes` (each `kind:id`) × `bcMapRegion`
  (or all regions if unset). Re-subscribe on track/untrack (`bcToggleMapItem`) and region change
  (`bcSetMapRegion`) — same call sites that call `bcRefreshAllTracked` today.
- Callbacks patch `bcTrackedRes[key].pts` from the SDK cache and call `bcRedrawTracked()`, throttled with
  `requestAnimationFrame` (animals move continuously).

**Replace / gate the old path:** `bcFetchResourcePts` + `bcScheduleResourcePoll` (the 60 s REST poll)
become the **fallback**, used only if the relay fails to connect. Behind a flag `bcUseRelay` (default on)
so we can A/B and instantly revert.

**Rendering upgrades this unlocks (same data):**
- Resources: `resource_location` = solid dots (up); `growth_timers` = faded dots + respawn countdown
  (`endTimestamp`).
- Enemies: dots that move / disappear live (the bccodex behavior).

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

1. **Gating setup** — vendor SDK + generate bindings; standalone Node script connects, subscribes to
   `enemy_location` for one region, logs rows; confirm connection, data shape, and coordinate scale.
2. **Enemies** end-to-end (subscribe → cache → `bcRedrawTracked`), behind `bcUseRelay`, with REST fallback.
3. **Resources + growth timers** (up vs respawning).
4. Flip default to relay, keep REST fallback; polish (respawn countdowns, throttled redraw).

## References

- Relay consumer / bindings: https://github.com/BitCraftToolBox/bitcraftmap
- Node index backend: https://github.com/BitCraftToolBox/bitcraft-nodeindex
- SDK: `spacetimedb` (npm, v2.x)
- Config: `relayHost=https://st.prism.brico.app`, `relayModule=prism-relay`, `exportsCdn=https://prism.brico.app`
