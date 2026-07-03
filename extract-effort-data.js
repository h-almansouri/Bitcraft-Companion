// One-time script: build effortData.json for the "Effort Profit" tab from the BitCraft_GameData repo.
// Produces, keyed by the same item/recipe ids craftingData.json uses:
//   - passiveRecipeIds: recipe ids that are passive crafts (0 active effort; only their inputs cost effort)
//   - gather: item_id -> [ {hp, perAction, onDestroy, toolType, toolTier} ]  (sources that yield the item)
//       effort to gather 1 unit from a source = A / (onDestroy + perAction*A), where A = hp / toolPower
//   - tools:  item_id -> {power, type}   (read the user's equipped toolbelt tool -> its power)
//   - toolTypeMinPower: toolType -> smallest power (fallback when the user has no tool of that type)
// Run: node extract-effort-data.js
const https = require('https');
const fs = require('fs');
const path = require('path');

const BASE = 'https://raw.githubusercontent.com/BitCraftToolBox/BitCraft_GameData/sats-json/static/';
function fetchJson(name) {
  return new Promise((resolve, reject) => {
    https.get(BASE + name + '.json', { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

(async () => {
  console.log('Downloading GameData…');
  const [recipes, ext, res, tools] = await Promise.all([
    fetchJson('crafting_recipe_desc'), fetchJson('extraction_recipe_desc'),
    fetchJson('resource_desc'), fetchJson('tool_desc'),
  ]);
  console.log(`  recipes=${recipes.length} extraction=${ext.length} resources=${res.length} tools=${tools.length}`);

  // Resolve a GameData yield id to the id craftingData uses. Items keep their id; bulky raws are CARGO,
  // which craftingData stores at (cargoId + 4,000,000,000). Resolve against craftingData so keys always match.
  const cd = JSON.parse(fs.readFileSync(path.join(__dirname, 'craftingData.json'), 'utf8'));
  const cdItems = new Set(cd.items.map(i => i.id));
  const CARGO_OFFSET = 4000000000;
  // Gathered raws are bulky CARGO, and some ids exist as both an item and a cargo — so for gather yields,
  // prefer the cargo mapping (cargoId + 4e9) when craftingData has it, else the plain item id.
  const resolveId = x => cdItems.has(CARGO_OFFSET + x) ? CARGO_OFFSET + x : (cdItems.has(x) ? x : null);

  // ── passive recipe ids ──
  const passiveRecipeIds = recipes.filter(r => r.is_passive).map(r => r.id);
  console.log(`Passive recipes: ${passiveRecipeIds.length}`);

  // ── tool power ──  item_id -> {power, type, tier}   (tier gates which resources it can harvest)
  const itemTier = new Map(cd.items.map(i => [i.id, i.tier || 0]));
  const toolMap = {}, toolTypeMinPower = {};
  for (const t of tools) {
    if (t.item_id == null || t.power == null) continue;
    toolMap[t.item_id] = { power: t.power, type: t.tool_type, tier: itemTier.get(t.item_id) || 0 };
    if (t.power > 0) toolTypeMinPower[t.tool_type] = Math.min(toolTypeMinPower[t.tool_type] ?? Infinity, t.power);
  }

  // ── gather sources ──  item_id -> [ {hp, perAction, onDestroy, toolType, toolTier, skillId, skillLevel} ]
  const resById = new Map(res.map(r => [r.id, r]));
  const gather = {};
  const addSource = (itemId, src) => { (gather[itemId] = gather[itemId] || []).push(src); };
  for (const e of ext) {
    const r = resById.get(e.resource_id);
    if (!r) continue;
    const hp = r.max_health || 0;
    if (hp <= 0) continue;
    const req = (e.tool_requirements && e.tool_requirements[0]) || null;   // [toolType, tier, qty]
    const toolType = req ? req[0] : 0, toolTier = req ? req[1] : 0;
    const lreq = (e.level_requirements && e.level_requirements[0]) || null; // [skillId, level]
    const skillId = lreq ? lreq[0] : 0, skillLevel = lreq ? lreq[1] : 0;
    // expected per-action yield of each item (weight * qty), and on-destroy yield of each item (qty * chance)
    const perAction = {}, onDestroy = {};
    for (const s of (e.extracted_item_stacks || [])) {
      try { const stack = s[0][1], id = resolveId(stack[0]), qty = stack[1] || 1, weight = s[1] || 0; if (id) perAction[id] = (perAction[id] || 0) + weight * qty; } catch (_) {}
    }
    const chance = (r.on_destroy_yield_resource_chance != null) ? r.on_destroy_yield_resource_chance : 1;
    for (const y of (r.on_destroy_yield || [])) {
      try { const id = resolveId(y[0]), qty = y[1] || 0; if (id && qty) onDestroy[id] = (onDestroy[id] || 0) + qty * chance; } catch (_) {}
    }
    const itemIds = new Set([...Object.keys(perAction), ...Object.keys(onDestroy)].map(Number));
    for (const id of itemIds) {
      addSource(id, {
        hp, toolType, toolTier, skillId, skillLevel,
        perAction: +(perAction[id] || 0).toFixed(5),
        onDestroy: +(onDestroy[id] || 0).toFixed(5),
      });
    }
  }
  console.log(`Gatherable items: ${Object.keys(gather).length}`);

  const out = { passiveRecipeIds, gather, tools: toolMap, toolTypeMinPower, extractedAt: Date.now() };
  const outPath = path.join(__dirname, 'effortData.json');
  fs.writeFileSync(outPath, JSON.stringify(out));
  console.log(`Saved ${outPath} (${(fs.statSync(outPath).size / 1024).toFixed(0)} KB)`);
})();
