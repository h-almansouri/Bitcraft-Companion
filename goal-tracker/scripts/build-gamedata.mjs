// Boils the raw game tables (data/raw/*.json) down to one compact file the site
// loads: public/gamedata.json. Run with `npm run gamedata` (add --offline to
// rebuild from the tables already on disk without downloading again).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fetchTables, RAW_DIR } from './fetch-gamedata.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'public', 'gamedata.json');

const load = async (table, optional = false) => {
  try {
    return JSON.parse(await readFile(path.join(RAW_DIR, table + '.json'), 'utf8'));
  } catch (err) {
    if (optional) return [];
    throw err;
  }
};

const RARITY = ['Default', 'Common', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Mythic'];
const round = (n) => Math.round(n * 1e6) / 1e6;
const ref = (stack) => (stack.item_type === 'Cargo' ? 'c.' : 'i.') + stack.item_id;

export async function build({ offline = false } = {}) {
  if (!offline) {
    console.log('Fetching BitCraft game tables...');
    await fetchTables();
  }

  const [items, cargo, lists, crafting, extraction, resources, buildings, buildingTypes, construction, skills, npcs, tasks, techs, enemies, tradeOrders] =
    await Promise.all([
      load('item_desc'),
      load('cargo_desc'),
      load('item_list_desc'),
      load('crafting_recipe_desc'),
      load('extraction_recipe_desc'),
      load('resource_desc'),
      load('building_desc'),
      load('building_type_desc'),
      load('construction_recipe_desc'),
      load('skill_desc'),
      load('npc_desc'),
      load('traveler_task_desc'),
      load('claim_tech_desc'),
      load('enemy_desc', true),
      load('traveler_trade_order_desc', true),
    ]);

  const itemById = new Map(items.map((i) => [i.id, i]));
  const listById = new Map(lists.map((l) => [l.id, l]));

  // ---- random-output items ---------------------------------------------------
  // Some "items" are really a dice roll: crafting gives you an output list, and the
  // game picks one possibility by weight. We replace them with what you get on
  // average, which is what matters when planning hundreds of crafts.
  function expand(stack, scale, into, depth = 0) {
    const item = stack.item_type === 'Item' ? itemById.get(stack.item_id) : undefined;
    const list = item?.item_list_id ? listById.get(item.item_list_id) : undefined;
    if (!list || depth > 4) {
      const key = ref(stack);
      into.set(key, (into.get(key) ?? 0) + stack.quantity * scale);
      return;
    }
    const total = list.possibilities.reduce((sum, p) => sum + p.probability, 0);
    if (total <= 0) return;
    for (const p of list.possibilities) {
      for (const inner of p.items) expand(inner, (scale * stack.quantity * p.probability) / total, into, depth + 1);
    }
  }
  const expandAll = (stacks, chanceOf = () => 1) => {
    const into = new Map();
    for (const s of stacks) expand(s, chanceOf(s), into);
    return [...into].filter(([, q]) => q > 0).map(([id, q]) => [id, round(q)]);
  };

  const skillName = Object.fromEntries(skills.map((s) => [s.id, s.name]));
  const stationName = Object.fromEntries(buildingTypes.map((b) => [b.id, b.name]));
  const used = new Set();
  const note = (stacks) => stacks.forEach(([id]) => used.add(id));

  // ---- crafting --------------------------------------------------------------
  // Scrap / Recraft / Reforge are gear recycling and re-rolling, never a way to
  // make materials, and they are a third of the table. Left out.
  const SKIP = /^(Scrap|Recraft|Reforge) /;
  const recipes = [];
  for (const r of crafting) {
    if (SKIP.test(r.name)) continue;
    const inputs = r.consumed_item_stacks.map((s) => [ref(s), round(s.quantity * (s.consumption_chance ?? 1))]);
    const outputs = expandAll(r.crafted_item_stacks);
    if (!outputs.length) continue;
    const kind = /^Unpack /.test(r.name) ? 'unpack' : /^Package /.test(r.name) ? 'pack' : 'craft';
    const level = r.level_requirements?.[0];
    const row = { id: 'r' + r.id, k: kind, n: r.name, i: inputs, o: outputs, a: r.actions_required };
    if (level && level.skill_id !== 1) (row.s = level.skill_id), (row.l = level.level);
    if (r.building_requirement) (row.b = r.building_requirement.building_type), (row.bt = r.building_requirement.tier);
    if (r.is_passive) row.p = 1;
    // The first listed output names the recipe ("Craft {0}") even when it is a dice-roll list.
    const first = r.crafted_item_stacks[0];
    const firstItem = first && first.item_type === 'Item' ? itemById.get(first.item_id) : undefined;
    if (firstItem?.item_list_id) row.on = firstItem.name;
    recipes.push(row);
    note(inputs);
    note(outputs);
  }

  // ---- building --------------------------------------------------------------
  const buildingById = new Map(buildings.map((b) => [b.id, b]));
  const things = [];
  for (const r of construction) {
    const b = buildingById.get(r.building_description_id);
    if (!b) continue;
    const inputs = [
      ...r.consumed_item_stacks.map((s) => ['i.' + s.item_id, s.quantity]),
      ...r.consumed_cargo_stacks.map((s) => ['c.' + s.item_id, s.quantity]),
    ];
    if (r.consumed_building) inputs.push(['b.' + r.consumed_building, 1]);
    const id = 'b.' + b.id;
    const level = r.level_requirements?.[0];
    const row = { id: 'b' + r.id, k: 'build', n: 'Build {0}', i: inputs, o: [[id, 1]], a: r.actions_required };
    if (level && level.skill_id !== 1) (row.s = level.skill_id), (row.l = level.level);
    recipes.push(row);
    note(inputs);
    used.add(id);
  }

  // ---- gathering -------------------------------------------------------------
  const resourceById = new Map(resources.map((r) => [r.id, r]));
  const gather = [];
  for (const r of extraction) {
    const resource = resourceById.get(r.resource_id);
    const outputs = expandAll(
      r.extracted_item_stacks.map((s) => ({ ...s.item_stack, _p: s.probability })),
      (s) => s._p,
    );
    if (!outputs.length) continue;
    const level = r.level_requirements?.[0];
    const row = { id: 'x' + r.id, src: resource?.name ?? 'Unknown', g: resource?.tag ?? '', t: resource?.tier ?? 0, o: outputs, v: r.verb_phrase, r: r.resource_id };
    const tool = r.tool_requirements?.[0];
    if (tool?.level) row.tl = tool.level;
    if (level && level.skill_id !== 1) (row.s = level.skill_id), (row.l = level.level);
    if (r.consumed_item_stacks.length) row.i = r.consumed_item_stacks.map((s) => [ref(s), s.quantity]);
    gather.push(row);
    note(outputs);
  }
  for (const e of enemies) {
    if (!e.huntable || !e.extracted_item_stacks?.length) continue;
    const outputs = expandAll(
      e.extracted_item_stacks.map((s) => ({ ...s.item_stack, _p: s.probability })),
      (s) => s._p,
    );
    if (!outputs.length) continue;
    gather.push({ id: 'e' + e.enemy_type, src: e.name, g: 'Animal', t: e.tier, o: outputs, v: 'Hunt', s: 9, e: e.enemy_type });
    note(outputs);
  }

  // ---- travelers ---------------------------------------------------------------
  const travelers = npcs
    .filter((n) => n.task_skill_check?.length)
    .map((n) => ({
      name: n.name,
      skill: n.task_skill_check[0],
      tasks: tasks
        .filter((t) => n.task_skill_check.includes(t.level_requirement.skill_id))
        .map((t) => {
          const need = t.required_items.map((s) => [ref(s), s.quantity]);
          note(need);
          const coins = t.rewarded_items.filter((s) => s.item_id === 1).reduce((sum, s) => sum + s.quantity, 0);
          return { id: t.id, min: t.level_requirement.min_level, d: t.description, need, coins, xp: Math.round(t.rewarded_experience?.quantity ?? 0) };
        })
        .sort((a, b) => a.min - b.min || a.id - b.id),
    }));

  // What travelers sell, so "can't be crafted" things can say where to buy them.
  const sold = {};
  for (const order of tradeOrders) {
    // The trade table names two travelers by their job rather than their name.
    const alias = { Tamer: 'Alesi', Slayer: 'Ramparte', Twins: 'The Twins' };
    const npc = npcs.find((n) => n.npc_type === order.traveler)?.name ?? (typeof order.traveler === 'string' ? (alias[order.traveler] ?? order.traveler) : undefined);
    for (const s of order.offer_items ?? []) {
      const id = ref(s);
      if (npc && !sold[id]) sold[id] = npc;
      used.add(id);
    }
  }

  // ---- claim upgrades ----------------------------------------------------------
  const townships = techs
    .filter((t) => t.tech_type === 'Settlement' && /^Tier \d+ Township$/.test(t.name))
    .map((t) => {
      const inputs = t.input.map((s) => [ref(s), s.quantity]);
      note(inputs);
      return { tier: t.tier, supplies: t.supplies_cost, inputs };
    })
    .sort((a, b) => a.tier - b.tier);

  // ---- things ------------------------------------------------------------------
  for (const i of items) {
    const id = 'i.' + i.id;
    // Dice-roll container items were replaced by their contents above.
    if (i.item_list_id && !used.has(id)) continue;
    things.push([id, i.name, Math.max(0, i.tier), i.tag ?? '', Math.max(0, RARITY.indexOf(i.rarity))]);
  }
  for (const c of cargo) things.push(['c.' + c.id, c.name, Math.max(0, c.tier), c.tag ?? '', Math.max(0, RARITY.indexOf(c.rarity))]);
  for (const b of buildings) {
    const id = 'b.' + b.id;
    if (!used.has(id)) continue;
    const fn = b.functions?.[0];
    things.push([id, b.name, Math.max(0, fn?.level ?? 0), stationName[fn?.function_type] ?? 'Building', 0, fn?.function_type ?? 0]);
  }

  const out = {
    version: new Date().toISOString().slice(0, 10),
    source: 'BitCraftToolBox/BitCraft_GameData (cereal/cs)',
    rarity: RARITY,
    skills: skillName,
    stations: stationName,
    things,
    recipes,
    gather,
    sold,
    travelers,
    townships,
  };
  await mkdir(path.dirname(OUT), { recursive: true });
  const text = JSON.stringify(out);
  await writeFile(OUT, text);
  console.log(
    `Wrote public/gamedata.json: ${(text.length / 1e6).toFixed(2)} MB, ${things.length} things, ${recipes.length} recipes, ${gather.length} gather sources, ${travelers.reduce((n, t) => n + t.tasks.length, 0)} traveler tasks`,
  );
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await build({ offline: process.argv.includes('--offline') });
}
