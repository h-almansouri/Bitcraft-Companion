import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type Host } from '../server/app.ts';
import { chestActivity, isoOf, movesOf } from '../server/bitjita.ts';
import { memoryMemo, memoryStore } from '../server/storage.ts';
import { mergeMoves } from '../src/lib/activity.ts';
import { API, CLAIM } from '../src/lib/claim.ts';
import type { ChestMove } from '../src/lib/shapes.ts';

const BITJITA = 'https://bitjita.com/api';
const log = (id: number, who: string, whoId: string, type: string, item: number, qty: number, stamp: string, itemType = 'item') => ({
  id: String(id),
  subjectEntityId: whoId,
  subjectName: who,
  subjectType: 'player',
  data: { type, item_id: item, quantity: qty, item_type: itemType },
  timestamp: stamp,
});

describe('reading a chest log', () => {
  it("turns Bitjita's times into ISO times", () => {
    expect(isoOf('2026-11-27 10:49:06.003104+00')).toBe('2026-11-27T10:49:06.003Z');
    expect(isoOf('2026-11-27 10:49:06+00')).toBe('2026-11-27T10:49:06.000Z');
    expect(isoOf('2026-11-27T10:49:06Z')).toBe('2026-11-27T10:49:06.000Z');
  });

  it('keeps deposits and withdrawals, newest first, items and cargo told apart', () => {
    const moves = movesOf({
      logs: [
        log(1, 'Vel', '9', 'deposit_item', 100, 40, '2026-11-27 10:00:00+00'),
        log(3, 'chels', '7', 'withdraw_item', 200, 5, '2026-11-27 12:00:00+00', 'cargo'),
        log(2, 'Vel', '9', 'something_else', 100, 1, '2026-11-27 11:00:00+00'),
      ],
    });
    expect(moves).toEqual([
      { at: '2026-11-27T12:00:00.000Z', who: 'chels', whoId: '7', kind: 'out', item: 'c.200', qty: 5 },
      { at: '2026-11-27T10:00:00.000Z', who: 'Vel', whoId: '9', kind: 'in', item: 'i.100', qty: 40 },
    ]);
  });
});

describe('the activity list', () => {
  const move = (at: string, whoId: string, item: string, kind: 'in' | 'out', qty = 1): ChestMove => ({ at, who: 'p' + whoId, whoId, kind, item, qty });

  it('folds back-to-back moves of the same thing by the same person into one line', () => {
    const groups = mergeMoves([
      move('2026-11-27T10:04:00Z', '1', 'i.1', 'in'),
      move('2026-11-27T10:02:00Z', '1', 'i.1', 'in'),
      move('2026-11-27T10:00:00Z', '1', 'i.1', 'in'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ qty: 3, trips: 3, at: '2026-11-27T10:04:00Z', from: '2026-11-27T10:00:00Z' });
  });

  it('keeps people, items, directions and long gaps apart', () => {
    const groups = mergeMoves([
      move('2026-11-27T10:05:00Z', '1', 'i.1', 'in'),
      move('2026-11-27T10:04:00Z', '2', 'i.1', 'in'),
      move('2026-11-27T10:03:00Z', '2', 'i.2', 'in'),
      move('2026-11-27T10:02:00Z', '2', 'i.2', 'out'),
      move('2026-11-27T09:00:00Z', '2', 'i.2', 'out'),
    ]);
    expect(groups.map((g) => g.trips)).toEqual([1, 1, 1, 1, 1]);
  });
});

describe('whose chests can be read', () => {
  // Everything is answered from memory, so these tests never reach Bitjita.
  const memo = memoryMemo();
  const CHEST = '111';
  const HOUSE_CHEST = '222';
  const members = [
    { playerEntityId: '7', userName: 'chels' },
    { playerEntityId: '8', userName: 'Frostyy' },
  ];
  beforeEach(() => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('tests must not call Bitjita')));
    memo.set(`${BITJITA}/claims/${CLAIM.id}`, JSON.stringify({ claim: { entityId: CLAIM.id, name: CLAIM.name, tier: 5 } }), 600);
    memo.set(`${BITJITA}/claims/${CLAIM.id}/members`, JSON.stringify({ members }), 600);
    memo.set(`${BITJITA}/claims/${CLAIM.id}/inventories`, JSON.stringify({ buildings: [{ entityId: CHEST, buildingName: 'Chest', inventory: [] }] }), 600);
    for (const pid of ['7', '8']) {
      memo.set(`${BITJITA}/players/${pid}/housing`, JSON.stringify([{ buildingEntityId: '500', isEmpty: false }]), 600);
      memo.set(`${BITJITA}/players/${pid}/housing/500`, JSON.stringify({ inventories: [{ entityId: HOUSE_CHEST, inventory: [] }] }), 600);
    }
    const logs = JSON.stringify({ logs: [log(1, 'Frostyy', '8', 'withdraw_item', 100, 3, '2026-11-27 10:00:00+00')] });
    memo.set(`${BITJITA}/logs/storage?buildingEntityId=${CHEST}&limit=500`, logs, 600);
    memo.set(`${BITJITA}/logs/storage?buildingEntityId=${HOUSE_CHEST}&limit=500`, logs, 600);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reads a claim chest's log", async () => {
    const activity = await chestActivity(memo, CLAIM.id, CHEST);
    expect(activity?.moves).toEqual([{ at: '2026-11-27T10:00:00.000Z', who: 'Frostyy', whoId: '8', kind: 'out', item: 'i.100', qty: 3 }]);
    expect(activity?.more).toBe(false);
  });

  it("won't read a chest that isn't the claim's", async () => {
    expect(await chestActivity(memo, CLAIM.id, '999')).toBeNull();
  });

  it("reads a chest inside a shared house, but not inside anyone else's house", async () => {
    expect(await chestActivity(memo, CLAIM.id, HOUSE_CHEST, '7')).not.toBeNull();
    expect(await chestActivity(memo, CLAIM.id, HOUSE_CHEST, '8')).toBeNull();
    expect(await chestActivity(memo, CLAIM.id, '999', '7')).toBeNull();
  });

  it('the API refuses anything that is not a chest id', async () => {
    const host: Host = { store: memoryStore(), memo, durable: true, storage: 'test' };
    const app = createApp(() => host);
    expect((await app.request(`${API}/activity?chest=abc`)).status).toBe(400);
    expect((await app.request(`${API}/activity?chest=999`)).status).toBe(404);
    const ok = await app.request(`${API}/activity?chest=${CHEST}`);
    expect(ok.status).toBe(200);
    expect((await ok.json()).moves).toHaveLength(1);
  });
});
