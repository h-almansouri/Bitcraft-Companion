// Downloads the raw BitCraft static tables into data/raw/.
// Source: community-maintained daily dump of the game's own tables
// (BitCraftToolBox/BitCraft_GameData, branch cereal/cs). Run: npm run gamedata
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BASE = 'https://raw.githubusercontent.com/BitCraftToolBox/BitCraft_GameData/cereal/cs/static/';
export const TABLES = [
  'item_desc',
  'cargo_desc',
  'item_list_desc',
  'crafting_recipe_desc',
  'extraction_recipe_desc',
  'resource_desc',
  'building_desc',
  'building_type_desc',
  'construction_recipe_desc',
  'skill_desc',
  'tool_type_desc',
  'npc_desc',
  'traveler_task_desc',
  'claim_tech_desc',
  'enemy_desc',
  'traveler_trade_order_desc',
];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RAW_DIR = path.join(root, 'data', 'raw');

export async function fetchTables() {
  await mkdir(RAW_DIR, { recursive: true });
  for (const table of TABLES) {
    const res = await fetch(BASE + table + '.json');
    if (!res.ok) {
      console.warn(`  skipped ${table}: HTTP ${res.status}`);
      continue;
    }
    const text = await res.text();
    JSON.parse(text); // fail loudly if the dump is malformed
    await writeFile(path.join(RAW_DIR, table + '.json'), text);
    console.log(`  ${table}: ${(text.length / 1e6).toFixed(2)} MB`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log('Fetching BitCraft game tables...');
  await fetchTables();
}
