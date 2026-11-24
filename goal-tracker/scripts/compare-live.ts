// One-off check: compares what BitCraftSync shows for the claim's push right now
// with what this tool works out from the same moment's storage.
// Usage: node scripts/compare-live.ts <captured-bitcraftsync.json> [http://localhost:3000]
import { readFileSync } from 'node:fs';
import { inflate } from '../src/engine/gamedata.ts';
import { RecipeBook, yieldOf } from '../src/engine/book.ts';
import { Router } from '../src/engine/routes.ts';
import { buildView } from '../src/lib/derive.ts';

const theirs = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const base = process.argv[3] ?? 'http://localhost:3000';
const game = inflate(JSON.parse(readFileSync('public/gamedata.json', 'utf8')));
const book = new RecipeBook(game);
const router = new Router(book, { sold: game.sold });
const ctx: any = { game, book, router };
const get = (path: string) => fetch(base + '/nowhere/api' + path).then((r) => r.json());

const expected = new Map<string, { needed: number; have: number }>();
for (const row of (theirs.rows as string).split(' ')) {
  const [id, needed, have] = row.split(':');
  expected.set(id, { needed: +needed, have: +have });
}

const board: any = await get('/boards/nowhere');
const ours = board.pushes.find((p: any) => p.slug === 'claim-t5-push');
const claim: any = await get('/claim');
const everyone = claim.members.map((m: any) => m.id);
const snapshot: any = await get('/stock?players=' + [...everyone].sort().join(','));
console.log(`BitCraftSync captured ${theirs.capturedAt}; our storage read ${snapshot.at}`);

// ---- how the two setups differ --------------------------------------------------
const names = new Map(claim.members.map((m: any) => [m.id, m.name]));
const notCounted = everyone.filter((id: string) => !theirs.players.includes(id)).map((id: string) => names.get(id));
const chests = snapshot.locations.filter((l: any) => l.kind === 'claim' && l.id !== 'built');
const skipped = chests.filter((l: any) => !theirs.buildings.includes(l.id.slice(1)));
const theirGoals = new Map<string, number>(theirs.goals.map((g: any) => [g.id, g.qty]));
const ourGoals = new Map<string, number>(ours.goals.map((g: any) => [g.id, g.qty]));
console.log('\nSETUP DIFFERENCES');
console.log(' members BitCraftSync does not count:', notCounted.join(', ') || 'none');
console.log(' claim chests BitCraftSync does not count:', skipped.map((l: any) => `${l.name} (${l.items.length} kinds)`).join(', ') || 'none');
console.log(' goals only in BitCraftSync:', [...theirGoals].filter(([id]) => !ourGoals.has(id)).map(([id, q]) => `${q} ${book.name(id)}`).join(', ') || 'none');
console.log(' goals only in ours:', [...ourGoals].filter(([id]) => !theirGoals.has(id)).map(([id, q]) => `${q} ${book.name(id)}`).join(', ') || 'none');
console.log(' goal quantities that differ:', [...ourGoals].filter(([id, q]) => theirGoals.has(id) && theirGoals.get(id) !== q).map(([id, q]) => `${book.name(id)} ours ${q} theirs ${theirGoals.get(id)}`).join(', ') || 'none');

function compare(label: string, push: any) {
  const view = buildView(ctx, push, snapshot);
  let sameNeed = 0;
  let sameHave = 0;
  let both = 0;
  const needDiff: string[] = [];
  const haveDiff: string[] = [];
  const onlyTheirs: string[] = [];
  const onlyOurs: string[] = [];
  for (const [id, exp] of expected) {
    const row = view.rows.get(id);
    if (!row) {
      onlyTheirs.push(`${book.name(id)} (they need ${exp.needed}, have ${exp.have})`);
      continue;
    }
    both++;
    const need = Math.ceil(row.node.needed - 1e-9);
    const have = Math.floor(row.node.have + 1e-9);
    if (need === exp.needed) sameNeed++;
    else needDiff.push(`${book.name(id)}: need ours ${need} / theirs ${exp.needed}`);
    if (have === exp.have) sameHave++;
    else haveDiff.push(`${book.name(id)}: have ours ${have} / theirs ${exp.have}`);
  }
  for (const [id, row] of view.rows) if (!expected.has(id)) onlyOurs.push(`${book.name(id)} (we need ${Math.ceil(row.node.needed)}, have ${Math.floor(row.node.have)})`);
  console.log(`\n=== ${label} ===`);
  console.log(` materials: theirs ${expected.size}, ours ${view.rows.size}, in both ${both}`);
  console.log(` same "needed": ${sameNeed} of ${both}   same "have": ${sameHave} of ${both}`);
  console.log(` progress ours: gathered ${(view.progress.gather.pct * 100).toFixed(1)}%  processed ${(view.progress.process.pct * 100).toFixed(1)}%`);
  console.log(`\n NEEDED differs (${needDiff.length}):\n  ` + (needDiff.join('\n  ') || '-'));
  console.log(`\n HAVE differs (${haveDiff.length}):\n  ` + (haveDiff.join('\n  ') || '-'));
  console.log(`\n ONLY IN BITCRAFTSYNC (${onlyTheirs.length}):\n  ` + (onlyTheirs.join('\n  ') || '-'));
  console.log(`\n ONLY IN OURS (${onlyOurs.length}):\n  ` + (onlyOurs.join('\n  ') || '-'));
  return view;
}

// A: exactly what the tool shows today.
compare('A. Our push as it is set up today', ours);

// B: our engine given BitCraftSync's setup (same goals, same people, same chests, its recipe picks).
const mirrored = {
  ...ours,
  goals: theirs.goals,
  players: theirs.players,
  excluded: skipped.map((l: any) => l.id),
  routes: { 'i.2110010': 'r1285498232', 'i.3110010': 'r2060944880', 'i.4110010': 'r1033651277', 'i.4080001': 'r306002', 'i.921543186': 'r306002' },
};
const view = compare("B. Our engine with BitCraftSync's setup (goals, people, chests, recipe picks)", mirrored);

// ---- the percentage ---------------------------------------------------------------
// BitCraftSync: of the materials on today's list, weight x still-needed over weight x needed.
// It uses its own per-item weights, which we don't have; these two stand-ins bracket it.
for (const [name, weight] of [
  ['every unit counts the same', () => 1],
  ['weighted by our effort per unit', (row: any) => (row.recipe ? (row.recipe.effort ?? 1) / Math.max(yieldOf(row.recipe, row.id), 1e-6) : Math.min(router.costOf(row.id), 60))],
] as const) {
  let total = 0;
  let left = 0;
  for (const row of view.rows.values()) {
    const w = (weight as any)(row);
    total += w * row.node.needed;
    left += w * row.node.toGo;
  }
  console.log(`\n "Today's list" style percentage (${name}): ${(100 * (1 - left / total)).toFixed(1)}%   (BitCraftSync shows ${theirs.overall}%)`);
}
