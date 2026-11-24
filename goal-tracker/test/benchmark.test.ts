import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inflate } from '../src/engine/gamedata.ts';
import { RecipeBook } from '../src/engine/book.ts';
import { Router } from '../src/engine/routes.ts';
import { plan } from '../src/engine/planner.ts';

/**
 * The real-world check: Nowhere's "T5 up n station" push as BitCraftSync showed it
 * on 2026-11-23. Given the same goals and the same stock, our planner has to arrive
 * at the same "needed" number for every one of its 249 materials.
 */
const game = inflate(JSON.parse(readFileSync('public/gamedata.json', 'utf8')));
const bench = JSON.parse(readFileSync('test/benchmark/t5-push.json', 'utf8'));
const book = new RecipeBook(game);
const router = new Router(book, { sold: game.sold });

const expected = new Map<string, { needed: number; have: number }>();
for (const row of (bench.expected as string).split(' ')) {
  const [id, needed, have] = row.split(':');
  expected.set(id, { needed: Number(needed), have: Number(have) });
}
const stock = new Map([...expected].map(([id, v]) => [id, v.have]));
const goals = bench.goals.map((g: { id: string; quantity: number }) => ({ id: g.id, qty: g.quantity }));

/**
 * Where a material has several legitimate routes, BitCraftSync and our planner
 * default differently. These pin BitCraftSync's picks so the numbers are comparable:
 * fish oil from trophy fish (we default to the fish that takes least effort), and
 * the "Female Scrofa" variant of the T4 animal (we default to the huntable one).
 */
const BITCRAFTSYNC_ROUTES = {
  'i.2110010': 'r1285498232', // Simple Fish Oil  <- Enormous Carbot
  'i.3110010': 'r2060944880', // Infused Fish Oil <- Enormous Murrel
  'i.4110010': 'r1033651277', // Fine Fish Oil    <- Enormous Varkel
  'i.4080001': 'r306002', // Fine Raw Pelt    <- Female Scrofa
  'i.921543186': 'r306002', // Fine Animal Hair <- Female Scrofa
};

/**
 * The three rows where we knowingly disagree, with the number we stand behind.
 *  - Gorbu / Centro: BitCraftSync asks for 1 and 4 more fish than its own totals use.
 *  - Sturdy Stone Chunk: BitCraftSync smashes 445 chunks to get 40 braxite as a side
 *    drop (and counts that drop at 0.09 per chunk; the game table works out to 0.16).
 *    We plan the 88 chunks the pebbles need and list braxite as its own thing to mine.
 */
const KNOWN_DIFFERENCES: Record<string, number> = {
  'c.6002': 57,
  'c.6003': 13,
  'c.2003': 88,
};

describe('T5 claim push benchmark', () => {
  const result = plan(book, router, goals, stock, { routes: BITCRAFTSYNC_ROUTES });

  it('plans exactly the same set of materials', () => {
    const ours = [...result.nodes.keys()].sort();
    expect(ours).toEqual([...expected.keys()].sort());
  });

  it('matches the needed quantity for every material', () => {
    const wrong: string[] = [];
    for (const [id, exp] of expected) {
      const want = KNOWN_DIFFERENCES[id] ?? exp.needed;
      const got = result.nodes.get(id)?.needed ?? NaN;
      if (Math.abs(got - want) >= 0.5) wrong.push(`${book.name(id)} (${id}): planned ${got}, expected ${want}`);
    }
    expect(wrong).toEqual([]);
  });

  it('splits plant fiber the way the push actually uses it', () => {
    const fiber = result.nodes.get('i.5130001')!;
    expect(fiber.needed).toBe(6220);
    const by = Object.fromEntries(fiber.uses.map((u) => [book.name(u.into!), u.qty]));
    expect(by).toEqual({
      'Exquisite Spool Of Thread': 6160,
      'Exquisite Tailoring Station': 40,
      'Exquisite Carpentry Station': 20,
    });
  });

  it('keeps some roots as roots and turns the rest into fiber', () => {
    const roots = result.nodes.get('c.1632765422')!;
    expect(roots.needed).toBe(65);
    expect(roots.toGo).toBe(28);
    const intoFiber = roots.uses.find((u) => u.into === 'i.5130001')!;
    expect(intoFiber.qty).toBe(61);
    expect(roots.uses.filter((u) => u.into !== 'i.5130001').reduce((n, u) => n + u.qty, 0)).toBe(4);
  });

  it('needs no route overrides to get a complete plan', () => {
    const plain = plan(book, router, goals, stock);
    expect(plain.warnings).toEqual([]);
    // Same push, our own defaults: everything except the fish and animal choices lands identically.
    let same = 0;
    for (const [id, exp] of expected) if (Math.abs((plain.nodes.get(id)?.needed ?? NaN) - exp.needed) < 0.5) same++;
    expect(same).toBeGreaterThanOrEqual(240);
  });
});
