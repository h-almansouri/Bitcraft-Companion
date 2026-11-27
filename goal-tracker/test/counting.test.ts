import { describe, expect, it } from 'vitest';
import { buildStock, countedPlayers, isLeftOut } from '../src/lib/derive.ts';
import type { StockLocation, StockSnapshot } from '../src/lib/shapes.ts';

/**
 * Pushes keep following the claim without anyone opening Storage or Setup: people who
 * join later count, and a chest left out by nickname stays out after it is rebuilt.
 */
const members = [{ id: '1' }, { id: '2' }, { id: '3' }];

describe('whose storage a push counts', () => {
  it('counts everyone in the claim except those left out, including people who joined later', () => {
    expect(countedPlayers({ players: ['1', '2'], leftOut: ['2'] }, members)).toEqual(['1', '3']);
    expect(countedPlayers({ players: [], leftOut: [] }, [...members, { id: '4' }])).toEqual(['1', '2', '3', '4']);
  });

  it('keeps an older push, or any push while the member list is missing, on the people saved with it', () => {
    expect(countedPlayers({ players: ['1'] }, members)).toEqual(['1']);
    expect(countedPlayers({ players: ['1', '2'], leftOut: [] }, null)).toEqual(['1', '2']);
  });
});

describe('which storage a push leaves out', () => {
  const chest = (over: Partial<StockLocation>): StockLocation => ({ id: 'b1', kind: 'claim', owner: 'Nowhere', name: 'Tool mats', detail: 'Exquisite Large Chest', items: [['i.1', 10]], ...over });

  it('leaves a named chest out by its nickname, so its rebuilt or upgraded replacement stays out', () => {
    const push = { excluded: ['b1'], excludedNames: ['Tool mats'] };
    expect(isLeftOut(chest({}), push)).toBe(true);
    expect(isLeftOut(chest({ id: 'b2', name: 'tool mats ', detail: 'Peerless Large Chest' }), push)).toBe(true);
    expect(isLeftOut(chest({ id: 'b3', name: 'Wood' }), push)).toBe(false);
  });

  it('never matches an unnamed chest or personal storage by name', () => {
    const push = { excluded: [], excludedNames: ['Exquisite Large Chest', 'Tool mats'] };
    expect(isLeftOut(chest({ name: 'Exquisite Large Chest', detail: '' }), push)).toBe(false);
    expect(isLeftOut(chest({ kind: 'player', detail: 'Bank' }), push)).toBe(false);
  });

  it('counts a brand-new chest straight away', () => {
    const snapshot: StockSnapshot = {
      at: '',
      claim: { id: 'c1', name: 'Nowhere', tier: 5 },
      locations: [chest({}), chest({ id: 'b9', name: 'New chest', items: [['i.1', 5]] })],
      crafts: [],
      problems: [],
    };
    const stock = buildStock(snapshot, { excluded: ['b1'], excludedNames: ['Tool mats'], players: [], countCrafts: false });
    expect(stock.totals.get('i.1')).toBe(5);
  });
});
