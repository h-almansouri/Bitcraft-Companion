# Tool Rarity Optimizer — design doc

Status: **design / not yet built. Data layer verified against `craftingData.json` (see §7).** Lives in
the Tool Crafting tab. Revisits the shelved "Reroll column + Rarity roll planner." All costs are in
**hex (market buy price)**, sourced live from the market data the app already fetches. Everything except
the per-attempt odds is computable from the local `craftingData.json`.

### How the crafting data represents things (verified — important for implementation)

Rarity is a **string** on each item (`"Common"`…`"Mythic"`), and each (tool, rarity) is a distinct item
id. Recipes come in three shapes we care about:

- **Fresh craft** (T1 only): a single `"Craft {tool}"` recipe from raw mats → **Common** (e.g. Flint
  Axe = Knapped Flint + Stick → Common). No rarity roll on a fresh craft.
- **Tier upgrade**: also named `"Craft {tool}"`, but it **consumes the previous-tier tool** + mats
  (e.g. `Craft Aurumite Hammer` = `1× Rathium Hammer[T6] + 4× Aurumite Ingot + …` → Aurumite Hammer
  T7). There is **one variant per input rarity**, and each maps input rarity → **same** output rarity
  (Common→Common, Epic→Epic, …). Mats are the same across the rarity variants (upgrade cost depends on
  tier, not rarity).
- **Reroll**: `"Recraft {tool}"` — consumes `1× tool + N(r)× Tool Scrap + K(r)× Reforging Solvent` at
  the tool's tier → same tool, **same** output rarity.

**The rarity *increase* is NOT in the recipe data** — both upgrade and reroll recipes encode only the
base (same-rarity) result. The `p(r)` chance to bump one level is an engine overlay we apply ourselves
(hardcode the odds from the wiki). So the data gives us **costs + tier transitions + caps + salvage
yields**; we supply **the probabilities**.

---

## 1. What it answers

1. **Optimizer A — cheapest path.** "What's the cheapest expected way to end up with a *tier T\*,
   rarity R\** tool of this type?" Compares blind-upgrade vs reroll-at-tier-X vs hybrids and names the
   winner with expected + p90 hex.
2. **Optimizer B — keep / upgrade / reroll / scrap advisor + cull tiers.** "I have a tool at
   *(tier t, rarity r)* — should I upgrade it, reroll it, or scrap it?" Plus the **cull-tier grid**:
   the computed, price-driven version of the tool-maker rule "leave Commons at T2."

Both run off the same primitives.

---

## 2. Verified mechanics (from BitCraft_GameData)

**Rarity index** `r`: Common 0, Uncommon 1, Rare 2, Epic 3, Legendary 4, Mythic 5.

**Rarity is capped by tier** (confirmed by the user):

| Tier | T1 | T2 | T3 | T4 | T5 | T6+ |
|---|---|---|---|---|---|---|
| Max rarity | Common | Uncommon | Rare | Epic | Legendary | Mythic |

So `cap(t) = min(t − 1, 5)` and the **minimum tier that can hold rarity `r`** is `tier_min(r) = r + 1`.
Consequences:
- **No rarity can be gained at T1** (it's Common-only) — the first reroll recipe appears at T2. This
  matches the recipe data.
- A rarity step `r → r+1` can only happen at tier ≥ `r + 2` (you must already be able to hold `r`, and
  the result `r+1` must fit the tier). The expensive high-rarity steps are therefore locked to high
  tiers, where scrap/solvent are most expensive.

**Per-attempt chance to gain the next rarity** — identical on a tier-upgrade *or* a reroll,
tier-independent:

| From `r` → | `p(r)` | Expected attempts `1/p` |
|---|---|---|
| Common → Uncommon | 0.300 | 3.33 |
| Uncommon → Rare | 0.150 | 6.67 |
| Rare → Epic | 0.075 | 13.33 |
| Epic → Legendary | 0.0375 | 26.67 |
| Legendary → Mythic | 0.01875 | 53.33 |

**Rerolling = a "Recraft {tool}" recipe** at a dedicated bench (building_type `127749503`). Consumes
`1× tool + N(r)× Tool Scrap + K(r)× Reforging Solvent`, both at the tool's **current tier**, and outputs
the same tool at the same base rarity with a `p(r)` chance to bump one level. Costs depend only on the
rarity step, not the tier:

| Step | Scrap `N(r)` | Solvent `K(r)` |
|---|---|---|
| Common → Uncommon | **3** | 1 |
| Uncommon → Rare | 5 | 1 |
| Rare → Epic | 15 | 1 |
| Epic → Legendary | 30 | 1 |
| Legendary → Mythic | 50 | 2 |

Verified across all 420 tool "Recraft" recipes in `craftingData.json` — cost depends only on the rarity
step, and scrap+solvent tier **always** matches the tool tier (0 mismatches). Common→Uncommon is **3**
scrap in the data (not 1 as recalled) — worth an in-game sanity check, but the app reads it from the
recipe regardless. Gate: bench `buildingType 127749503`, `skillId 6`, level 1.

**Tier / scrap / solvent naming** (index by tier):

| Tier | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| Tool Scrap | Rough | Simple | Sturdy | Fine | Exquisite | Peerless | Ornate | Pristine | Magnificent | Flawless |
| Reforging Solvent | Basic | Simple | Infused | Fine | Exquisite | Peerless | Ornate | Pristine | Magnificent | Flawless |

**Salvage yield** (scrap returned by a `"Scrap {tool}"` recipe — 528 of them in `craftingData.json`,
verified): Common **1**, Uncommon **3**, Rare **15**, Epic **50**, Legendary **150**, Mythic **500**.
Rarer tools give far more scrap. (Note: salvaging a Rare = 15 scrap = the cost to reroll Rare→Epic once.)

**Rarity stat impact** (Steam equipment guide, for value approximation): +30% Unc, +40% Rare, +50%
Epic, +30% Leg, +20% Myth (compounding); +10% per tier. T10 Mythic ≈ +260% over T1 Common — rarity
dominates tier for power.

---

## 3. Cost primitives (all in hex, via market)

- `C_craft(t)` — mats to craft a fresh **Common** tool at tier `t` (already computed in the tab).
- `C_up(t → t+1)` — mats to upgrade one tier (tab).
- `C_rr(r, t) = N(r)·price(scrap@t) + K(r)·price(solvent@t)` — one reroll attempt at tier `t`.
- `V_sell(t, r)` — market value of the finished tool (per-rarity listings; approximate when the market
  is thin — see §7).
- `V_scrap(r) = salvage(r)·price(scrap@t)` — value recovered by scrapping.

Because scrap/solvent **prices rise with tier** while the odds don't, any given rarity step is cheapest
to buy at the **lowest tier that allows it** (`tier_min(r+1) = r+2`). This single fact drives most of
the strategy: *get rarity cheap at the lowest legal tier, then tier up the winners.*

---

## 4. State model

A tool is a state `(t, r)`. Actions:

- **Upgrade** (`t < T*`): pay `C_up(t→t+1)`. → tier `t+1`; rarity `min(r+1, cap(t+1))` w.p. `p(r)`, else
  `r`. (A bundled, "free" rarity roll — you pay for the tier regardless.)
- **Reroll** (`r < cap(t)`): pay `C_rr(r, t)`. → same tier; rarity `r+1` w.p. `p(r)`, else `r`. (A pure
  rarity roll at a fixed price.)
- **Scrap / restart**: recover `V_scrap(r)`; optionally craft fresh at `(t_start, 0)`.
- **Stop / sell.**

The whole problem: **which rarity levels do the free upgrade-rolls attempt, and which do I buy outright
— at what tier?**

---

## 5. Optimizer A — cheapest expected cost to reach `(T*, R*)`

`EC(t, r)` = min expected remaining hex to reach `t = T*, r ≥ R*`. Backward induction:

```
EC(T*, r) = 0                                   for r ≥ R*
EC(t, r)  = min over allowed actions of:
   reroll : C_rr(r,t)/p(r) + EC(t, r+1)                      # geometric retries collapse to /p
   upgrade: C_up(t→t+1) + p(r)·EC(t+1, min(r+1,cap(t+1)))
                        + (1-p(r))·EC(t+1, r)
```

- The reroll line uses the closed form: repeating a Bernoulli-`p` reroll until success costs
  `C_rr(r,t)/p(r)` in expectation, then continue from `(t, r+1)`.
- Solve rarity high→low within a tier, tiers `T*`→`t_start`. `O(T·R)` — recompute live on price change.

**Outputs:**
- Optimal policy (per state: upgrade / reroll / stop) rendered as an ordered step list.
- Expected total hex, plus **p50 / p90** via a quick Monte-Carlo over the policy (RNG is the only
  variance).
- A comparison row vs. naive blind-upgrade-and-pray.

Example phrasing: *"Cheapest path to T4 Rare: upgrade to T3, reroll Common→Uncommon then
Uncommon→Rare at T3 (~4.9k expected, 8.1k @ p90), then upgrade to T4. Beats blind-upgrade by 38%."*

**Expected takeaway:** the free upgrade-rolls on the mandatory climb are worth a lot for the cheap early
steps (30% is generous); any shortfall is cheapest to reroll at `tier_min(r+1)`. The high steps
(3.75%, 1.875%) are so improbable per roll that the optimizer almost never recommends blind-upgrading
toward them — it buys them at min tier or reports the target isn't worth it.

---

## 6. Optimizer B — keep/upgrade/reroll/scrap advisor + cull tiers

Same primitives, maximize **expected net value** (this is what yields cull tiers). `V(t, r)` = best
expected value from `(t, r)`:

```
V(t, r) = max of:
   sell   : V_sell(t, r)
   scrap  : V_scrap(r)
   upgrade: -C_up(t→t+1) + p(r)·V(t+1, min(r+1,cap(t+1))) + (1-p(r))·V(t+1, r)
   reroll : -C_rr(r,t)/p(r) + V(t, r+1)
```

The **optimal action per state is the advice.** The boundary between "keep improving" and "scrap/sell",
read across tiers for a fixed rarity, **is the cull-tier table.**

**Reproduces the tool-maker rule.** At `(T2, Common)`, `upgrade` pays `C_up(2→3)` for a 30% shot at
Uncommon, else a near-worthless T3 Common. If

```
0.30·V(T3, Uncommon) + 0.70·V(T3, Common) − C_up(2→3)  <  V_scrap(Common)
```

the policy says **scrap** → "leave Commons at T2." The same inequality at each rarity gives the
analogous cutoffs. Present as:

| Current rarity | Keep upgrading only while tier < |
|---|---|
| Common | (derived live) |
| Uncommon | (derived live) |
| Rare | (derived live) |
| … | … |

Cull tiers **shift with the market**: cheap high-tier scrap/solvent → rerolling stays worthwhile
longer; high tool prices → stricter culling. The app shows the current answer.

**Free bonus:** rank "best tools to salvage" by `V_scrap(r)` relative to `V_sell(t,r)`, so the user
knows what to feed the grinder to fund rerolls.

---

## 7. Data-layer verification (RESOLVED against `craftingData.json`)

All confirmed by reading the app's own `craftingData.json` (items carry a **string** `rarity`, so no
enum ambiguity):

1. **Fresh craft rarity — RESOLVED.** A true fresh craft (T1, from raw mats) is **Common only** (single
   recipe). No initial rarity roll. Higher-rarity tools are never crafted from raw mats — rarity comes
   only from the `p(r)` roll on upgrade/reroll. (The higher-tier "Craft {tool}" recipes are *upgrades*
   that consume the prev-tier tool; see the intro §.)
2. **`N(Common→Uncommon)` — RESOLVED = 3** scrap (data). Full ladder 3/5/15/30/50; solvent 1/1/1/1/2.
3. **Salvage yields — RESOLVED, in local data:** Common 1, Uncommon 3, Rare 15, Epic 50, Legendary 150,
   Mythic 500. (No dependency on the external `deconstruction_recipe_desc`.)
4. **Reroll tier constraint — RESOLVED.** Scrap & solvent tier == tool tier in all 420 tool recrafts
   (0 mismatches).
5. **Building/skill gate — RESOLVED.** Recraft bench `buildingType 127749503`, `skillId 6`, level 1
   (available for a "can't do this yet" hint).
6. **Caps — RESOLVED = `cap(t)=min(t−1,5)`.** Highest reroll-from rarity per tier: T2 Common(→Unc),
   T3 Unc(→Rare), T4 Rare(→Epic), T5 Epic(→Leg), T6+ Leg(→Myth). No reroll at T1.
7. **Upgrade cost is rarity-independent** — the per-rarity "Craft {tool}" upgrade variants share the
   same mats, so `C_up` depends on tier only (like the reroll scrap ladder depends on step only).

**Still an approximation (accepted):** thin-market `V_sell` — low-rarity high-tier tools may have no
listings; estimate from the stat multipliers (§2) × a base price when listings are missing.

**One thing the data does NOT contain:** the `p(r)` upgrade/bump probabilities — hardcode from the wiki
(§2 table).

---

## 8. Data sources

All in the app's local `craftingData.json` (`{items, recipes}`; items have string `rarity` + `tier`):
- Reroll recipes: `recipes` named `"Recraft {tool}"`. Inputs give the tool + `N(r)` Tool Scrap +
  `K(r)` Reforging Solvent; the input tool's rarity gives the step.
- Tier upgrades: `recipes` named `"Craft {tool}"` that consume the prev-tier tool; non-tool inputs =
  `C_up`. Fresh craft = the T1 `"Craft {tool}"` from raw mats.
- Salvage yields: `recipes` named `"Scrap {tool}"` (input tool rarity → scrap output qty).
- Scrap/solvent items: `items` (tiered "Tool Scrap" / "Reforging Solvent"; also a "Reforging
  Stabilizer" worth investigating).
- Prices: existing market fetch in the app.
- Probabilities `p(r)`: NOT in data — hardcode from https://bitcraft.wiki.gg/wiki/Rarity (Steam
  equipment guide id 3529143157 corroborates).

---

## 9. Open decisions (resolved)

- **Cost basis:** market **buy** price (a later toggle could add self-supply/production cost).
- **Thin market:** approximating `V_sell` is acceptable (§7.6).
- **Scope:** combine A + B, including the computed cull tiers.

## 10. Build order

1. ✅ Data layer verified against `craftingData.json` (§7).
2. ✅ **Optimizer A shipped** — cost-min DP over (t, r) + step-list UI + p50/p90 Monte-Carlo +
   "vs. reroll-all-at-T" comparison, in the Tool Crafting tab ("Rarity reroll planner"). Prices scrap
   from the market with a craft-and-salvage-a-Common fallback; solvent priced from market (excluded +
   flagged where unlisted). Target = (rarity, tier).
3. ✅ **Optimizer B shipped (resource-constrained, max-keepers).** "Batch upgrade advisor" in the Tool
   Crafting tab. Inputs: # tools, max tier, rarity wanted. **Objective: maximize tools reaching ≥ the
   wanted rarity**, capped by the scrap + craftable Reforging Solvents in the tracked inventory.
   - **Inventory caps** (per tier): scrap on hand; solvents you can field = existing + craftable
     `min(Σ⌊seeds/10⌋, ⌊fishoil/2⌋)`. Solvents are the hard reroll cap.
   - **Engine:** forward-simulate the batch (fractional/expected counts). At each tier, spend solvents on
     rerolls toward the target (nearest-target rarity first), funded by inventory scrap first, then by
     scrapping laggards — but **only when net-positive for keeper count**, using a keeper-probability DP
     `Pk(t,r) = P(reach ≥R by maxT via blind upgrades)`. A laggard's own `Pk` is the cost of scrapping
     it; cannibalize only if the reroll's keeper-gain-per-scrap beats it. Then blind-upgrade survivors.
   - **Guarantees keepers ≥ the blind-upgrade baseline** (verified). Rerolls mostly pay off from *free
     inventory scrap*; cannibalizing the batch for fuel is usually net-negative (the Commons you'd shred
     still have real keeper odds via free upgrade rolls), so it's done sparingly.
   - Output: tier-by-tier arrival distribution + a "Scrap N → reroll M → ~P promoted" line per tier, and
     a summary (keepers / solvents used / tools scrapped). No hex/market prices needed — it's all
     resource units. (Superseded the earlier value-max v1, which assumed infinite market depth and just
     recommended rerolling everything up to sell.)
4. ⬜ Fold catalyst/scrap needs into the existing per-tier mats grid + Shopping List.

### Known v1 approximations (Optimizer A)
- Solvent cost is excluded at tiers where it isn't listed on the market (flagged in the UI). Could fall
  back to its Scholar craft cost via `craftingData`.
- Scrap fallback prices a Common tool's full craft cost (salvage yield 1). A market listing, when
  present, overrides it (we take the min). Higher-rarity salvage (more scrap/tool) isn't considered as a
  cheaper source yet.
