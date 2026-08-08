# Relay Overhaul — Architecture Plan

Working document. Sections are numbered so we can refer to them when editing
("change 4.2"). Nothing here is built yet.

Status: **draft — under discussion**

---

## 1. Why

### 1.1 What's wrong today

The relay speaks a **subscription** protocol. A subscription hands you a snapshot
*and then* a live stream of changes, on one connection. That is one operation.

We have been using it as a request/response API: subscribe, read the snapshot,
walk away from the stream. Every tab open, every refresh, every poll sends a new
subscribe and abandons it.

Three consequences:

- **Abandoned subscriptions accumulate and can never be retracted.** Measured: a
  held subscription received 164 updates in 6s on a fresh socket, and **zero**
  after 30 one-shot queries on that same socket. Snapshots keep answering
  perfectly throughout, so nothing looks broken while live delivery is dead.
- **So sockets must be periodically hung up and redialled**, which is where the
  "relay outages" come from. Most are self-inflicted.
- **We ended up with two socket pools** — 13 "asking" sockets that get recycled,
  and 1–3 "listening" sockets that don't. Half the live features work by
  listening for a *doorbell* ("something changed") and then re-asking on the
  other pool, so they depend on both pools being healthy at once.

### 1.2 The finding that settles the design

The relay's own explorer (`/explorer/js/explorer.js`) **never unsubscribes**. The
word does not appear in the file. Its Disconnect button is:

```js
function disconnect() {
  if (ws) { try { ws.close(); } catch (e) {} ws = null; }
}
```

and `subscribe()` calls `disconnect()` as its first line. Changing region or
picking a different table does too.

So the author's model is: **one socket = one subscription, permanently. To change
what you're listening to, hang up and redial.** There is no Unsubscribe to find
because nobody uses one. Our recycling isn't working around a missing feature —
hanging up *is* the sanctioned way to stop listening.

### 1.3 Target

**13 sockets, one per region. One subscribe on each, held for the session. Rows
stream into a client-side cache. Every tab renders from the cache.**

- Tab switches cost **zero** network.
- Everything is live, not just crafts.
- No accumulation, so no recycling, so no self-inflicted outages.
- No doorbells — the delta *is* the data.

---

## 2. Core architecture

### 2.1 Connections

- One WebSocket per region. **13 regions**: 3, 7, 8, 9, 11, 12, 13, 14, 15, 17,
  18, 19, 23. Port = `3000 + region`.
- Database name = `bitcraft-live-<N>`, read at runtime from `/health`
  (`sources[].database` / `.port`). **Never hardcode it** — the databases were
  renamed once already and the old name 404s on the WS upgrade, which browsers
  surface only as a bare `close 1006` with no `open` event.
- Every region gets **the same query set**. Regions where a player has nothing
  simply return no rows, and an idle subscription costs nothing.
- **No region discovery.** We do not look up where a player is. We ask all 13 and
  the one that has them answers. This deletes `relayPlayerRegion`,
  `feedSeenRegions`, and `noteFeedRegions`.

### 2.2 One subscribe per socket

A single `Subscribe` carries many query strings and comes back as **one**
`SubscribeApplied` frame. Verified at 1, 3, 6, and 36 queries — always one frame,
always ~85ms on an already-open socket.

So each socket sends exactly one subscribe, containing every query that region
needs for every tracked player, and never sends another.

### 2.3 The cache

A plain JavaScript object in the page. Not on the host, not in localStorage.

- Snapshot rows fill it. Delta rows patch it.
- **Never cleared on disconnect.** On reconnect the fresh snapshot replaces that
  region's slice **atomically**. If we cleared on close and refilled on open
  there'd be a real blank window.
- Dies on page refresh, rebuilt in ~1s from snapshots. That is the only time we
  pay a cold start.
- Per browser tab. See 8.3.

### 2.3.1 Size — this is heap, not localStorage

Different budget entirely. localStorage is a hard ~5MB per origin, and exceeding
it makes *every* `setItem` fail silently (we've hit this). The JS heap is
hundreds of MB to a few GB.

Estimated for 3 tracked players:

| | |
|---|---|
| Crafts incl. passive | heaviest — one player measured at 1,908 `passive_craft_state` rows, ~300KB/player worst case |
| Inventory | ~40 containers, few hundred item rows, ~100KB/player |
| Orders | dozens–low hundreds of rows |
| Experience / Tasks / Stamina / Buffs | trivial |
| Place names (buildings, claims) | few hundred KB, shared |

**~1–2MB total.** Not a concern — *provided* the two rules below hold.

Estimate, not measurement. Profile it against a heavy player once the cache layer
exists rather than trusting this arithmetic.

### 2.3.2 Two rules that keep it bounded

The risk isn't snapshot size, it's unbounded growth from deltas.

1. **Keyed by `entity_id`.** A delta *replaces* the existing row, never appends.
   Size is then bounded by "rows matching our filters", which is bounded by
   tracked players.
2. **Deletes must actually delete.** Each `TransactionUpdate` carries a delete
   list and an insert list. Processing inserts but ignoring deletes makes
   completed crafts and filled orders pile up indefinitely — fastest-growing for
   passive crafts specifically.

Market order-book data (~2,400 items, several MB — the thing that killed
localStorage) never enters this cache. It stays HTTP per 5.1, in its existing
5-minute in-memory `Map`.

### 2.4 Tabs read the cache

No tab calls a fetch function for live state. Tabs render from the cache and
patch themselves when it changes.

### 2.4.1 "Re-render" means patching, NOT `innerHTML =`

The app's current pattern is `el.innerHTML = html`, which resets scroll position,
collapses open dropdowns and expanded rows, drops text selection, steals focus
from filter boxes, and visibly flashes on large content.

That's tolerable today because re-renders are rare — a manual refresh or a poll.
At delta frequency it would be unusable.

**The model already exists**: craft progress bars ([index.html:3984](index.html:3984))
find the one card, set the bar width, update the text, flip the status chip, and
touch nothing else. Extend that pattern to everything.

| change | response |
|---|---|
| a value changed (progress, quantity, XP, stamina) | patch that element's text/width — no structural change |
| a row appeared or disappeared (craft done, order filled) | insert/remove that one node |
| full rebuild | only on tab switch, player add/remove, or first render |

- **Coalesce per frame.** Twenty deltas arriving together = one patch pass, not
  twenty.
- **Don't render while the tab is hidden.** The cache keeps updating; render on
  switch. Also sidesteps the hidden-pane trap (rAF suspended, `setTimeout`
  clamped to ~1s buckets).

**Cost warning:** writing a patch path per tab is more work than
`innerHTML = html`, and is likely the largest single chunk of this overhaul —
larger than the socket layer. The plumbing is the easy half.

---

## 3. Lifecycle

### 3.1 The only reasons a socket is redialled

1. It died.
2. The query set changed — i.e. a player was added or removed.

**Not** on a timer. **Not** on tab switch. **Not** on refresh. **Not** on a
subscribe counter. That's the whole lifecycle.

### 3.2 Adding or removing a player

Both are a full redial: rebuild the query set from current state, reopen, one
subscribe.

Subscriptions *are* additive, so adding could technically be done without a
redial. We're choosing not to, because:

- One code path for add, remove, death, and initial connect.
- Accumulation becomes **structurally impossible** rather than merely bounded —
  every socket has exactly one subscription for its whole life. No counter to
  maintain, no drift, no backstop that might fail to fire.
- The cost is invisible. The cache keeps rendering during the redial (2.3), so
  nothing blanks; updates just pause for ~400ms–1s. And it's a deliberate click,
  so a brief loading state is expected anyway.

### 3.3 Reconnect on failure

Mandatory. A dropped socket means that region's cache silently **freezes** while
still looking correct — the worst failure mode.

- **Stagger with backoff + jitter.** A network blip drops all 13 at once, and 13
  simultaneous handshakes is exactly the connection cliff (see 8.1).
- **Mark the region stale** so the UI can show it rather than presenting frozen
  data as current.
- The fresh snapshot is the repair — it includes anything missed during the gap.
  No diffing or reconciliation needed.
- If a region won't connect at all, fall back for that region (section 6).

### 3.4 Liveness detection

**Quiet ≠ dead.** A filtered subscription legitimately goes silent for minutes
when nobody is crafting, so "no rows lately" can't be a health signal.

Browsers handle WebSocket ping/pong at the protocol level and fire `close` when
it fails, which covers most cases. Half-open connections remain a real if rare
risk. Noted, not solved up front.

### 3.5 Alerts must diff state, not catch events

Alerts compare cache-before against cache-after. They must **not** be driven by
observing delta events.

If a passive craft finishes during a redial or reconnect gap, we never see the
transition — only a snapshot where it's already done. Event-driven alerts miss
it; diff-driven alerts catch it.

This is the bug class we've been chasing repeatedly (buff alerts, then passive
craft alerts) — both cases of an alert depending on catching a moment rather than
noticing a difference. Diffing makes redials, reconnects, and outages harmless by
construction.

---

## 4. Wire format — **DECIDED: `v1.json.spacetimedb`**

Probed live against region 19 on 2026-08-07 with a realistic filtered
subscription (one active player, 6 tables: progressive/passive crafts, sell/buy
orders, experience, stamina).

### 4.1 Measured size

73-second window, identical frame counts on both protocols:

| | frames | bytes | per hour |
|---|---|---|---|
| `v1.json.spacetimedb` | 116 | 119.9 KB | **~5.9 MB** |
| `v2.bsatn.spacetimedb` | 116 | 33.1 KB | **~1.6 MB** |

**Ratio 3.6×**, not the 6× feared — that figure came from an unfiltered firehose.

Caveat: this player was *very* active (stamina ticking every ~1.5s, XP rising).
An idle player generates near zero. Idle regions cost nothing. But budget
roughly 6 MB/hour per actively-playing tracked character, on the user's own
connection — browser-direct, so still zero host bandwidth.

### 4.2 Message shapes

**Subscribe (client→server) has NO `query_set_id`** — that's v2 only. Sending it
closes the socket with `1011 unknown field 'query_set_id'`:

```js
ws.send(JSON.stringify({ Subscribe: { request_id: 1, query_strings: [ ...sql ] } }));
```

Server frames are plain-text JSON, single-keyed. Names differ from v2:

| v1 JSON | v2 BSATN equivalent |
|---|---|
| `IdentityToken` | (arrives first, carries identity + JWT — ignorable) |
| `InitialSubscription` | `SubscribeApplied` |
| `TransactionUpdate` | `TransactionUpdate` |

Both data frames nest the same way — `…database_update.tables[]` for
`InitialSubscription`, `…status.Committed.tables[]` for `TransactionUpdate` —
each table carrying `table_name`, `num_rows`, and `updates[]` with `deletes[]`
and `inserts[]`.

Errors arrive as a **close code with a readable reason string**, which is a large
debugging improvement over BSATN's silent misreads.

### 4.3 ⚠️ Rows are JSON *strings*, and the two frame types encode them DIFFERENTLY

Row entries inside `inserts`/`deletes` are strings needing a second `JSON.parse`.
And critically — verified across `progressive_action_state`, `experience_state`
and `stamina_state`:

```
InitialSubscription → NAMED OBJECT
  {"entity_id":1369094287934560918,"building_entity_id":...,"progress":0,...}

TransactionUpdate   → POSITIONAL ARRAY
  [1369094287930634672,1369094286772059011,16,116047,307011,862,1,...]
```

**The array positions map 1:1 onto the snapshot's key order** — verified by
zipping them: 10 keys, 10 positions, every value landing in the right field.

So we do **not** need hand-written readers or a schema fetch. Capture the key
order from each table's first `InitialSubscription` row, then use it to name
every subsequent delta array. Fully automatic, works for any table we ever add.

This is weaker than the "just `JSON.parse` it" pitch I originally made, but still
far better than BSATN: one generic mechanism instead of a hand-written byte
reader per table.

Timestamps also differ by frame type — `{"__timestamp_micros_since_unix_epoch__":N}`
in snapshots, bare `[N]` in deltas. Normalise both on the way into the cache.

### 4.4 ⚠️⚠️ `JSON.parse` SILENTLY CORRUPTS ENTITY IDS

Entity ids exceed `Number.MAX_SAFE_INTEGER` (9007199254740991). Verified:

```
raw:    1369094287934560918
parsed: 1369094287934561000     ← wrong, no error
```

**These are our cache keys.** Every row must be pre-processed before parsing:

```js
JSON.parse(row.replace(/([\[,:])(\d{16,})/g, '$1"$2"'))   // ids → strings
```

Verified: restores the exact id, leaves small numbers (`progress: 116047`)
untouched. Ids become strings, which is what we want for object keys anyway.

**This is the single most dangerous trap in the JSON path** — it fails silently
and produces plausible-looking wrong ids. Any row-ingest path that skips the
regex is a bug.

### 4.5 Why JSON over BSATN, and what would reverse it

The effort argument is roughly a wash — most BSATN readers already exist and
work. The deciding factor is **failure mode**:

- **JSON's trap (4.4) is known, enumerated, and fixed once** at the ingest
  boundary. It cannot recur once the regex is in place, regardless of what tables
  we add or what the game changes.
- **BSATN's trap is column drift.** If the game adds a field to a table, the
  hand-written reader misreads every field after it and produces confident
  garbage — no error, one table at a time, presenting as a tab bug rather than a
  protocol bug. That risk **re-arms with every game update** and scales with
  table count.

Secondary: JSON errors arrive as readable close reasons (`1011 unknown field
'query_set_id'`) instead of an unexplained socket close.

**Keep the protocol confined to one layer: `socket → normalise → cache`.** Tabs,
cache, and alerts must never see a raw frame. Switching protocols then means
rewriting one module, not the app.

**What would reverse this decision:** bandwidth. ~6 MB/hr per actively-playing
character (≈140 MB over an 8h session with 3 active characters, vs ≈39 MB on
BSATN). Fine on broadband, noticeable on metered/tethered connections.
`?compression=Gzip` is silently ignored by the relay, so there's no middle
ground.

---

## 5. What must stay HTTP

Not everything can be a subscription, because not everything is a live row.

### 5.1 Historical / derived
Computed over time windows by bitjita; no table backs them. Each item below was
checked against the schema (see 5.1.2) — **not** inferred from "it sounds
historical", which produced two wrong answers.
- Market price history (`avg7d`, `vwap`, etc.). Order books themselves
  (`sell_order_state` / `buy_order_state`) ARE live state; only the time series
  is derived. Verified: no price/vwap table.
- Completed-trade history (the order row is deleted on completion — see 7.1;
  *collections* are NOT in this category, they're `closed_listing_state`)
- Skill rankings — a leaderboard bitjita computes across every player. Verified:
  no ranking table exists (`empire_rank_*` is empire ranks, not skills).
  Deriving it would mean subscribing to all of `experience_state`, which
  violates 8.4.
- The Deals arbitrage scan

**NOT in this category (I got this wrong twice — verify against the schema, don't
reason about it):**
- *Collections* → `closed_listing_state` [Public]. See 7.1.
- *Storage logs* → `storage_log_state` [Public]. See 5.1.1.

### 5.1.1 ⚠️ `storage_log_state` IS a real Public table — storage logs are NOT HTTP-only

I originally claimed `/storage-logs` was HTTP-forever because "deposits are
events and the database holds state." **That reasoning was invented and wrong.**
BitCraft records deposits *as rows* — which is exactly why the relay can serve
them at all. The relay isn't watching and recording anything; it mirrors this
table like every other one.

Verified live (subscribed, region 19, one container → 88 rows in one frame):

```
{"id":4032854,"object_entity_id":1369094286807564957,
 "subject_entity_id":1369094286781181638,"subject_name":"Velcruza",
 "subject_type":[0,{}],
 "data":[2,{"item_id":2015587422,"quantity":66,"item_type":[0,{}],...}],
 "timestamp":{"__timestamp_micros_since_unix_epoch__":...},
 "days_since_epoch":20672}
```

Columns: `id`, `object_entity_id` (container), `subject_entity_id` +
`subject_name` (**the depositor — full attribution**), `subject_type`, `data`
(Sum: variant index encodes deposit vs withdraw — cross-checked variant `2`
against the HTTP endpoint's `"action":"deposit"` for the same item/qty),
`timestamp`, `days_since_epoch`.

The ~15-day window is the **game's** retention, not a relay limit — there's a
`storage_log_cleanup_loop_timer` in the same schema deleting old rows.

**Consequence:** Group Craft's contribution tally can be WS-native and **live** —
the leaderboard would update as people deposit. Filter by `object_entity_id` per
selected container (one query string each, all bundled into the one subscribe);
`days_since_epoch` is a plain i32 column, so the event window can be filtered
server-side to cut volume.

### 5.1.2 The lesson

My "is it an event or is it state?" heuristic produced two wrong answers in a
row. **BitCraft records plenty of events as rows.** The only reliable test is to
search the schema:

```
GET https://relay.bitcraftsync.app:30NN/v1/database/bitcraft-live-NN/schema?version=9
→ 480 tables, 274 Public, with names and table_access
```

Do that before declaring anything unavailable.

### 5.2 Text search
Subscription SQL has no `LIKE`.
- Player search, claim search, item search

### 5.3 Static game data
Present in the mirror, but pulling it live is strictly worse —
`crafting_recipe_desc` is 1.3MB over the socket and column projections are
rejected.
- `/itemdefs`, `/crafting-data`

### 5.4 What we *do* eliminate

HTTP for **live player state**: inventory, crafts, orders, XP, tasks, buffs,
stamina, equipment. That's the part that actually feels slow and stale.

---

## 6. Fallbacks

Keep them for now, but behind **one boundary** so they're removable in one pass:

```js
const data = await withFallback(
  () => craftsFromRelay(ids),
  () => craftsFromBitjita(ids)
);
```

- Each tab has exactly one line mentioning its fallback.
- All bitjita functions live together in one clearly-marked block.
- Deleting them later is mechanical, not surgery.

**DECIDED:** keep a fallback everywhere one exists today — no more, no fewer.
The five current paths:

| tab | relay path | bitjita fallback |
|---|---|---|
| Experience | `fetchSkillsRelay` | `/api/players/<id>` ([index.html:2113](index.html:2113)) |
| Orders | `fetchPlayerMarketRelay` | `fetchPlayerMarketBitjita` ([index.html:2689](index.html:2689)) |
| Crafts | `fetchPlayerCraftsRelay` | `fetchPlayerCraftsBitjita` ([index.html:3676](index.html:3676)) |
| Inventory | `fetchPlayerInvRelay` | inline in `fetchPlayerInv` ([index.html:5004](index.html:5004)) |
| Tasks | `fetchTasksRelay` | `/api/players/<id>/traveler-tasks` ([index.html:5118](index.html:5118)) |

**The cleanup:** each of these is currently expressed **twice** — once in the
per-player wrapper, and again in the tab's render loop:

```
2698 fetchPlayerMarket    →  2963/2968 render loop retries per player
3701 fetchPlayerCrafts    →  4047/4052 render loop retries per player
```

Collapse to one `withFallback` boundary per tab so the render loop just calls the
tab's data function and never mentions bitjita.

---

## 7. Per-tab audit

### 7.1 Group A — already relay-native, just stop re-asking

**Crafts** — `progressive_action_state`, `passive_craft_state`,
`public_progressive_action_state`, plus `building_state` /
`building_nickname_state` / `claim_state` for place names. Relay has all of it.
Closest tab to the target and the best first migration.

**Tasks** — `traveler_task_state` held live; `traveler_task_desc` + `npc_desc` are
static reference data, kept cached rather than subscribed. Also reads inventory,
so it inherits 7.2.

**Experience** — `experience_state` + `skill_desc`. Currently does the exact
double-work this overhaul removes: asks on tab open *and* listens continuously to
the same table. Collapses to one held subscription. **Rankings stay HTTP** (5.1).

**Orders** — `sell_order_state` / `buy_order_state` + claim join, **plus
`closed_listing_state` for collections** (coins from filled sells, items from
filled buys). All three Public, all three already read from the relay today —
`readClosedListing` ([index.html:2617](index.html:2617)) feeds
`bucket.collections` in `fetchMarketRelayMulti`. bitjita's
`/api/players/<id>/market-collections` is only the fallback.

**Only completed-trade history stays HTTP.** Verified against the schema: there
is no such table. `trade_order_state` / `traveler_trade_order_desc` are
traveller/NPC trades, not player market history. **When a trade completes the
order row is deleted** — the mirror holds only what exists now. bitjita has the
history because it watches the stream continuously and records transitions; no
snapshot can reconstruct it. Same principle as price history (5.1) and
`/storage-logs`.

### 7.2 Group B — relay has it, we're not using it properly

**Inventory** — *biggest single win.* Currently relay **HTTP**
(`/player/<id>/inventory`, `/player/<id>/housing`) plus WS for equipment and
vehicles. `inventory_state` is Public and carries full live pockets.

- Today inventory **never updates live** — deposit something and the tab is stale
  until you refresh.
- Going WS-native also **fixes a bug**: the HTTP cache misses deployable-owned
  containers (boats, wagons, caches), because those inventory rows link back via
  `owner_entity_id` rather than carrying the deployable's own id.
- Cost: the HTTP route pre-joins `claim_name` and `category`. Over WS we rebuild
  those from `building_state` + `claim_state` joins — machinery Crafts already
  has.
- Unlocks Networth, Tool Crafting, Tasks and Planner, which all read through it.

**Networth** — inherits the inventory fix, which is most of its latency. Prices
stay HTTP (5.1).

**Market** — **🔲 OPEN.** The problem in plain terms:

Every other tab watches a **fixed** set of things — your tracked players. Set
once when the app loads, changes maybe twice a session.

Market watches **whatever item you just clicked**. Iron Ingot, then Copper Ore,
then Rough Plank — a different thing every few seconds. And under 3.1, changing
what we watch means hanging up and redialling all 13 sockets. Browsing ten items
would mean ten full redials. Obviously wrong.

Three ways out:

1. **Leave Market on HTTP.** You look at an order book for a few seconds; a fresh
   fetch per item is equivalent to a live one, costs no sockets, and works today.
2. **One dedicated extra socket** just for Market, redialled on each item click
   (~250ms). Costs one from the budget and needs 8.3.1 care.
3. **Subscribe only to a small pinned watchlist** — a bounded, stable filter that
   fits the architecture cleanly.

**Lean: option 1.** "Live order book" sounds appealing but adds little when
you're glancing at a price. Option 3 becomes the right answer *if* we ever want
"alert me when someone undercuts my listing" — that's a genuinely live need with
a naturally small filter.

**Shopping List** — same story as Market. Lower priority; the bulk price POST
already made it fast.

**Group Craft** — fully relay-native, including the tally. Container discovery
and live contents move to WS, **and so does the contribution tally**:
`storage_log_state` is Public and subscribable (5.1.1), carrying
`subject_entity_id` + `subject_name` for attribution.

This is an upgrade, not just a port — **the leaderboard would update live as
people deposit**, instead of only on a manual re-tally.

Practical notes: filter by `object_entity_id` per selected container (one query
string each, all bundled into the region's single subscribe); `days_since_epoch`
is a plain i32 column so the event window can be filtered server-side. Volume is
real but bounded — 88 rows for one container in testing, and users select a
handful, not all 144.

**Tool Crafting / Planner** — static data stays on the proxy. These improve only
via the inventory fix.

### 7.3 Group C — relay can't help

**Open Crafts** — the relay has the rows, but scoped to the *whole world across
13 regions*. That's an unfiltered firehose (~350 updates/15s per region) and
violates 9.1. One bitjita HTTP call beats 13 permanent unfiltered subscriptions.
**Keep on bitjita.** If we ever want it live, scope it to pinned claims only.

**Deals** — an all-items arbitrage sweep. Inherently a batch job. Keep proxy-side.

**Map** — a different relay entirely (prism-relay) plus geojson exports. Already
live. Out of scope.

---

## 8. Known constraints

### 8.1 Connection cliff
The browser throttles hard past ~13 simultaneous sockets to one host:
**13 → ~510ms, 26 → ~5s, 39 → ~5.2s.** Not linear — a cliff.

13 is exactly at the edge and is our entire budget. Nothing may open a 14th.

### 8.2 Cold start doesn't improve
First connect is 13 handshakes: 410ms to occasionally 12s, variable. We already
pay this today for the query pool, so it's not a regression — but "instant" means
"after the first second", not "always".

### 8.3 Multi-tab — **TESTED 2026-08-07, the budget IS shared across tabs**

Previously an untested assumption. Measured:

| test | result |
|---|---|
| 13 sockets, one tab, 13 different ports | all open, **530ms** (median 260ms) |
| +13 from a *second* tab while the first held its 13 | **only 9 opened**; 4 hung indefinitely |
| then closed tab 1's 13 | the 4 opened **instantly** — after blocking 56s |

```
tab 2 timings: [251,251,251,252,254,255,267,271,272, 56116,56116,56116,56116]
                └────── nine at ~270ms ──────┘        └─ four blocked until tab 1 closed ─┘
```

The four waited *exactly* until sockets freed elsewhere, so this is a shared
budget, not coincidental slowness. Ceiling observed: **~22 concurrent** (13 + 9).

**Consequence:** two tabs of the app is a real, reproducible degradation — the
second tab silently fails to connect ~4 regions and those regions' data never
arrives. Worse than "slow".

⚠️ *Whose* limit it is remains unproven — browser, relay per-IP, or this test
environment's networking (it ran inside the Claude browser pane, which may have
its own layer; real Chrome could differ). The shared-across-tabs behaviour is
solid regardless.

Still not building `BroadcastChannel` coordination up front, but this is now a
known bug rather than a hypothetical. **Minimum viable mitigation:** detect
sockets stuck in CONNECTING and surface it, rather than showing empty regions as
though they're genuinely empty.

### 8.3.1 ⚠️ NEVER open two sockets to the same region

Connections to the **same** host:port are **serialised** — one handshake at a
time. Measured: 30 sockets to region 19 all opened, but at ~265ms intervals,
taking **7.9 seconds** total.

```
251, 516, 783, 1049, 1313, 1572, 1833, … 7937
```

Different ports go in **parallel** (13 regions ≈ 250ms each, all at once).

So one-socket-per-region is not just convenient — it's the only shape that
parallelises. Splitting a region's queries across two sockets would double that
region's connect time, not halve it.

### 8.4 Every held subscription must be filtered
No held subscription without a bounded `WHERE`. `owner_entity_id = <our players>`
is fine; `SELECT * FROM progressive_action_state` region-wide is not. This is
what rules out Open Crafts (7.3).

---

## 9. Cleanup folded into this work

### 9.1 Delete `bcTabCache`
24h localStorage mirror of Crafts and Orders only ([index.html:2562](index.html:2562)).

Covers those two tabs because they were the slowest *at the time*, not for any
principled reason — every other tab shows a spinner. After the overhaul one
snapshot fills every tab in ~1s, so it would buy ~800ms once per session on two
tabs out of thirteen. Against that: a save/hydrate path, a 300KB cap, tracked-player
filtering on load, and real localStorage quota risk (this app has filled the quota
before, which silently breaks saving for *everything else*).

Also: showing 24-hour-old crafts as though current is worse than an honest
loading state.

### 9.2 Move `/crafting-data` off the scrape
`extract-crafting-data.js` scrapes **bitcraft-timer.com**, a third-party website,
into a 4.4MB `craftingData.json` committed to the repo and refreshed only when
someone manually runs the script. Most fragile source in the app.

Replacement confirmed present in the GameData repo
(`BitCraftToolBox/BitCraft_GameData`, branch `sats-json`, `/static/`):

```
crafting_recipe_desc.json   10.6 MB
item_desc.json               3.9 MB
cargo_desc.json              0.6 MB
building_desc.json           2.6 MB
skill_desc.json              4.4 KB
```

Structure has everything we need — `id`, `name`, `time_requirement`,
`actions_required`, `consumed_item_stacks`, `crafted_item_stacks`,
`level_requirements`, `experience_per_progress`, `building_requirement`,
`is_passive` — and **the recipe ids match the ones the relay reports**, so the
swap doesn't ripple downstream.

One wrinkle: names are templates (`"Assemble {0}"`) where `{0}` is filled from the
output item's name. The extractor must join against `item_desc`. Straightforward,
but not a one-line swap.

Payoff: both `/itemdefs` and `/crafting-data` from one authoritative source,
refreshable automatically, no dependency on a third party's HTML staying put.

### 9.3 Retire the 7-day name caches
`bcRelayPlaces`, `bcTaskRefs`, `bcSkillDescs` all use an arbitrary 7-day TTL —
picked by judgement, not measurement.

`claim_state` and `building_nickname_state` are **live state tables**. Once we
hold subscriptions, a rename arrives as a delta within seconds. The TTL stops
being a staleness compromise and becomes purely a warm-start optimisation: paint
something instantly on load, let live data correct it.

(For reference: TTLs are enforced with `Date.now()` against a stored `ts` — the
user's device wall clock, no timer running, just a subtraction at read time.)

### 9.4 Machinery that disappears
- The `relayPool` / `feedConns` split
- Socket recycling and `relayMaxSubs()`
- `relayKeepWarm()`
- Doorbell-then-re-ask paths for crafts and orders
- `_complete` partial-sweep flags
- `relayPlayerRegion`, `feedSeenRegions`, `noteFeedRegions`
- The circuit breaker in its current form (`relayTakeSlot` / `noteRelayResult`)

---

## 10. Sequencing

1. **Decide the wire format** (section 4) — measure first. Everything else is
   written against whichever we pick.
2. **Build the socket + cache layer.** No tabs touched.
3. **Crafts.** Proves the pattern on the tab that's already closest.
4. **Inventory.** Biggest payoff; unlocks four other tabs.
5. **Orders, Experience, Tasks.**
6. **Alerts onto cache-diffing** (3.5).
7. **Cleanup** (section 9).
8. Revisit Market / Shopping / Group Craft with the open questions resolved.

Old paths stay behind the fallback boundary (section 6) until each migration is
proven.

---

## 11. Open decisions

- ~~**4** — wire format~~ **DECIDED: `v1.json.spacetimedb`.** Measured 3.6× the
  bytes of BSATN (~5.9 MB/hr per active character, browser-direct). Traps
  documented in 4.3/4.4.
- ~~**6** — which tabs keep a bitjita fallback~~ **DECIDED: keep all five that
  exist today**, collapsed to one `withFallback` boundary each (the logic is
  currently duplicated per tab).
- **7.2** — Market: filter changes on every item you view. Three options listed;
  lean is "leave it on HTTP".
- ~~**8.3** — multi-tab~~ **TESTED: the socket budget IS shared across tabs**
  (~22 ceiling; a second tab silently loses ~4 regions). Deferred by decision,
  but now a known bug, not a hypothesis. Also found: never open 2 sockets to the
  same region — they serialise (8.3.1).

---

## 12. Non-goals

- Rewriting the Map (different relay, already live).
- Moving static game data onto the WebSocket.
- Eliminating HTTP entirely — see section 5.
- Building `BroadcastChannel` tab coordination up front.
