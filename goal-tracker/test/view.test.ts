import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RecipeBook } from '../src/engine/book.ts';
import { inflate } from '../src/engine/gamedata.ts';
import { Router } from '../src/engine/routes.ts';
import { buildChains, buildView } from '../src/lib/derive.ts';
import type { GameCtx } from '../src/lib/game.ts';
import type { CraftJob, Push, StockSnapshot } from '../src/lib/shapes.ts';

/**
 * The rope chain as it stood in Nowhere's T5 push: roots -> fiber -> thread ->
 * cloth strip -> rope, with the cloth strips sitting in a friend's loom (a passive
 * craft) rather than in storage. The views have to say so, and still show the chain whole.
 */
const game = inflate(JSON.parse(readFileSync('public/gamedata.json', 'utf8')));
const book = new RecipeBook(game);
const ctx = { game, book, router: new Router(book, { sold: game.sold }) } as unknown as GameCtx;
const id = (name: string) => Object.values(game.things).find((t) => t.name === name)!.id;

const ROOTS = id('Exquisite Plant Roots');
const FIBER = id('Exquisite Plant Fiber');
const THREAD = id('Exquisite Spool Of Thread');
const STRIP = id('Exquisite Cloth Strip');
const ROPE = id('Exquisite Rope');

const push: Push = { slug: 'rope', name: 'Rope', kind: 'custom', status: 'active', goals: [{ id: ROPE, qty: 48 }], players: ['p1'], excluded: [], routes: {}, countCrafts: true, createdAt: '', updatedAt: '' };
const loom = (over: Partial<CraftJob> = {}): CraftJob => ({ id: 'job1', item: STRIP, qty: 50, owner: 'pumapance', ownerId: 'p1', station: 'Exquisite Loom', claim: 'Tortuga Prime', passive: true, progress: 0, total: 0, done: false, shared: false, ...over });
const snapshot = (items: [string, number][], crafts: CraftJob[]): StockSnapshot => ({
  at: '2026-11-23T12:00:00Z',
  claim: { id: 'c1', name: 'Nowhere', tier: 5 },
  locations: [{ id: 'b1', kind: 'claim', owner: 'Nowhere', name: 'Tailoring', detail: 'Sturdy Large Chest', items }],
  crafts,
  problems: [],
});
const jobFor = (view: ReturnType<typeof buildView>, thing: string) => view.todos.find((t) => t.row.id === thing && t.step)!;

describe('game data', () => {
  it('knows which recipes are passive crafts', () => {
    const weave = book.producers(STRIP).find((r) => r.kind === 'craft')!;
    expect(weave).toMatchObject({ station: 'Loom', passive: true });
    expect(book.producers(ROPE).find((r) => r.kind === 'craft')!.passive).toBeUndefined();
  });
});

describe('jobs when an ingredient is still at a station', () => {
  it('does not call rope craftable while its cloth strips are in a loom', () => {
    const view = buildView(ctx, push, snapshot([[THREAD, 4]], [loom()]));
    // The strips count as made, so nothing more is asked of the thread...
    expect(view.rows.get(STRIP)!.node).toMatchObject({ have: 50, toGo: 0 });
    // ...but rope cannot be crafted until they come out.
    const rope = jobFor(view, ROPE);
    expect(rope).toMatchObject({ kind: 'blocked', doable: 0, missing: [] });
    expect(rope.awaiting).toHaveLength(1);
    expect(rope.awaiting![0]).toMatchObject({ id: STRIP, qty: 48 });
    expect(rope.awaiting![0].jobs[0]).toMatchObject({ passive: true, done: false });
    // The loom job itself is listed as being crafted.
    expect(view.todos.find((t) => t.kind === 'progress')).toMatchObject({ qty: 50, job: { passive: true } });
  });

  it('asks for the strips to be collected once the loom has finished', () => {
    const view = buildView(ctx, push, snapshot([], [loom({ done: true })]));
    expect(view.todos.find((t) => t.kind === 'pickup')).toMatchObject({ qty: 50 });
    const rope = jobFor(view, ROPE);
    expect(rope.kind).toBe('blocked');
    expect(rope.awaiting![0].jobs.every((j) => j.done)).toBe(true);
  });

  it('calls rope craftable when the strips are in a chest, and partly so when only some are', () => {
    expect(jobFor(buildView(ctx, push, snapshot([[STRIP, 50]], [])), ROPE)).toMatchObject({ kind: 'craft', doable: 48, awaiting: [] });
    const some = jobFor(buildView(ctx, push, snapshot([[STRIP, 10]], [loom({ qty: 40 })])), ROPE);
    expect(some).toMatchObject({ kind: 'craft', doable: 10, missing: [] });
    expect(some.awaiting![0]).toMatchObject({ id: STRIP, qty: 38 });
  });

  it('works out what went into the loom: 3 thread for every strip', () => {
    const view = buildView(ctx, push, snapshot([], [loom()]));
    const inside = view.loaded.get(THREAD)!;
    expect(inside).toHaveLength(1);
    expect(inside[0]).toMatchObject({ qty: 150, into: { id: STRIP }, job: { station: 'Exquisite Loom' } });
    // Nothing is "inside" a craft that has finished.
    expect(buildView(ctx, push, snapshot([], [loom({ done: true })])).loaded.size).toBe(0);
  });
});

describe('the full picture of a chain', () => {
  const chainOf = (view: ReturnType<typeof buildView>) => buildChains(ctx, view).find((c) => c.stages.some((s) => s.id === ROPE))!;

  it('keeps the chain whole even after the middle of it is covered', () => {
    const view = buildView(ctx, push, snapshot([], [loom()]));
    // As things stand the push no longer asks for thread at all...
    expect(view.rows.get(THREAD)?.node.needed ?? 0).toBe(0);
    // ...yet the picture still runs from roots to rope.
    const chain = chainOf(view);
    expect(chain.stages.map((s) => s.id)).toEqual([ROOTS, FIBER, THREAD, STRIP, ROPE]);
    expect(chain.ends).toEqual([{ id: null, name: 'the push goal', qty: 48 }]);
  });

  it('counts every step against the whole push, and marks what is only at a station', () => {
    const [roots, fiber, thread, strip, rope] = chainOf(buildView(ctx, push, snapshot([], [loom()]))).stages;
    expect(roots).toMatchObject({ total: 58, toGo: 0, onward: 58 });
    expect(fiber).toMatchObject({ total: 5760, toGo: 0, onward: 5760, ratio: { from: 1, to: 100 } });
    expect(thread).toMatchObject({ total: 144, toGo: 0, pending: 0, onward: 144, ratio: { from: 40, to: 1 } });
    expect(strip).toMatchObject({ total: 48, toGo: 0, pending: 48, onward: 48, ratio: { from: 3, to: 1 }, recipe: { passive: true } });
    expect(strip.jobs).toHaveLength(1);
    expect(rope).toMatchObject({ total: 48, toGo: 48, pending: 0 });
  });

  it('shows what is still to do from an empty start', () => {
    const [roots, fiber, thread, strip, rope] = chainOf(buildView(ctx, push, snapshot([[THREAD, 44]], []))).stages;
    expect([roots.toGo, fiber.toGo, thread.toGo, strip.toGo, rope.toGo]).toEqual([40, 4000, 100, 48, 48]);
    expect(thread.total - thread.toGo).toBe(44);
  });

  it('sets aside what a step keeps for a building', () => {
    // A loom takes thread as it is, so that thread must not be woven into strips.
    const withLoom: Push = { ...push, goals: [...push.goals, { id: id('Exquisite Loom'), qty: 1 }] };
    const chain = buildChains(ctx, buildView(ctx, withLoom, snapshot([], []))).find((c) => c.stages.some((s) => s.id === THREAD))!;
    const thread = chain.stages.find((s) => s.id === THREAD)!;
    expect(thread.save.qty).toBeGreaterThan(0);
    expect(thread.save.for).toContain('Exquisite Loom');
    expect(thread.onward).toBe(144);
    expect(thread.total).toBe(thread.onward + thread.save.qty + thread.branches.reduce((sum, b) => sum + b.qty, 0));
  });
});
