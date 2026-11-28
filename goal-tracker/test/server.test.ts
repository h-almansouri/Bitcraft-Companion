import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { newDb } from 'pg-mem';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { BOARD_KEY, createApp, type Host, type KV } from '../server/app.ts';
import { fileStore, memoryMemo, memoryStore, postgresStore } from '../server/storage.ts';
import { API } from '../src/lib/claim.ts';
import { BUY_ORDER } from '../src/lib/shapes.ts';

// The server as a Node host runs it, minus anything that would call Bitjita.
const scratch = mkdtempSync(path.join(tmpdir(), 'goal-tracker-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function exercise(store: KV) {
  expect(await store.get('a')).toBeNull();
  await store.put('a', 'one');
  await store.put('b', 'two');
  await store.put('a', 'three');
  expect(await store.get('a')).toBe('three');
  expect(await store.get('b')).toBe('two');
  await store.delete('b');
  expect(await store.get('b')).toBeNull();
}

describe('where the board is kept', () => {
  it('a file keeps what was saved after the server starts again', async () => {
    const dir = path.join(scratch, 'disk');
    await exercise(await fileStore(dir));
    const reopened = await fileStore(dir);
    expect(await reopened.get('a')).toBe('three');
    expect(await reopened.get('b')).toBeNull();
  });

  it('a file survives many saves at once', async () => {
    const dir = path.join(scratch, 'busy');
    const store = await fileStore(dir);
    await Promise.all(Array.from({ length: 25 }, (_, i) => store.put('k' + i, String(i))));
    const reopened = await fileStore(dir);
    for (let i = 0; i < 25; i++) expect(await reopened.get('k' + i)).toBe(String(i));
  });

  it('a Postgres table does the same', async () => {
    // The stand-in database objects to re-running "create table if not exists" unless told not to audit how much of a statement it used; real Postgres has no such objection.
    const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg();
    const pool = new Pool();
    await exercise(await postgresStore(pool));
    // A second server on the same database sees the same board and does not trip over the existing table.
    const again = await postgresStore(pool);
    expect(await again.get('a')).toBe('three');
  });
});

describe('remembering Bitjita answers in memory', () => {
  it('forgets them when their time is up', async () => {
    vi.useFakeTimers();
    try {
      const memo = memoryMemo();
      memo.set('https://x/1', 'hello', 60);
      expect(await memo.get('https://x/1')).toBe('hello');
      vi.advanceTimersByTime(61_000);
      expect(await memo.get('https://x/1')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never grows past its limit', async () => {
    const memo = memoryMemo(10);
    for (let i = 0; i < 50; i++) memo.set('https://x/' + i, 'v' + i, 600);
    let kept = 0;
    for (let i = 0; i < 50; i++) if ((await memo.get('https://x/' + i)) !== null) kept++;
    expect(kept).toBe(10);
    expect(await memo.get('https://x/49')).toBe('v49');
  });
});

describe('the API on a plain Node host', () => {
  const host: Host = { store: memoryStore(), memo: memoryMemo(), durable: true, storage: 'test' };
  const app = createApp(() => host);
  const call = async (method: string, url: string, body?: unknown, key?: string) => {
    const res = await app.request(API + url, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(key ? { 'x-edit-key': key } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: (await res.json()) as any };
  };
  const push = { name: 'Claim T5 push', kind: 'claim-tier', status: 'active', goals: [{ id: 'b.123', qty: 2 }], players: ['111', 'not-a-player'], excluded: [], routes: {}, countCrafts: true };

  it('says it is up without touching anything else', async () => {
    expect(await call('GET', '/health')).toEqual({ status: 200, data: { ok: true, storage: 'test', keepsPushes: true } });
  });

  it('makes the board on first open and keeps pushes in the store', async () => {
    const first = await call('GET', '/boards/nowhere');
    expect(first.data).toMatchObject({ slug: 'nowhere', locked: false, pushes: [] });
    expect(first.data.temporary).toBeUndefined();

    const saved = await call('PUT', '/boards/nowhere/pushes/new', { ...push, assignments: { 'i.5': ['111', BUY_ORDER, 'someone'], 'junk': ['111'] } });
    expect(saved.status).toBe(200);
    expect(saved.data.push).toMatchObject({ slug: 'claim-t5-push', players: ['111'], assignments: { 'i.5': ['111', BUY_ORDER] } });
    expect(JSON.parse((await host.store.get(BOARD_KEY))!).pushes).toHaveLength(1);
  });

  it('keeps a new push off the addresses the site uses for its own pages', async () => {
    // /nowhere/travelers is the Traveler restock page, so a push by that name gets a number.
    const saved = await call('PUT', '/boards/nowhere/pushes/new', { ...push, name: 'Travelers' });
    expect(saved.data.push.slug).toBe('travelers-2');
    expect((await call('DELETE', '/boards/nowhere/pushes/travelers-2')).data.pushes).toHaveLength(1);
  });

  it('keeps who is left out and chest nicknames only on pushes that have them', async () => {
    const plain = await call('PUT', '/boards/nowhere/pushes/new', { ...push, name: 'Old style' });
    expect(plain.data.push.leftOut).toBeUndefined();
    expect(plain.data.push.excludedNames).toBeUndefined();
    const following = await call('PUT', '/boards/nowhere/pushes/new', { ...push, name: 'New style', leftOut: ['222', '222', 'nope'], excludedNames: [' Tool mats ', ''] });
    expect(following.data.push).toMatchObject({ leftOut: ['222'], excludedNames: ['Tool mats'] });
    await call('DELETE', '/boards/nowhere/pushes/old-style');
    await call('DELETE', '/boards/nowhere/pushes/new-style');
  });

  it('keeps notes on where things grow for the whole board, and takes them away when emptied', async () => {
    const noted = await call('PUT', '/boards/nowhere/grows/r88', { text: '  Calm Forest,   Misty Tundra ' });
    expect(noted.status).toBe(200);
    expect(noted.data.grows).toEqual({ r88: 'Calm Forest, Misty Tundra' });
    expect(noted.data.pushes).toHaveLength(1); // the pushes are untouched
    await call('PUT', '/boards/nowhere/grows/e12', { text: 'Breezy Grasslands' });
    expect((await call('GET', '/boards/nowhere')).data.grows).toEqual({ r88: 'Calm Forest, Misty Tundra', e12: 'Breezy Grasslands' });

    expect((await call('PUT', '/boards/nowhere/grows/i.88', { text: 'x' })).status).toBe(400);
    expect((await call('PUT', '/boards/nowhere/grows/r88', { text: 'y'.repeat(500) })).data.grows.r88).toHaveLength(200);

    await call('PUT', '/boards/nowhere/grows/e12', { text: '' });
    const cleared = await call('PUT', '/boards/nowhere/grows/r88', { text: '   ' });
    expect(cleared.data.grows).toBeUndefined();
  });

  it('refuses changes without the password once one is set, and never hands the password back', async () => {
    expect((await call('POST', '/boards/nowhere/lock', { key: 'test-only-value' })).data.locked).toBe(true);
    expect((await call('PUT', '/boards/nowhere/pushes/claim-t5-push', { ...push, name: 'Renamed' })).status).toBe(403);
    expect((await call('DELETE', '/boards/nowhere/pushes/claim-t5-push')).status).toBe(403);
    expect((await call('PUT', '/boards/nowhere/grows/r88', { text: 'Swamp' })).status).toBe(403);
    expect((await call('PUT', '/boards/nowhere/grows/r88', { text: 'Swamp' }, 'test-only-value')).data.grows).toEqual({ r88: 'Swamp' });
    expect((await call('POST', '/boards/nowhere/unlock', undefined, 'wrong')).status).toBe(403);
    expect((await call('POST', '/boards/nowhere/unlock', undefined, 'test-only-value')).status).toBe(200);
    expect((await call('PUT', '/boards/nowhere/pushes/claim-t5-push', { ...push, name: 'Renamed' }, 'test-only-value')).data.push.name).toBe('Renamed');

    const seen = await call('GET', '/boards/nowhere');
    expect(seen.data.locked).toBe(true);
    expect(JSON.stringify(seen.data)).not.toMatch(/keyHash|test-only-value/);
  });

  it('stamps the day a push is marked complete, keeps it, and clears it when the push is reopened', async () => {
    const key = 'test-only-value';
    const save = async (body: object) => (await call('PUT', '/boards/nowhere/pushes/claim-t5-push', { ...push, ...body }, key)).data.push;
    expect((await save({})).completedAt).toBeUndefined();

    // The page cannot pick the date: whatever it sends is ignored.
    const done = await save({ status: 'done', completedAt: '2001-01-01T00:00:00.000Z' });
    expect(done.status).toBe('done');
    expect(Math.abs(Date.now() - new Date(done.completedAt).getTime())).toBeLessThan(60_000);

    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 86_400_000 });
    try {
      const edited = await save({ status: 'done', note: 'Thanks, everyone.' });
      expect(edited.completedAt).toBe(done.completedAt);
      expect(edited.updatedAt).not.toBe(done.updatedAt);
    } finally {
      vi.useRealTimers();
    }

    const reopened = await save({ status: 'active' });
    expect(reopened.status).toBe('active');
    expect('completedAt' in reopened).toBe(false);
  });

  it('answers wrong addresses as errors, not as the page', async () => {
    expect((await call('GET', '/boards/somewhere-else')).status).toBe(404);
    expect(await call('GET', '/no-such-thing')).toEqual({ status: 404, data: { error: 'Not found.' } });
  });

  it('flags a board that will not survive a restart', async () => {
    const fleeting = createApp(() => ({ ...host, store: memoryStore(), durable: false, storage: 'temporary' }));
    const board = (await (await fleeting.request(API + '/boards/nowhere')).json()) as any;
    expect(board.temporary).toBe(true);
    expect(((await (await fleeting.request(API + '/health')).json()) as any).keepsPushes).toBe(false);
  });
});
