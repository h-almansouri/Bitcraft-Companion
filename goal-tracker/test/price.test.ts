import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RecipeBook } from '../src/engine/book.ts';
import { inflate } from '../src/engine/gamedata.ts';
import { Router } from '../src/engine/routes.ts';
import { BOUGHT, buildProducts, buildView, rawMaterials } from '../src/lib/derive.ts';
import type { GameCtx } from '../src/lib/game.ts';
import { costText, eachText, goldFor } from '../src/lib/price.ts';
import type { Push } from '../src/lib/shapes.ts';

/**
 * What travelers charge, as Nowhere's T4 heart push needs it: 7 Insulating Wires and
 * 8 Cooling Capacitors, which take parts only Rumbagh sells.
 */
const game = inflate(JSON.parse(readFileSync('public/gamedata.json', 'utf8')));
const book = new RecipeBook(game);
const ctx = { game, book, router: new Router(book, { sold: game.sold }) } as unknown as GameCtx;
const name = (id: string) => book.thing(id)?.name ?? id;

const COOLING_ENERGY = 'i.4000';
const RIPPED_NOTES = 'i.4002';
const HEART_WIRING = 'i.72520590';
const FLUX = 'i.805422378';

describe('traveler prices', () => {
  it('knows what Rumbagh charges for the heart parts', () => {
    expect(game.sold[COOLING_ENERGY]).toBe('Rumbagh');
    expect(eachText(game.price[COOLING_ENERGY], name)).toBe('1,000 gold each');
    expect(eachText(game.price[RIPPED_NOTES], name)).toBe('1,000 gold each');
    expect(eachText(game.price[HEART_WIRING], name)).toBe('500 gold each');
    expect(goldFor(game.price[COOLING_ENERGY], 8)).toBe(8000);
    expect(goldFor(game.price[COOLING_ENERGY], 0)).toBe(0);
  });

  it('writes swaps out by what they take, and counts whole trades', () => {
    const swap = { per: 1, cost: [{ id: 'i.1', qty: 300 }, { id: RIPPED_NOTES, qty: 2 }] };
    expect(costText(swap, 3, name)).toBe('900 gold + 6 Ripped Notes');
    expect(goldFor(swap, 3)).toBe(900);
    const bundle = { per: 10, cost: [{ id: 'i.1', qty: 500 }] };
    expect(eachText(bundle, name)).toBe('500 gold per 10');
    expect(goldFor(bundle, 11)).toBe(1000);
  });

  it('adds up the T4 heart push shopping list', () => {
    const wires = Object.values(game.things).find((t) => t.name === 'Insulating Wires')!.id;
    const push: Push = { slug: 'hearts', name: 'Hearts', kind: 'custom', status: 'active', goals: [{ id: wires, qty: 7 }, { id: 'i.4100', qty: 8 }], players: [], excluded: [], routes: {}, countCrafts: true, createdAt: '', updatedAt: '' };
    const view = buildView(ctx, push, null);
    const buys = rawMaterials(buildProducts(ctx, view)).filter((r) => r.step.profession === BOUGHT);
    const gold = Object.fromEntries(buys.map((r) => [r.step.id, goldFor(game.price[r.step.id], r.step.toGo)]));
    // From empty storage the push also buys 320 Metalworking Flux at 10 gold each.
    expect(gold).toEqual({ [COOLING_ENERGY]: 8000, [RIPPED_NOTES]: 8000, [HEART_WIRING]: 3500, [FLUX]: 3200 });
  });
});
