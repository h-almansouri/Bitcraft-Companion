import { afterEach, describe, expect, it, vi } from 'vitest';
import { claimFrom, factsFrom, houseOf, movesFrom, planQueries, regionOf, stockFrom, tierOf, type GameFacts, type LiveSource, type LiveStock } from '../server/live.ts';
import { readActivity, readClaim, readStock } from '../server/read.ts';
import type { Row, Tables } from '../server/relay.ts';
import { memoryMemo } from '../server/storage.ts';
import { CLAIM } from '../src/lib/claim.ts';

// A small made-up claim in region 8, in the shapes the relay sends (ids as text, choices as [position, value]).
const C = CLAIM.id;
const OTHER_CLAIM = '576460752771054285';
const CHELS = '1008806316829587226';
const VEL = '1008806316829596847';
const STRANGER = '504403158600000001';
const CHEST = '576460753013682765';
const BANK = '576460753011974974';
const FAR_BANK = '576460752781447404';
const LOOM = '576460753013224119';
const CART = '576460752796069543';
const HOUSE_CHEST = '576460753500000001';

const pocket = (item?: [number, number, 0 | 1]) => [6000, item ? [0, [item[0], item[1], [item[2], []], [1, []]]] : [1, []], false];
const inventory = (entity: string, owner: string, playerOwner: string, index: number, pockets: unknown[]): Row => ({ entity_id: entity, pockets, inventory_index: index, cargo_index: pockets.length, owner_entity_id: owner, player_owner_entity_id: playerOwner });
const building = (entity: string, claim: string, kind: number): Row => ({ entity_id: entity, claim_entity_id: claim, direction_index: 0, building_description_id: kind, constructed_by_player_entity_id: CHELS });

function tablesOf(tables: Record<string, Row[]>): Tables {
  return new Map(Object.entries(tables).map(([name, list]) => [name, new Map(list.map((row) => [String(row.entity_id ?? row.id), row]))]));
}

const base = (): Record<string, Row[]> => ({
  claim_state: [
    { entity_id: C, owner_player_entity_id: VEL, owner_building_entity_id: '1', name: 'Nowhere', neutral: false },
    { entity_id: OTHER_CLAIM, owner_player_entity_id: STRANGER, owner_building_entity_id: '2', name: 'Astra Nova', neutral: false },
  ],
  claim_local_state: [{ entity_id: C, supplies: 26949, treasury: 74234, building_description_id: 405 }],
  claim_tech_state: [{ entity_id: C, learned: [1, 200, 254714033, 300, 400, 500, 225112729, 10000, 600], researching: 0 }],
  claim_member_state: [
    { entity_id: '576460753011210469', claim_entity_id: C, player_entity_id: CHELS, user_name: 'chels' },
    { entity_id: '576460753011210468', claim_entity_id: C, player_entity_id: VEL, user_name: 'Vel' },
  ],
  world_region_name_state: [{ id: 0, player_facing_name: 'Ossura', module_name_prefix: 'bitcraft_region_' }],
  building_state: [building(CHEST, C, 3001), building(BANK, C, 985246037), building(LOOM, C, 4014), building(FAR_BANK, OTHER_CLAIM, 985246037)],
  building_nickname_state: [{ entity_id: CHEST, nickname: ' Mason ' }],
  inventory_state: [
    // The claim's chest: an item, a cargo, and the same item again in another pocket.
    inventory('9001', CHEST, '0', 0, [pocket([1130005, 161, 0]), pocket([1003, 4, 1]), pocket(), pocket([1130005, 9, 0])]),
    // chels's own stash in the claim's bank is hers, not the claim's.
    inventory('9002', BANK, CHELS, 0, [pocket([5, 20, 0])]),
    inventory('9003', FAR_BANK, CHELS, 0, [pocket([6, 3, 0])]),
    inventory('9004', '0', CHELS, 0, [pocket([7, 1, 0])]),
    // What chels carries, plus a recovery chest.
    inventory('9010', CHELS, '0', 0, [pocket([8, 2, 0])]),
    inventory('9011', CHELS, '0', 1, [pocket([9, 1, 0])]),
    inventory('9012', CHELS, '0', 2, [pocket()]),
    inventory('9013', CHELS, CHELS, -1, [pocket([10, 15, 0])]),
    // Her cart, out in the world.
    inventory('9020', CART, '0', 0, [pocket([11, 100, 0])]),
    // Vel is in another region: no bag here, only a stash.
    inventory('9030', BANK, VEL, 0, [pocket([12, 7, 0])]),
  ],
  deployable_state_v2: [
    { entity_id: CART, owner_id: CHELS, claim_entity_id: C, nickname: "chels's Cart (II)" },
    { entity_id: '576460752767018303', owner_id: CHELS, claim_entity_id: '0', nickname: "chels's Cart (I)" },
  ],
  progressive_action_state: [
    { entity_id: '7001', building_entity_id: LOOM, function_type: 14, progress: 300, recipe_id: 401003, craft_count: 5, owner_entity_id: CHELS },
    { entity_id: '7002', building_entity_id: LOOM, function_type: 14, progress: 50, recipe_id: 109007, craft_count: 1, owner_entity_id: CHELS },
    { entity_id: '7003', building_entity_id: LOOM, function_type: 14, progress: 1, recipe_id: 999999, craft_count: 1, owner_entity_id: CHELS },
    { entity_id: '7004', building_entity_id: LOOM, function_type: 14, progress: 1, recipe_id: 109007, craft_count: 1, owner_entity_id: STRANGER },
  ],
  public_progressive_action_state: [{ entity_id: '7001', building_entity_id: LOOM, owner_entity_id: CHELS }],
  passive_craft_state: [
    { entity_id: '8001', owner_entity_id: CHELS, recipe_id: 1185486224, building_entity_id: LOOM, status: [2, []] },
    { entity_id: '8002', owner_entity_id: CHELS, recipe_id: 1185486224, building_entity_id: LOOM, status: [2, []] },
    { entity_id: '8003', owner_entity_id: CHELS, recipe_id: 1185486224, building_entity_id: LOOM, status: [1, []] },
    { entity_id: '8004', owner_entity_id: CHELS, recipe_id: 1185486224, building_entity_id: LOOM, status: [0, []] },
  ],
});

const facts: GameFacts = factsFrom({
  recipes: [
    // Splitting a log: six logs every time, and now and then a rare extra.
    { id: 'r401003', o: [['i.4010001', 6], ['i.1814625731', 0.06]], a: 90 },
    { id: 'r109007', o: [['i.1090008', 1]], a: 50 },
    { id: 'r1185486224', o: [['i.1442354536', 1]], a: 1 },
    // A plant that always gives seeds and filament.
    { id: 'r500', o: [['i.21', 3], ['i.22', 3]], a: 10 },
    // A pure dice roll: nothing is certain, so it is known by its first output.
    { id: 'r600', o: [['i.31', 0.5], ['i.32', 0.5]], a: 10 },
    // A building recipe shares the numbers and must not be mistaken for a craft.
    { id: 'b401003', o: [['b.50', 1]], a: 10000 },
  ],
  things: [
    ['b.3001', 'Sturdy Large Chest', 3],
    ['b.985246037', 'Settlement Stash', 0],
    ['b.4014', 'Fine Loom', 4],
    ['i.5', 'Not a building', 1],
  ],
});

describe('what the game data says about a craft', () => {
  it('a craft makes what every run gives', () => {
    expect(facts.recipe(401003)).toEqual({ makes: [['i.4010001', 6]], actions: 90 });
    expect(facts.recipe(500)!.makes).toEqual([['i.21', 3], ['i.22', 3]]);
    expect(facts.recipe(600)!.makes).toEqual([['i.31', 0.5]]);
    expect(facts.recipe(12345)).toBeUndefined();
    expect(facts.building(4014)).toBe('Fine Loom');
    expect(facts.building(5)).toBeUndefined();
  });
});

describe('the claim, from the relay', () => {
  it('reads the region out of an id', () => {
    expect(regionOf(C)).toBe(8);
    expect(regionOf(CHELS)).toBe(14);
  });

  it('works the tier out from the upgrades the claim holds', () => {
    // "Tier 6" is handed out on reaching tier 5, as the next thing to work toward.
    expect(tierOf([1, 200, 300, 400, 500, 600, 225112729, 10000])).toBe(5);
    expect(tierOf([1, 200])).toBe(1);
    expect(tierOf(undefined)).toBe(1);
  });

  it('gives the same facts the fetched claim page did', () => {
    expect(claimFrom(tablesOf(base()), C)).toEqual({
      id: C,
      name: 'Nowhere',
      tier: 5,
      region: 'Ossura',
      owner: 'Vel',
      supplies: 26949,
      // In the order they joined.
      members: [
        { id: VEL, name: 'Vel', lastSeen: null },
        { id: CHELS, name: 'chels', lastSeen: null },
      ],
    });
  });

  it('says nothing when the relay does not know the claim', () => {
    expect(claimFrom(tablesOf({}), C)).toBeNull();
    expect(stockFrom(tablesOf({}), C, [CHELS], facts, 8)).toBeNull();
  });
});

describe('which questions the connection asks', () => {
  const watching = { chests: [] as string[], logsFromDay: 20000 };

  it('starts with the claim alone, then works outward from what comes back', () => {
    const first = planQueries(tablesOf({}), C, 8, watching);
    expect(first).toHaveLength(8);
    expect(first).toContain(`SELECT * FROM claim_member_state WHERE claim_entity_id = ${C}`);

    const tables = base();
    const second = planQueries(tablesOf({ ...tables, building_state: tables.building_state.filter((b) => b.entity_id !== FAR_BANK), claim_state: tables.claim_state.slice(0, 1) }), C, 8, watching);
    // Seven lookups per member.
    for (const member of [CHELS, VEL]) {
      for (const [table, column] of [['inventory_state', 'owner_entity_id'], ['inventory_state', 'player_owner_entity_id'], ['deployable_state_v2', 'owner_id'], ['player_housing_state', 'entity_id'], ['progressive_action_state', 'owner_entity_id'], ['public_progressive_action_state', 'owner_entity_id'], ['passive_craft_state', 'owner_entity_id']]) {
        expect(second).toContain(`SELECT * FROM ${table} WHERE ${column} = ${member}`);
      }
    }
    // What is in each cart, and the bank a stash is in when it is not the claim's own.
    expect(second).toContain(`SELECT * FROM inventory_state WHERE owner_entity_id = ${CART}`);
    expect(second).toContain(`SELECT * FROM building_state WHERE entity_id = ${FAR_BANK}`);
    expect(second).not.toContain(`SELECT * FROM building_state WHERE entity_id = ${BANK}`);

    // Once that bank is known, the name of the claim it stands in.
    const third = planQueries(tablesOf({ ...tables, claim_state: tables.claim_state.slice(0, 1) }), C, 8, watching);
    expect(third).toContain(`SELECT * FROM claim_state WHERE entity_id = ${OTHER_CLAIM}`);

    // With everything known there is nothing new to ask.
    const settled = planQueries(tablesOf(tables), C, 8, watching);
    expect(settled.filter((sql) => !third.includes(sql))).toEqual([]);
  });

  it('only ever asks indexed lookups, never a search through a whole table', () => {
    const tables = base();
    tables.player_housing_state = [{ entity_id: CHELS, network_entity_id: '576460753240898707', is_empty: false, region_index: 8 }];
    tables.dimension_description_state = [{ entity_id: '576460753240898708', dimension_network_entity_id: '576460753240898707', dimension_position_large_x: 0, dimension_position_large_z: 0, dimension_size_large_x: 1, dimension_size_large_z: 1, dimension_id: 1778 }];
    tables.location_state = [{ entity_id: HOUSE_CHEST, chunk_index: 1777000001, x: 1, z: 1, dimension: 1778 }];
    const all = planQueries(tablesOf(tables), C, 8, { chests: [CHEST], logsFromDay: 20000 });
    const lookup = /^SELECT \* FROM [a-z_0-9]+ WHERE [a-z_]+ = \d+$/;
    const allowed = [
      'SELECT * FROM world_region_name_state',
      `SELECT * FROM storage_log_state WHERE object_entity_id = ${CHEST} AND days_since_epoch >= 20000`,
    ];
    const joins = all.filter((sql) => / JOIN /.test(sql));
    expect(joins).toHaveLength(2);
    for (const sql of all) {
      expect(sql).not.toMatch(/ OR | IN \(|LIKE/);
      if (!joins.includes(sql) && !allowed.includes(sql)) expect(sql).toMatch(lookup);
    }
    expect(new Set(all).size).toBe(all.length);
  });

  it("follows a member's house inward: its inside, what stands there, what those chests hold", () => {
    const tables = base();
    tables.player_housing_state = [
      { entity_id: CHELS, network_entity_id: '576460753240898707', is_empty: false, region_index: 8 },
      // An empty house and one in another region are left alone.
      { entity_id: VEL, network_entity_id: '576460752767858728', is_empty: true, region_index: 8 },
    ];
    let plan = planQueries(tablesOf(tables), C, 8, watching);
    expect(plan).toContain('SELECT * FROM dimension_description_state WHERE dimension_network_entity_id = 576460753240898707');
    expect(plan.some((sql) => sql.includes('576460752767858728'))).toBe(false);

    tables.dimension_description_state = [{ entity_id: '576460753240898708', dimension_network_entity_id: '576460753240898707', dimension_position_large_x: 0, dimension_position_large_z: 0, dimension_size_large_x: 1, dimension_size_large_z: 1, dimension_id: 1778 }];
    plan = planQueries(tablesOf(tables), C, 8, watching);
    // The game's own numbering of the cells of an inside: (dimension − 1) × 1,000,000 + z × 1000 + x + 1.
    expect(plan).toContain('SELECT * FROM location_state WHERE chunk_index = 1777000001');

    tables.location_state = [{ entity_id: HOUSE_CHEST, chunk_index: 1777000001, x: 1, z: 1, dimension: 1778 }];
    plan = planQueries(tablesOf(tables), C, 8, watching);
    expect(plan).toContain(`SELECT * FROM inventory_state WHERE owner_entity_id = ${HOUSE_CHEST}`);
    expect(plan).toContain(`SELECT * FROM building_state WHERE entity_id = ${HOUSE_CHEST}`);
    expect(plan).toContain(`SELECT * FROM building_nickname_state WHERE entity_id = ${HOUSE_CHEST}`);
    expect(houseOf(tablesOf(tables), CHELS, 8)).toMatchObject({ things: [HOUSE_CHEST] });
    expect(houseOf(tablesOf(tables), VEL, 8)).toBe('none');
    expect(houseOf(tablesOf(tables), CHELS, 9)).toBe('elsewhere');
  });
});

describe('storage and crafts, from the relay', () => {
  const stock = stockFrom(tablesOf(base()), C, [CHELS, VEL, STRANGER], facts, 8)!;
  const place = (key: string) => stock.locations.find((l) => l.id === key);

  it("adds up the claim's chests under their nicknames", () => {
    expect(place('b' + CHEST)).toEqual({ id: 'b' + CHEST, kind: 'claim', owner: 'Nowhere', name: 'Mason', detail: 'Sturdy Large Chest', items: [['i.1130005', 170], ['c.1003', 4]] });
    // The bank holds members' own stashes, so it is not one of the claim's chests.
    expect(place('b' + BANK)).toBeUndefined();
  });

  it('counts the buildings standing in the claim, and no one else’s', () => {
    expect(place('built')!.items).toEqual([['b.3001', 1], ['b.985246037', 1], ['b.4014', 1]]);
  });

  it("names each member's storage the way the site always has", () => {
    const hers = stock.locations.filter((l) => l.ownerId === CHELS).map((l) => [l.id, l.name, l.items]);
    expect(hers).toEqual([
      [`p${CHELS}:9010`, 'Inventory', [['i.8', 2]]],
      [`p${CHELS}:9011`, 'Toolbelt', [['i.9', 1]]],
      // (An empty wallet is not listed.)
      [`p${CHELS}:9013`, 'Recovery Chest (R8)', [['i.10', 15]]],
      // A cart goes by its own id, so leaving it out of a push keeps working. A packed-away cart holds nothing.
      [`p${CHELS}:${CART}`, "chels's Cart (II)", [['i.11', 100]]],
      [`p${CHELS}:9002`, 'Settlement Stash @ Nowhere', [['i.5', 20]]],
      [`p${CHELS}:9003`, 'Settlement Stash @ Astra Nova', [['i.6', 3]]],
      [`p${CHELS}:9004`, 'Storage', [['i.7', 1]]],
    ]);
    expect(stock.locations.every((l) => l.kind === 'claim' || l.owner === 'chels' || l.owner === 'Vel')).toBe(true);
  });

  it('says who is in another region, and never looks up anyone outside the claim', () => {
    // Vel's stash is here but his bag is not: he is elsewhere.
    expect(stock.away).toEqual([{ id: VEL, name: 'Vel' }]);
    expect(stock.locations.some((l) => l.ownerId === STRANGER)).toBe(false);
    expect(stock.crafts.some((c) => c.ownerId === STRANGER)).toBe(false);
  });

  it('reads crafts by hand: what they make, how far along, and whether anyone may help', () => {
    const byHand = stock.crafts.filter((c) => !c.passive);
    expect(byHand).toEqual([
      // Five runs of six logs each: 30 logs, counted as logs rather than as the "output" bundle.
      { id: '7001', item: 'i.4010001', qty: 30, owner: 'chels', ownerId: CHELS, station: 'Fine Loom', claim: 'Nowhere', passive: false, progress: 300, total: 450, done: false, shared: true },
      { id: '7002', item: 'i.1090008', qty: 1, owner: 'chels', ownerId: CHELS, station: 'Fine Loom', claim: 'Nowhere', passive: false, progress: 50, total: 50, done: true, shared: false },
    ]);
  });

  it('adds up crafts that run on their own, per station and finished or not', () => {
    const passive = stock.crafts.filter((c) => c.passive).map((c) => [c.id, c.qty, c.done]);
    expect(passive).toEqual([
      [`passive:${CHELS}:${LOOM}|i.1442354536|true`, 2, true],
      [`passive:${CHELS}:${LOOM}|i.1442354536|false`, 2, false],
    ]);
  });

  it('lists a house’s chests under the member who owns the house', () => {
    const tables = base();
    tables.player_housing_state = [{ entity_id: CHELS, network_entity_id: '576460753240898707', is_empty: false, region_index: 8 }];
    tables.dimension_description_state = [{ entity_id: '576460753240898708', dimension_network_entity_id: '576460753240898707', dimension_id: 1778 }];
    tables.location_state = [{ entity_id: HOUSE_CHEST, chunk_index: 1777000001 }];
    tables.building_state.push(building(HOUSE_CHEST, '0', 3001));
    tables.building_nickname_state.push({ entity_id: HOUSE_CHEST, nickname: 'Planks' });
    tables.inventory_state.push(inventory('9040', HOUSE_CHEST, '0', 0, [pocket([13, 40, 0])]));
    const withHouse = stockFrom(tablesOf(tables), C, [CHELS], facts, 8)!;
    expect(withHouse.locations.find((l) => l.id === `h${CHELS}:${HOUSE_CHEST}`)).toMatchObject({ owner: 'chels', name: 'House: Planks', items: [['i.13', 40]] });
  });
});

describe("a chest's log, from the relay", () => {
  it('lists deposits and withdrawals, newest first', () => {
    const log = (n: number, chest: string, kind: number, micros: string): Row => ({ id: String(n), object_entity_id: chest, subject_entity_id: CHELS, subject_name: 'chels', subject_type: [0, []], data: [kind, [3050001, 10 * n, [kind === 2 ? 0 : 1, []], [1, []]]], timestamp: [micros], days_since_epoch: 20778 });
    const tables = tablesOf({ storage_log_state: [log(1, CHEST, 2, '1795222565576075'), log(2, CHEST, 1, '1795222570000000'), log(3, CHEST, 0, '1795222580000000'), log(4, BANK, 2, '1795222590000000')] });
    expect(movesFrom(tables, CHEST)).toEqual([
      { at: '2026-11-21T00:56:10.000Z', who: 'chels', whoId: CHELS, kind: 'out', item: 'c.3050001', qty: 20 },
      { at: '2026-11-21T00:56:05.576Z', who: 'chels', whoId: CHELS, kind: 'in', item: 'i.3050001', qty: 10 },
    ]);
  });
});

// ---- choosing between the relay and fetching --------------------------------------

describe('where a page gets its numbers', () => {
  const asked: string[] = [];
  const bitjita = (answers: Record<string, unknown>) =>
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const path = String(input).replace('https://bitjita.com/api', '');
      asked.push(path);
      return path in answers ? new Response(JSON.stringify(answers[path])) : new Response('', { status: 404 });
    });
  const fetched = {
    [`/claims/${C}`]: { claim: { entityId: C, name: 'Nowhere', tier: 5, regionName: 'Ossura' } },
    [`/claims/${C}/members`]: { members: [{ playerEntityId: CHELS, userName: 'chels' }, { playerEntityId: VEL, userName: 'Vel' }] },
    [`/claims/${C}/inventories`]: { buildings: [{ entityId: CHEST, buildingName: 'Sturdy Large Chest', inventory: [{ contents: { item_id: 99, item_type: 0, quantity: 1 } }] }] },
    [`/players/${VEL}/inventories`]: { inventories: [{ entityId: '9050', inventoryName: 'Inventory', pockets: [{ contents: { item_id: 14, item_type: 0, quantity: 60 } }] }] },
    [`/players/${VEL}/crafts?completed=all`]: { craftResults: [{ entityId: '7100', craftedItem: [{ item_id: 15, item_type: 0, quantity: 2 }], craftCount: 3, buildingName: 'Kiln', claimName: 'Far Town', progress: 1, totalActionsRequired: 9 }] },
    [`/logs/storage?buildingEntityId=${CHEST}&limit=500`]: { logs: [] },
  };
  const liveStock = (): LiveStock => stockFrom(tablesOf(base()), C, [CHELS, VEL], facts, 8)!;
  const source = (over: Partial<LiveSource>): LiveSource => ({ claim: async () => undefined, stock: async () => undefined, activity: async () => undefined, status: () => ({}), close: () => {}, ...over });

  afterEach(() => {
    asked.length = 0;
    vi.unstubAllGlobals();
  });

  it('answers from the relay without fetching anything', async () => {
    bitjita(fetched);
    const everyone = { ...liveStock(), away: [] };
    const host = { memo: memoryMemo(), live: source({ claim: async () => everyone.claim, stock: async () => everyone, activity: async () => ({ chest: CHEST, at: 'now', moves: [], more: false }) }) };
    expect((await readClaim(host)).name).toBe('Nowhere');
    const snapshot = await readStock(host, [CHELS, VEL], false);
    expect(snapshot).toMatchObject({ live: true, claim: { id: C, name: 'Nowhere', tier: 5 }, problems: [] });
    expect(snapshot.locations).toEqual(everyone.locations);
    expect(await readActivity(host, CHEST)).toMatchObject({ chest: CHEST });
    expect(asked).toEqual([]);
  });

  it('fetches the older way while the relay cannot answer, or when there is no relay at all', async () => {
    bitjita(fetched);
    for (const host of [{ memo: memoryMemo(), live: source({}) }, { memo: memoryMemo() }]) {
      asked.length = 0;
      const snapshot = await readStock(host, [CHELS], false);
      expect(snapshot.live).toBeUndefined();
      expect(snapshot.locations.find((l) => l.id === 'b' + CHEST)!.items).toEqual([['i.99', 1]]);
      expect((await readClaim(host)).region).toBe('Ossura');
      expect(await readActivity(host, CHEST)).toMatchObject({ chest: CHEST, moves: [] });
      expect(asked).toContain(`/claims/${C}/inventories`);
    }
  });

  it('reads just the member who is in another region the older way, counting nothing twice', async () => {
    bitjita(fetched);
    const host = { memo: memoryMemo(), live: source({ stock: async () => liveStock() }) };
    const snapshot = await readStock(host, [CHELS, VEL], false);
    expect(snapshot.live).toBe(true);
    // The claim's chests and chels still come from the relay…
    expect(snapshot.locations.find((l) => l.id === 'b' + CHEST)!.items).toEqual([['i.1130005', 170], ['c.1003', 4]]);
    expect(snapshot.locations.filter((l) => l.ownerId === CHELS)).toHaveLength(7);
    // …and everything of Vel's comes from the one fetched read (his stash the relay saw is not added on top).
    expect(snapshot.locations.filter((l) => l.ownerId === VEL).map((l) => [l.name, l.items])).toEqual([['Inventory', [['i.14', 60]]]]);
    expect(snapshot.crafts.filter((c) => c.ownerId === VEL).map((c) => [c.item, c.qty, c.claim])).toEqual([['i.15', 6, 'Far Town']]);
    expect(asked.filter((path) => path.includes(CHELS))).toEqual([]);
  });

  it('says so when that member cannot be read either, and keeps what the relay did see', async () => {
    vi.stubGlobal('fetch', async () => new Response('busy', { status: 503 }));
    const host = { memo: memoryMemo(), live: source({ stock: async () => liveStock() }) };
    const snapshot = await readStock(host, [CHELS, VEL], false);
    expect(snapshot.problems).toHaveLength(1);
    expect(snapshot.problems[0]).toMatch(/^Vel is outside Ossura right now, and what they carry could not be read/);
    expect(snapshot.locations.filter((l) => l.ownerId === VEL).map((l) => l.name)).toEqual(['Settlement Stash @ Nowhere']);
  });

  it('keeps a chest that is not shared closed, without asking twice', async () => {
    bitjita(fetched);
    const host = { memo: memoryMemo(), live: source({ activity: async () => null }) };
    expect(await readActivity(host, '123')).toBeNull();
    expect(asked).toEqual([]);
  });
});
