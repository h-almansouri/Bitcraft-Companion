// Writes public/food-buffs.json: what each food does beyond restoring health and stamina,
// for the free food list on the About page. Run: npm run food-buffs
// Source: the same daily dump of the game's tables as `npm run gamedata`
// (BitCraftToolBox/BitCraft_GameData, branch cereal/cs).
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BASE = 'https://raw.githubusercontent.com/BitCraftToolBox/BitCraft_GameData/cereal/cs/static/';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'public', 'food-buffs.json');

async function table(name) {
  const res = await fetch(BASE + name + '.json');
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.json();
}

const [foods, buffs, types] = await Promise.all([table('food_desc'), table('buff_desc'), table('buff_type_desc')]);
const buffById = new Map(buffs.map((b) => [b.id, b]));
const typeName = new Map(types.map((t) => [t.id, t.name]));

/**
 * { "i.<item id>": [{ name, minutes, stats: [[stat, value, isPercent], ...] }] }
 * Every food also gives "Food Regen" (health and stamina over time); that is left out,
 * so only foods with something extra appear.
 */
const out = {};
for (const food of foods) {
  const extra = [];
  for (const { buff_id, duration } of food.buffs ?? []) {
    const buff = buffById.get(buff_id);
    if (!buff || typeName.get(buff.buff_type_id) === 'Food Regen' || !buff.stats?.length) continue;
    extra.push({ name: buff.description, minutes: Math.round((duration || buff.duration || 0) / 60), stats: buff.stats.map((s) => [s.id, s.value, s.is_pct ? 1 : 0]) });
  }
  if (extra.length) out['i.' + food.item_id] = extra;
}

await writeFile(OUT, JSON.stringify(out) + '\n');
console.log(`Wrote ${Object.keys(out).length} foods with buffs to ${path.relative(root, OUT)}`);
