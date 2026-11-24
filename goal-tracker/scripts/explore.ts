// Debug helper: shows how the route-picker ranks the recipes for a thing.
// Usage: node scripts/explore.ts public/gamedata.json "Sturdy Plank" "Fine Fish Oil"
import { readFileSync } from 'node:fs';
import { inflate } from '../src/engine/gamedata.ts';
import { RecipeBook, yieldOf } from '../src/engine/book.ts';
import { Router } from '../src/engine/routes.ts';
const game = inflate(JSON.parse(readFileSync(process.argv[2], 'utf8')));
const book = new RecipeBook(game);
const router = new Router(book, { sold: game.sold });
const find = (name: string) => Object.values(game.things).filter((t) => t.name === name).map((t) => t.id);
const names = process.argv.slice(3);
for (const n of names) {
  for (const id of n.includes('.') ? [n] : find(n)) {
    console.log(`\n${book.name(id)} ${id}  cost=${router.costOf(id).toFixed(1)}  sold=${game.sold[id] ?? '-'}`);
    const chosen = router.choose(id);
    for (const r of router.crafts(id).slice(0, 6)) console.log(`  ${r === chosen ? '*' : ' '} ${r.id} ${r.name} [${r.inputs.map((i) => book.name(i.id) + 'x' + i.qty).join(' + ')}] -> ${yieldOf(r, id)}  cost/unit=${router.recipeCost(r, id).toFixed(1)} effort=${r.effort}`);
    const g = router.gatherSources(id); if (g.length) console.log(`    gather: ${g.slice(0, 4).map((r) => r.source + ' ' + yieldOf(r, id)).join(', ')}  (${g.length} sources) best cost ${(1 / yieldOf(g[0], id)).toFixed(1)}`);
    const u = router.unpacks(id); if (u.length) console.log(`    unpack: ${u.map((r) => book.name(r.inputs[0].id) + ' -> ' + yieldOf(r, id)).join(', ')}`);
  }
}
