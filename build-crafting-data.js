#!/usr/bin/env node
// Build craftingData.json from BitCraft's own game data (BitCraftToolBox/BitCraft_GameData mirror).
// Replaces extract-crafting-data.js, which scraped bitcraft-timer.com — a third-party site whose
// interpretation disagreed with the game on the headline output of 3,812 of 7,620 recipes (it
// pre-expands bundle items into their contents and reorders). This builds the SAME output shape the
// app already consumes, from the authoritative tables:
//
//   item_desc / cargo_desc          → items   (cargo ids offset by +4e9, the app's existing convention)
//   crafting_recipe_desc            → recipes (inputs/outputs/skill/building/tool/actions/time/stamina)
//   item_list_desc                  → bundle expansion: an output item with item_list_id > 0 expands to
//                                     its possible contents — quantity = the FIRST possibility's roll,
//                                     quantityMin/Max = extremes across all possibilities (absent = 0).
//                                     The Planner's crafting trees depend on this expansion; the crafts
//                                     tab shows the true bundle headline via /itemdefs recipeOuts.
//   skill_desc                      → skills
//
// Name templates ("Husk into {0}", "Package {1} into {0}") resolve {0} from the first CRAFTED stack and
// {1} from the first CONSUMED stack — the raw stacks, not the expansion, so names match what the game
// (and bitjita) display. Run: node build-crafting-data.js [--out craftingData.json]
//
// Also a module: proxy.js rebuilds with it whenever the mirror's tables change (see "Crafting data" there),
// so the committed file is the fallback and the starting point, not the only copy that's ever current.
// Each build records the ETags of the tables it was made from (sourceEtags) so that check needs no download.
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');

const GAMEDATA = '/BitCraftToolBox/BitCraft_GameData/refs/heads/sats-json/static/';
const CARGO_BASE = 4000000000;                    // GAME_CARGO_ID_BASE in the app
const RARITY = ['', 'Common', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Mythic'];   // RARITY_NAMES in index.html
// The mirror's tables the build reads, under the names buildCraftingData takes them by.
const SOURCES = { items: 'item_desc.json', cargos: 'cargo_desc.json', recipes: 'crafting_recipe_desc.json', lists: 'item_list_desc.json', skills: 'skill_desc.json' };

// One request for a mirror file: GET resolves { etag, json }, HEAD resolves { etag }. raw.githubusercontent.com's
// ETag is a SHA-256 of the file, so comparing it with the one a build recorded tells whether that table changed
// without downloading it (~17MB for all five).
function ghRequest(file, method) {
  return new Promise((resolve, reject) => {
    const r = https.request({ hostname: 'raw.githubusercontent.com', path: GAMEDATA + file, method, headers: { 'User-Agent': 'BitcraftCompanion/1.0' } }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(file + ': HTTP ' + res.statusCode)); }
      const etag = res.headers.etag || '';
      if (method === 'HEAD') { res.resume(); return resolve({ etag }); }
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('error', reject);   // connection dropped mid-body: 'end' never comes, so without this the promise would hang
      res.on('end', () => { try { resolve({ etag, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch (e) { reject(new Error(file + ': ' + e.message)); } });
    });
    r.on('error', reject);
    r.setTimeout(60000, () => r.destroy(new Error(file + ': timeout')));
    r.end();
  });
}

// The mirror's current ETag for every source table, as { file: etag } ('' when it sent none).
async function sourceEtags() {
  const files = Object.values(SOURCES);
  const heads = await Promise.all(files.map(f => ghRequest(f, 'HEAD')));
  const out = {}; files.forEach((f, i) => { out[f] = heads[i].etag; }); return out;
}

// Download every source table: { tables: { items, cargos, recipes, lists, skills }, etags: { file: etag } }.
async function fetchSources() {
  const keys = Object.keys(SOURCES);
  const got = await Promise.all(keys.map(k => ghRequest(SOURCES[k], 'GET')));
  const tables = {}, etags = {};
  keys.forEach((k, i) => { tables[k] = got[i].json; etags[SOURCES[k]] = got[i].etag; });
  return { tables, etags };
}

// SATS sum variant index: [idx, payload] → idx. Stack item_type: 0 = Item, 1 = Cargo.
const variant = v => Array.isArray(v) ? v[0] : (+v || 0);
// A stack ([item_id, qty, [type], …]) mapped into the app's id space.
const stackId = s => variant(s[2]) === 1 ? CARGO_BASE + s[0] : s[0];

// The raw tables → the craftingData.json object. sourceEtags is stored as-is (what fetchSources returned).
function buildCraftingData({ items, cargos, recipes, lists, skills }, sourceEtags) {
  const itemById = new Map(items.map(x => [x.id, x]));
  const listById = new Map(lists.map(x => [x.id, x]));

  const outItems = [];
  const pushItem = (x, base) => outItems.push({
    id: base + x.id, name: x.name || '', description: x.description || '',
    tier: x.tier != null ? x.tier : -1, tag: x.tag || '',
    rarity: RARITY[variant(x.rarity)] || 'Common', iconAssetName: x.icon_asset_name || '',
  });
  items.forEach(x => pushItem(x, 0));
  cargos.forEach(x => pushItem(x, CARGO_BASE));

  // name in the app's id space (for template resolution and sanity logs)
  const nameById = new Map(outItems.map(x => [x.id, x.name]));

  // Expand one crafted stack. Plain item/cargo → itself; an ITEM whose desc carries item_list_id > 0 →
  // the list's contents. quantity = first possibility's roll (matches the shape consumers were built
  // against); min/max across ALL possibilities, counting a possibility the item is absent from as 0.
  function expandOutput(stack) {
    const isItem = variant(stack[2]) === 0;
    const desc = isItem ? itemById.get(stack[0]) : null;
    const list = desc && desc.item_list_id > 0 ? listById.get(desc.item_list_id) : null;
    if (!list || !(list.possibilities || []).length) {
      return [{ itemId: stackId(stack), quantity: +stack[1] || 1 }];
    }
    const poss = list.possibilities;                       // [[probability, [stacks…]], …]
    const agg = new Map();                                 // mapped id → {first, min, max}
    poss.forEach((p, pi) => {
      const counts = new Map();
      (p[1] || []).forEach(s => counts.set(stackId(s), (counts.get(stackId(s)) || 0) + (+s[1] || 0)));
      // every id seen anywhere participates in min/max for EVERY possibility (absent = 0)
      counts.forEach((q, id) => {
        if (!agg.has(id)) agg.set(id, { first: pi === 0 ? q : 0, min: Infinity, max: -Infinity, seenFirst: pi === 0 });
        else if (pi === 0) { const a = agg.get(id); a.first = q; a.seenFirst = true; }
      });
    });
    agg.forEach((a, id) => {
      poss.forEach(p => {
        const q = (p[1] || []).filter(s => stackId(s) === id).reduce((t, s) => t + (+s[1] || 0), 0);
        if (q < a.min) a.min = q;
        if (q > a.max) a.max = q;
      });
    });
    const mult = +stack[1] || 1;                           // crafting N bundles multiplies the contents
    return [...agg.entries()].map(([id, a]) => ({
      itemId: id,
      quantity: (a.seenFirst ? a.first : a.max) * mult,
      quantityMin: (isFinite(a.min) ? a.min : 0) * mult,
      quantityMax: (isFinite(a.max) ? a.max : 0) * mult,
    }));
  }

  const outRecipes = [];
  recipes.forEach(r => {
    const crafted = r.crafted_item_stacks || [];
    if (!crafted.length) return;                           // nothing produced — not a craftable the app can use
    const consumed = r.consumed_item_stacks || [];
    const inputs = consumed.map(s => ({ itemId: stackId(s), quantity: +s[1] || 1 }));
    const outputs = crafted.flatMap(expandOutput);
    // {0} = first crafted stack's item, {1} = first consumed stack's item — the RAW stacks (bundle names),
    // which is what the game and bitjita display.
    const name = (r.name || '')
      .replace(/\{0\}/g, nameById.get(stackId(crafted[0])) || '?')
      .replace(/\{1\}/g, consumed.length ? (nameById.get(stackId(consumed[0])) || '?') : '?');
    const lvl = (r.level_requirements || [])[0] || [0, 0];
    const bld = Array.isArray(r.building_requirement) ? r.building_requirement[1] || {} : {};
    const tool = (r.tool_requirements || [])[0] || [0, 0];
    outRecipes.push({
      id: r.id, name,
      inputs, outputs,
      skillId: +lvl[0] || 0, skillLevel: +lvl[1] || 0,
      buildingType: +bld.building_type || 0, buildingTier: +bld.tier || 0,
      toolType: +tool[0] || 0, toolLevel: +tool[1] || 0,
      actionsRequired: +r.actions_required || 0,
      timeRequirement: +r.time_requirement || 0,
      staminaRequirement: +r.stamina_requirement || 0,
      isPassive: !!r.is_passive,
    });
  });

  const outSkills = skills.map(s => ({ id: s.id, name: s.name || '' })).filter(s => s.name);

  return { items: outItems, recipes: outRecipes, skills: outSkills, extractedAt: new Date().toISOString(), source: 'BitCraftToolBox/BitCraft_GameData', sourceEtags: sourceEtags || {} };
}

module.exports = { SOURCES, sourceEtags, fetchSources, buildCraftingData };

if (require.main === module) {
  const OUT = (() => { const i = process.argv.indexOf('--out'); return i > 0 ? process.argv[i + 1] : 'craftingData.json'; })();
  (async () => {
    console.log('fetching game data…');
    const { tables, etags } = await fetchSources();
    const { items, cargos, recipes, lists, skills } = tables;
    console.log(`  item_desc ${items.length} · cargo_desc ${cargos.length} · recipes ${recipes.length} · item_lists ${lists.length} · skills ${skills.length}`);
    const built = buildCraftingData(tables, etags);
    fs.writeFileSync(path.resolve(__dirname, OUT), JSON.stringify(built));
    const dropped = recipes.length - built.recipes.length;
    console.log(`wrote ${OUT}: ${built.items.length} items · ${built.recipes.length} recipes (${dropped} with no crafted output dropped) · ${built.skills.length} skills`);
  })().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
}
