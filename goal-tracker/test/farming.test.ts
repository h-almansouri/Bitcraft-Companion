import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RecipeBook } from '../src/engine/book.ts';
import { inflate } from '../src/engine/gamedata.ts';
import { plan } from '../src/engine/planner.ts';
import { Router } from '../src/engine/routes.ts';

/**
 * Farm seeds multiply when replanted (one seed grows a plant that gives 3 back), so players
 * keep a stock going. The planner can't follow that loop and used to "upgrade" five lower-tier
 * seeds into each one instead, five-fold per tier: Nowhere's T6 push asked for 267,825 Basic
 * Wispweave Seeds and 106,765 Sagi Birds (for the fertilizer) it never needed.
 */
const game = inflate(JSON.parse(readFileSync('public/gamedata.json', 'utf8')));
const book = new RecipeBook(game);
const router = new Router(book, { sold: game.sold });
const id = (name: string) => Object.values(game.things).find((t) => t.name === name)!.id;
const node = (p: ReturnType<typeof plan>, name: string) => p.nodes.get(id(name));

describe('farm seeds', () => {
  it('knows which seeds keep themselves going when replanted', () => {
    const wispweave = router.farming(id('Basic Wispweave Seeds'))!;
    expect(book.name(wispweave.plant)).toBe('Basic Wispweave Plant');
    expect(wispweave.perPlant).toBe(3);
    expect(router.farming(id('Peerless Embergrain Seeds'))?.perPlant).toBe(1.6);
    const farmed = Object.keys(game.things).filter((t) => router.farming(t));
    expect(farmed).toHaveLength(30);
    expect(farmed.every((t) => / (Wispweave|Embergrain|Starbulb) Seeds$/.test(book.name(t)))).toBe(true);
  });

  it('leaves everything else alone', () => {
    for (const name of ['Sturdy Plank', 'Exquisite Wispweave Plant', 'Basic Fertilizer', 'Fine Trunk']) expect(router.farming(id(name))).toBeNull();
  });

  it('plans the seeds a plant needs as farmed, never upgraded from the tier below', () => {
    expect(router.choose(id('Exquisite Wispweave Seeds'))).toBeNull();
    const p = plan(book, router, [{ id: id('Exquisite Wispweave Plant'), qty: 100 }], new Map());
    const seeds = node(p, 'Exquisite Wispweave Seeds')!;
    expect(seeds.needed).toBe(100);
    expect(seeds.steps).toHaveLength(0);
    expect(node(p, 'Fine Wispweave Seeds')).toBeUndefined();
    expect(node(p, 'Basic Wispweave Plant')).toBeUndefined();
  });

  it('keeps a low-tier cloth chain small', () => {
    // 1,750 filament is 350 husked plants: 350 seeds and 350 fertilizer, not hundreds of thousands.
    const p = plan(book, router, [{ id: id('Rough Wispweave Filament'), qty: 1750 }], new Map());
    expect(node(p, 'Basic Wispweave Seeds')?.needed).toBe(350);
    expect(node(p, 'Basic Fertilizer')?.needed).toBe(350);
  });

  it('still honours a push that picks the upgrade on purpose', () => {
    const upgrade = router.crafts(id('Infused Wispweave Seeds')).find((r) => r.inputs.some((i) => i.id === id('Simple Wispweave Seeds')))!;
    const p = plan(book, router, [{ id: id('Infused Wispweave Seeds'), qty: 10 }], new Map(), { routes: { [id('Infused Wispweave Seeds')]: upgrade.id } });
    expect(node(p, 'Infused Wispweave Seeds')!.steps[0].recipe.id).toBe(upgrade.id);
    expect(node(p, 'Simple Wispweave Seeds')?.needed).toBe(50);
  });
});
