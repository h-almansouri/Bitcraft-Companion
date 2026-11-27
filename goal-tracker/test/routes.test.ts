import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RecipeBook } from '../src/engine/book.ts';
import { inflate } from '../src/engine/gamedata.ts';
import { plan } from '../src/engine/planner.ts';
import { Router } from '../src/engine/routes.ts';
import { pickRoute, standIns } from '../src/lib/derive.ts';
import type { GameCtx } from '../src/lib/game.ts';

/**
 * Butchering a Plains Ox or a Dromai gives the same pelt, meat and hair. Nowhere's T6 push
 * needs pelts and hair; picking Ox for the pelt alone once planned 949 Ox plus 876 Dromai
 * instead of 949 animals that cover both.
 */
const game = inflate(JSON.parse(readFileSync('public/gamedata.json', 'utf8')));
const book = new RecipeBook(game);
const router = new Router(book, { sold: game.sold });
const ctx = { game, book, router } as unknown as GameCtx;
const id = (name: string) => Object.values(game.things).find((t) => t.name === name)!.id;

const PELT = id('Exquisite Raw Pelt');
const HAIR = id('Exquisite Animal Hair');
const MEAT = id('Exquisite Raw Meat');
const OX = id('Plains Ox');
const DROMAI = id('Dromai');
const butcher = (animal: string) => router.crafts(PELT).find((r) => r.inputs[0].id === animal)!;
const goals = [
  { id: id('Exquisite Cleaned Pelt'), qty: 2847 },
  { id: HAIR, qty: 219 },
];
const animals = (routes: Record<string, string | null>) => {
  const p = plan(book, router, goals, new Map(), { routes });
  return { ox: p.nodes.get(OX)?.needed ?? 0, dromai: p.nodes.get(DROMAI)?.needed ?? 0 };
};

describe('picking how a shared harvest is done', () => {
  it('moves the other outputs of the hunt along with the one picked', () => {
    const routes = pickRoute(ctx, {}, PELT, butcher(OX).id);
    expect(routes).toEqual({ [PELT]: butcher(OX).id, [HAIR]: butcher(OX).id, [MEAT]: butcher(OX).id });
    expect(animals(routes)).toEqual({ ox: 949, dromai: 0 });
  });

  it('puts them all back together on "use default"', () => {
    const picked = pickRoute(ctx, {}, PELT, butcher(OX).id);
    expect(pickRoute(ctx, picked, HAIR, undefined)).toEqual({});
    expect(animals({})).toEqual({ ox: 0, dromai: 949 });
  });

  it('leaves a pick alone when that output is not coming from a twin of the recipe', () => {
    expect(pickRoute(ctx, { [HAIR]: null }, PELT, butcher(OX).id)).toEqual({ [PELT]: butcher(OX).id, [HAIR]: null, [MEAT]: butcher(OX).id });
  });

  it('names the other animal on the gather card', () => {
    const p = plan(book, router, goals, new Map(), { routes: pickRoute(ctx, {}, PELT, butcher(OX).id) });
    const view = { plan: p, scratch: p } as Parameters<typeof standIns>[1];
    expect(standIns(ctx, view, OX)).toEqual([DROMAI]);
  });
});
