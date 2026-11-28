import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stockSnapshot } from '../server/bitjita.ts';
import { memoryMemo } from '../server/storage.ts';
import { LIVE_REFRESH_SECONDS, dueForAutoRead, showsLive } from '../src/lib/refresh.ts';

const MIN = 60_000;

describe('when a page asks for storage again by itself', () => {
  const asked = Date.parse('2026-11-27T12:00:00Z');

  it('looks again every 15 seconds while it is on screen, never more often', () => {
    expect(LIVE_REFRESH_SECONDS).toBe(15);
    expect(dueForAutoRead(asked + 5_000, asked)).toBe(false);
    expect(dueForAutoRead(asked + 14_999, asked)).toBe(false);
    expect(dueForAutoRead(asked + 15_000, asked)).toBe(true);
    // A tab that was in the background for an hour asks once when it comes back, not sixty times.
    expect(dueForAutoRead(asked + 60 * MIN, asked)).toBe(true);
    expect(dueForAutoRead(asked + 60 * MIN + 1_000, asked + 60 * MIN)).toBe(false);
  });

  it('calls itself live only while answers from the relay keep arriving', () => {
    expect(showsLive(asked + 15_000, true, asked)).toBe(true);
    // Two looks in a row went unanswered.
    expect(showsLive(asked + 46_000, true, asked)).toBe(false);
    // Read the older way (no relay could be reached): not live, however recent.
    expect(showsLive(asked + 1_000, false, asked)).toBe(false);
    expect(showsLive(asked + 1_000, undefined, asked)).toBe(false);
  });
});

/**
 * A stand-in for Bitjita with one claim and one member. Every answer for chest
 * contents carries a different quantity, so a new read can be told from a reused one.
 */
describe('how often Bitjita is actually asked', () => {
  const asked: string[] = [];
  let chestsDown = false;

  beforeEach(() => {
    asked.length = 0;
    chestsDown = false;
    vi.useFakeTimers({ now: new Date('2026-11-23T12:00:00Z') });
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const path = String(input).replace('https://bitjita.com/api', '');
      asked.push(path);
      const answers: Record<string, unknown> = {
        '/claims/c1': { claim: { entityId: 'c1', name: 'Nowhere', tier: 5 } },
        '/claims/c1/members': { members: [{ playerEntityId: 'p1', userName: 'chels' }] },
        '/claims/c1/inventories': { buildings: [{ entityId: 1, buildingName: 'Chest', inventory: [{ contents: { item_id: 5, item_type: 0, quantity: asked.length } }] }] },
        '/claims/c1/buildings': [],
        '/players/p1/crafts?completed=all': { craftResults: [] },
        '/players/p1/passive-crafts?status=all': { craftResults: [] },
        '/players/p1/inventories': { inventories: [] },
        '/players/p1/housing': [],
      };
      if (chestsDown && path === '/claims/c1/inventories') return new Response('busy', { status: 503 });
      return path in answers ? new Response(JSON.stringify(answers[path])) : new Response('', { status: 404 });
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const CONTENTS = ['/claims/c1/inventories', '/players/p1/crafts?completed=all', '/players/p1/inventories', '/players/p1/passive-crafts?status=all'];
  const since = (mark: number) => asked.slice(mark).sort();

  it('one read serves every ask for 15 minutes, then the next ask costs one read of the contents', async () => {
    const memo = memoryMemo();
    const first = await stockSnapshot(memo, 'c1', ['p1']);
    let mark = asked.length;
    expect(mark).toBe(8);

    // Any number of pages asking by themselves inside the 15 minutes costs nothing.
    vi.advanceTimersByTime(10 * MIN);
    for (let page = 0; page < 20; page++) expect((await stockSnapshot(memo, 'c1', ['p1'])).at).toBe(first.at);
    expect(since(mark)).toEqual([]);

    // Once it is 15 minutes old, the first ask reads again and the rest share that read.
    vi.advanceTimersByTime(5 * MIN + 15_000);
    const second = await stockSnapshot(memo, 'c1', ['p1']);
    expect(second.at).not.toBe(first.at);
    expect(since(mark)).toEqual(CONTENTS);
    mark = asked.length;
    for (let page = 0; page < 20; page++) expect((await stockSnapshot(memo, 'c1', ['p1'])).at).toBe(second.at);
    expect(since(mark)).toEqual([]);
  });

  it('pressing refresh still gets a newer read, but not inside 5 minutes', async () => {
    const memo = memoryMemo();
    const first = await stockSnapshot(memo, 'c1', ['p1']);
    const mark = asked.length;

    vi.advanceTimersByTime(4 * MIN);
    expect((await stockSnapshot(memo, 'c1', ['p1'], true)).at).toBe(first.at);
    expect(since(mark)).toEqual([]);

    vi.advanceTimersByTime(2 * MIN);
    expect((await stockSnapshot(memo, 'c1', ['p1'], true)).at).not.toBe(first.at);
    expect(since(mark)).toEqual(CONTENTS);
  });

  it('keeps showing the last complete read when a newer one fails, and backs off for 5 minutes', async () => {
    const memo = memoryMemo();
    const good = await stockSnapshot(memo, 'c1', ['p1']);

    vi.advanceTimersByTime(16 * MIN);
    chestsDown = true;
    let mark = asked.length;
    const during = await stockSnapshot(memo, 'c1', ['p1']);
    expect(during.at).toBe(good.at);
    expect(during.locations).toEqual(good.locations);
    expect(during.problems[0]).toMatch(/still the one from earlier/);
    expect(since(mark)).toEqual(CONTENTS);

    // Nobody can make it try again straight away, not even with the refresh button.
    mark = asked.length;
    vi.advanceTimersByTime(2 * MIN);
    expect((await stockSnapshot(memo, 'c1', ['p1'])).at).toBe(good.at);
    expect((await stockSnapshot(memo, 'c1', ['p1'], true)).at).toBe(good.at);
    expect(since(mark)).toEqual([]);

    // After the pause, with Bitjita well again, the next ask gets a complete new read.
    vi.advanceTimersByTime(4 * MIN);
    chestsDown = false;
    const after = await stockSnapshot(memo, 'c1', ['p1']);
    expect(after.at).not.toBe(good.at);
    expect(after.problems).toEqual([]);
    // Only the part that failed is asked for again; the rest was read a few minutes ago.
    expect(since(mark)).toEqual(['/claims/c1/inventories']);
  });
});
