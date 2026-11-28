/**
 * The claim, read live from a relay (Bitjita's, or BitCraftSync's as its stand-in).
 *
 * server/relay.ts keeps the one connection and the rows; this file says which questions
 * that connection asks for Nowhere, and turns the rows into the shapes the pages already
 * use (the claim, a stock snapshot, a chest's activity), so nothing on the site has to
 * know where the numbers came from.
 *
 * What is asked, all in the claim's own region:
 *
 *  - the claim itself: its name, supplies, tier, members, every building standing in it,
 *    and what is inside its chests;
 *  - for each member: their bags, their bank stashes, their carts and mounts, their house,
 *    and the crafts they have going at stations (wherever in the region the station is);
 *  - what those rows point at: the contents of each cart, the building a stash or a craft
 *    sits in and the claim that building is in, the chests inside a member's house;
 *  - a chest's deposit and withdrawal log, only once someone opens that chest.
 *
 * One connection sees one region. A member who has travelled to another region takes
 * their bags with them, so they are reported as `away` and the caller reads just that
 * member the older way (server/read.ts).
 */
import { isHouseOwner } from '../src/lib/claim.ts';
import type { ChestActivity, ChestMove, ClaimDetail, CraftJob, StockLocation } from '../src/lib/shapes.ts';
import { Feed, RelayDown, type Dial, type RelayHost, type Row, type Tables } from './relay.ts';

/** What the game data says about a recipe and a building type. Read from public/gamedata.json. */
export interface GameFacts {
  /** What one run of a recipe makes, and how many actions it takes. */
  recipe(id: number): { makes: [string, number][]; actions: number } | undefined;
  /** A building type's name: "Fine Loom". */
  building(id: number): string | undefined;
}

/** Picks the two facts this file needs out of the site's game data. */
export function factsFrom(gamedata: any): GameFacts {
  const recipes = new Map<number, { makes: [string, number][]; actions: number }>();
  for (const r of gamedata?.recipes ?? []) {
    const m = /^r(\d+)$/.exec(String(r.id));
    const outputs: [string, number][] = (r.o ?? []).map((o: [string, number]) => [String(o[0]), Number(o[1]) || 0]);
    if (!m || !outputs.length) continue;
    // A recipe's outputs are averages when it rolls dice (6 logs and, one time in sixteen, a rare
    // extra). What a craft is "making" is what every run gives: at least one each, else its first output.
    const sure = outputs.filter(([, qty]) => qty >= 1);
    recipes.set(Number(m[1]), { makes: sure.length ? sure : [outputs[0]], actions: Number(r.a) || 0 });
  }
  const buildings = new Map<number, string>();
  for (const thing of gamedata?.things ?? []) {
    const m = /^b\.(\d+)$/.exec(String(thing?.[0]));
    if (m) buildings.set(Number(m[1]), String(thing[1]));
  }
  return { recipe: (id) => recipes.get(id), building: (id) => buildings.get(id) };
}

// ---- reading rows ---------------------------------------------------------------

const rows = (t: Tables, table: string): Row[] => [...(t.get(table)?.values() ?? [])];
/** Ids arrive as text when long and as numbers when short; compare them as text. */
const id = (value: unknown) => String(value ?? '0');
const isId = (value: string) => /^\d{1,24}$/.test(value);
/** The game packs the region into the top byte of every id. */
export const regionOf = (entityId: string) => Number(BigInt(entityId) >> 56n);
const byNumber = (a: string, b: string) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
const round = (n: number) => Math.round(n * 100) / 100;

/** "Some value or nothing": [0, value] or [1, []] on the wire. */
const some = (option: any) => (Array.isArray(option) ? (option[0] === 0 ? option[1] : undefined) : option?.some);
/** Which choice of several a value is: its position in the game's own list. */
const choice = (sum: any) => (Array.isArray(sum) ? Number(sum[0]) : -1);
const ref = (itemId: unknown, type: unknown) => (choice(type) === 1 || type === 1 ? 'c.' : 'i.') + itemId;

/** Adds up what is in the pockets of some inventories, as [thing, quantity] pairs. */
function tally(inventories: Row[]): [string, number][] {
  const totals = new Map<string, number>();
  for (const inventory of inventories) {
    for (const pocket of inventory.pockets ?? []) {
      // A pocket is [volume, contents, locked]; contents is "a stack or nothing"; a stack is [item, quantity, kind, durability].
      const stack = some(Array.isArray(pocket) ? pocket[1] : pocket?.contents);
      if (!stack) continue;
      const [itemId, quantity, type] = Array.isArray(stack) ? stack : [stack.item_id, stack.quantity, stack.item_type];
      const qty = Number(quantity) || 0;
      if (qty <= 0) continue;
      const key = ref(itemId, type);
      totals.set(key, (totals.get(key) ?? 0) + qty);
    }
  }
  return [...totals];
}

const isoOfMicros = (stamp: any) => {
  const micros = Array.isArray(stamp) ? stamp[0] : (stamp?.__timestamp_micros_since_unix_epoch__ ?? stamp);
  try {
    return new Date(Number(BigInt(micros) / 1000n)).toISOString();
  } catch {
    return '';
  }
};

interface Member {
  id: string;
  name: string;
}

export function membersOf(t: Tables, claimId: string): Member[] {
  return rows(t, 'claim_member_state')
    .filter((r) => id(r.claim_entity_id) === claimId)
    .sort((a, b) => byNumber(id(a.entity_id), id(b.entity_id)))
    .map((r) => ({ id: id(r.player_entity_id), name: String(r.user_name ?? 'Member') }));
}

/**
 * A claim's tier. The game hands out the upgrade "Tier N" (numbered N × 100) the moment the
 * tier below is reached, as the thing to work toward next, so the tier is one less than the
 * highest of those the claim holds.
 */
export function tierOf(learned: unknown): number {
  let top = 0;
  for (const tech of Array.isArray(learned) ? learned : []) {
    const n = Number(tech);
    if (n >= 200 && n <= 2000 && n % 100 === 0) top = Math.max(top, n / 100);
  }
  return Math.max(1, top - 1);
}

export function claimFrom(t: Tables, claimId: string): ClaimDetail | null {
  const claim = t.get('claim_state')?.get(claimId);
  if (!claim) return null;
  const members = membersOf(t, claimId);
  return {
    id: claimId,
    name: String(claim.name ?? ''),
    tier: tierOf(t.get('claim_tech_state')?.get(claimId)?.learned),
    region: String(rows(t, 'world_region_name_state')[0]?.player_facing_name ?? ''),
    owner: members.find((m) => m.id === id(claim.owner_player_entity_id))?.name ?? '',
    supplies: Number(t.get('claim_local_state')?.get(claimId)?.supplies) || 0,
    members: members.map((m) => ({ ...m, lastSeen: null })),
  };
}

// ---- houses ---------------------------------------------------------------------

/**
 * The inside of a house is a small world of its own (a "dimension"), cut into cells, and
 * everything standing in it is listed by cell. From the game's own formula:
 * cell = (dimension − 1) × 1,000,000 + z × 1000 + x + 1, over the dimension's rectangle.
 */
function cellsOf(dimension: Row): string[] {
  const dim = Number(dimension.dimension_id);
  if (!dim) return [];
  const x0 = Number(dimension.dimension_position_large_x) || 0;
  const z0 = Number(dimension.dimension_position_large_z) || 0;
  const wide = Math.max(1, Math.min(4, Number(dimension.dimension_size_large_x) || 1));
  const deep = Math.max(1, Math.min(4, Number(dimension.dimension_size_large_z) || 1));
  const cells: string[] = [];
  for (let z = z0; z < z0 + deep; z++) for (let x = x0; x < x0 + wide; x++) cells.push(String((dim - 1) * 1_000_000 + z * 1000 + x + 1));
  return cells;
}

/** A member's house: 'none' when they have none or it is empty, 'elsewhere' when it is in another region. */
export function houseOf(t: Tables, playerId: string, region: number): 'none' | 'elsewhere' | { network: string; cells: string[]; things: string[] } {
  const housing = t.get('player_housing_state')?.get(playerId);
  if (!housing || housing.is_empty === true) return 'none';
  if (Number(housing.region_index) !== region) return 'elsewhere';
  const network = id(housing.network_entity_id);
  const cells = rows(t, 'dimension_description_state')
    .filter((d) => id(d.dimension_network_entity_id) === network)
    .flatMap(cellsOf)
    .slice(0, 8);
  const inside = new Set(cells);
  const things = rows(t, 'location_state')
    .filter((l) => inside.has(id(l.chunk_index)))
    .map((l) => id(l.entity_id))
    .slice(0, 80);
  return { network, cells, things };
}

// ---- which questions to ask -----------------------------------------------------

export interface Watching {
  /** Chests whose deposit and withdrawal log someone has opened. */
  chests: Iterable<string>;
  /** Logs are read from this day on (days since 1970), so an old busy chest cannot become a huge download. */
  logsFromDay: number;
}

/**
 * Every question the connection should have open, given the rows received so far. It is
 * asked again after each answer, so it works outward in a few rounds: the claim and its
 * members first, then what each member has, then what those things point at.
 *
 * Each is a plain lookup on a column the relay keeps an index for (or a two-table join on
 * indexed columns), never a search through a whole table.
 */
export function planQueries(t: Tables, claimId: string, region: number, watching: Watching): string[] {
  const C = claimId;
  const sql: string[] = [
    `SELECT * FROM claim_state WHERE entity_id = ${C}`,
    `SELECT * FROM claim_local_state WHERE entity_id = ${C}`,
    `SELECT * FROM claim_tech_state WHERE entity_id = ${C}`,
    `SELECT * FROM claim_member_state WHERE claim_entity_id = ${C}`,
    `SELECT * FROM building_state WHERE claim_entity_id = ${C}`,
    // What is in the claim's chests (a stash someone keeps in the claim's bank belongs to them, not the claim).
    `SELECT inventory_state.* FROM inventory_state JOIN building_state ON inventory_state.owner_entity_id = building_state.entity_id WHERE building_state.claim_entity_id = ${C} AND inventory_state.player_owner_entity_id = 0`,
    `SELECT building_nickname_state.* FROM building_nickname_state JOIN building_state ON building_nickname_state.entity_id = building_state.entity_id WHERE building_state.claim_entity_id = ${C}`,
    'SELECT * FROM world_region_name_state',
  ];
  const lookup = (table: string, column: string, value: string) => {
    if (isId(value) && value !== '0') sql.push(`SELECT * FROM ${table} WHERE ${column} = ${value}`);
  };

  const members = membersOf(t, C).map((m) => m.id);
  const isMember = new Set(members);
  for (const m of members) {
    lookup('inventory_state', 'owner_entity_id', m); // bag, toolbelt, wallet
    lookup('inventory_state', 'player_owner_entity_id', m); // bank stashes
    lookup('deployable_state_v2', 'owner_id', m); // carts, mounts, boats, caches
    lookup('player_housing_state', 'entity_id', m);
    lookup('progressive_action_state', 'owner_entity_id', m);
    lookup('public_progressive_action_state', 'owner_entity_id', m);
    lookup('passive_craft_state', 'owner_entity_id', m);
  }

  const buildings = t.get('building_state');
  const unknownBuilding = (b: string) => b !== '0' && !buildings?.has(b);
  // What is inside each cart, mount and cache.
  const vehicles = new Set<string>();
  for (const d of rows(t, 'deployable_state_v2')) {
    if (!isMember.has(id(d.owner_id))) continue;
    vehicles.add(id(d.entity_id));
    lookup('inventory_state', 'owner_entity_id', id(d.entity_id));
  }
  // The bank a stash is kept in, and the station a craft is at, when they are not the claim's own.
  for (const inv of rows(t, 'inventory_state')) {
    const owner = id(inv.owner_entity_id);
    if (isMember.has(id(inv.player_owner_entity_id)) && !isMember.has(owner) && !vehicles.has(owner) && unknownBuilding(owner)) lookup('building_state', 'entity_id', owner);
  }
  for (const table of ['progressive_action_state', 'passive_craft_state']) {
    for (const craft of rows(t, table)) {
      const station = id(craft.building_entity_id);
      if (isMember.has(id(craft.owner_entity_id)) && unknownBuilding(station)) lookup('building_state', 'entity_id', station);
    }
  }
  // The name of any other claim one of those buildings stands in.
  const claims = t.get('claim_state');
  for (const b of rows(t, 'building_state')) {
    const claim = id(b.claim_entity_id);
    if (claim !== C && claim !== '0' && !claims?.has(claim)) lookup('claim_state', 'entity_id', claim);
  }

  // A member's house: its inside, what stands there, and what those chests hold.
  for (const m of members) {
    const housing = t.get('player_housing_state')?.get(m);
    if (!housing || housing.is_empty === true || Number(housing.region_index) !== region) continue;
    lookup('dimension_description_state', 'dimension_network_entity_id', id(housing.network_entity_id));
    const house = houseOf(t, m, region);
    if (typeof house === 'string') continue;
    for (const cell of house.cells) lookup('location_state', 'chunk_index', cell);
    for (const thing of house.things) {
      lookup('inventory_state', 'owner_entity_id', thing);
      lookup('building_nickname_state', 'entity_id', thing);
      if (unknownBuilding(thing)) lookup('building_state', 'entity_id', thing);
    }
  }

  for (const chest of watching.chests) {
    if (isId(chest)) sql.push(`SELECT * FROM storage_log_state WHERE object_entity_id = ${chest} AND days_since_epoch >= ${watching.logsFromDay}`);
  }
  return [...new Set(sql)];
}

// ---- storage and crafts ---------------------------------------------------------

export interface LiveStock {
  claim: ClaimDetail;
  locations: StockLocation[];
  crafts: CraftJob[];
  /** Wanted members whose bags are not in this region right now. Nothing of theirs is certain from here. */
  away: Member[];
}

const BAG_NAMES = ['Inventory', 'Toolbelt', 'Wallet'];

/** Everything the claim and the wanted members are holding in this region, plus their crafts on the go. */
export function stockFrom(t: Tables, claimId: string, wanted: string[], facts: GameFacts, region: number): LiveStock | null {
  const claim = claimFrom(t, claimId);
  if (!claim) return null;

  const buildings = t.get('building_state');
  const nicknames = t.get('building_nickname_state');
  const claims = t.get('claim_state');
  const kindOf = (buildingId: string) => {
    const b = buildings?.get(buildingId);
    return b ? facts.building(Number(b.building_description_id)) : undefined;
  };
  const nicknameOf = (buildingId: string) => String(nicknames?.get(buildingId)?.nickname ?? '').trim();
  const claimNameOf = (buildingId: string) => String(claims?.get(id(buildings?.get(buildingId)?.claim_entity_id))?.name ?? '');

  const inventories = rows(t, 'inventory_state');
  const heldBy = new Map<string, Row[]>();
  for (const inv of inventories) {
    const owner = id(inv.owner_entity_id);
    const list = heldBy.get(owner);
    if (list) list.push(inv);
    else heldBy.set(owner, [inv]);
  }

  const locations: StockLocation[] = [];

  // The claim's chests: storage that stands in the claim and belongs to nobody in particular.
  const chests = [...heldBy.keys()].filter((b) => id(buildings?.get(b)?.claim_entity_id) === claimId).sort(byNumber);
  for (const chest of chests) {
    const shared = heldBy.get(chest)!.filter((inv) => id(inv.player_owner_entity_id) === '0');
    if (!shared.length) continue;
    const nickname = nicknameOf(chest);
    const kind = kindOf(chest) ?? 'Storage';
    locations.push({ id: 'b' + chest, kind: 'claim', owner: claim.name, name: nickname || kind, detail: nickname ? kind : '', items: tally(shared) });
  }
  // Buildings already standing count toward "build a T5 loom" style goals.
  const standing = new Map<string, number>();
  for (const b of buildings?.values() ?? []) {
    if (id(b.claim_entity_id) !== claimId) continue;
    const key = 'b.' + b.building_description_id;
    standing.set(key, (standing.get(key) ?? 0) + 1);
  }
  if (standing.size) locations.push({ id: 'built', kind: 'claim', owner: claim.name, name: 'Standing in the claim', detail: 'Buildings', items: [...standing] });

  const nameOf = new Map(claim.members.map((m) => [m.id, m.name]));
  const players = [...new Set(wanted)].filter((p) => nameOf.has(p)).sort();
  const away: Member[] = [];
  const crafts: CraftJob[] = [];
  const shared = t.get('public_progressive_action_state');

  for (const pid of players) {
    const owner = nameOf.get(pid)!;
    const place = (boxId: string, prefix: string, name: string, held: Row[]) => {
      const items = tally(held);
      if (items.length) locations.push({ id: prefix + pid + ':' + boxId, kind: 'player', owner, ownerId: pid, name, detail: '', items });
    };

    // What they carry: bag (0), toolbelt (1), wallet (2), and any recovery chest (-1). The bag travels
    // with the player, so no bag here means they are in another region.
    const carried = heldBy.get(pid) ?? [];
    if (!carried.some((inv) => Number(inv.inventory_index) === 0)) away.push({ id: pid, name: owner });
    for (const inv of carried) {
      const index = Number(inv.inventory_index);
      place(id(inv.entity_id), 'p', index === -1 ? `Recovery Chest (R${region})` : (BAG_NAMES[index] ?? 'Storage'), [inv]);
    }

    // Carts, mounts, boats and caches that are out in the world, by the name the game gives each.
    // One that is packed away holds nothing and has no row.
    const vehicles = new Set<string>();
    for (const d of rows(t, 'deployable_state_v2')) {
      if (id(d.owner_id) !== pid) continue;
      const vehicle = id(d.entity_id);
      vehicles.add(vehicle);
      const held = heldBy.get(vehicle);
      if (held) place(vehicle, 'p', String(d.nickname || 'Cart'), held);
    }

    // Stashes: storage of theirs inside a building, named by the town it is in.
    for (const inv of inventories) {
      const building = id(inv.owner_entity_id);
      if (id(inv.player_owner_entity_id) !== pid || building === pid || vehicles.has(building)) continue;
      const kind = kindOf(building);
      const town = claimNameOf(building);
      place(id(inv.entity_id), 'p', kind ? (town ? `${kind} @ ${town}` : kind) : 'Storage', [inv]);
    }

    // The chests in their house.
    const house = houseOf(t, pid, region);
    if (typeof house !== 'string') {
      for (const thing of house.things) {
        const held = heldBy.get(thing);
        if (held) place(thing, 'h', 'House: ' + (nicknameOf(thing) || kindOf(thing) || 'storage'), held);
      }
    }

    // Crafts they are working on by hand.
    for (const c of rows(t, 'progressive_action_state')) {
      if (id(c.owner_entity_id) !== pid) continue;
      const recipe = facts.recipe(Number(c.recipe_id));
      if (!recipe) continue;
      const count = Number(c.craft_count) || 1;
      const station = id(c.building_entity_id);
      const total = recipe.actions * count;
      const progress = Number(c.progress) || 0;
      recipe.makes.forEach(([item, qty], n) => {
        crafts.push({
          id: id(c.entity_id) + (n ? ':' + n : ''),
          item,
          qty: round(qty * count),
          owner,
          ownerId: pid,
          station: kindOf(station) ?? '',
          claim: claimNameOf(station),
          passive: false,
          progress,
          total,
          done: total > 0 && progress >= total,
          shared: !!shared?.has(id(c.entity_id)),
        });
      });
    }

    // Crafts that run on their own. A loom holds dozens of one-strip jobs; they are added up per station and state.
    const batches = new Map<string, CraftJob>();
    for (const c of rows(t, 'passive_craft_state')) {
      if (id(c.owner_entity_id) !== pid) continue;
      const recipe = facts.recipe(Number(c.recipe_id));
      if (!recipe) continue;
      const station = id(c.building_entity_id);
      // Queued, Processing, Complete.
      const done = choice(c.status) === 2;
      for (const [item, qty] of recipe.makes) {
        const key = `${station}|${item}|${done}`;
        const batch = batches.get(key);
        if (batch) batch.qty = round(batch.qty + qty);
        else
          batches.set(key, {
            id: `passive:${pid}:${key}`,
            item,
            qty,
            owner,
            ownerId: pid,
            station: kindOf(station) ?? '',
            claim: claimNameOf(station),
            passive: true,
            progress: 0,
            total: 0,
            done,
            shared: false,
          });
      }
    }
    crafts.push(...batches.values());
  }

  return { claim, locations, crafts, away };
}

// ---- a chest's log --------------------------------------------------------------

/** A chest's deposits and withdrawals from the rows on hand, newest first. */
export function movesFrom(t: Tables, chestId: string): ChestMove[] {
  const moves: ChestMove[] = [];
  for (const log of rows(t, 'storage_log_state')) {
    if (id(log.object_entity_id) !== chestId) continue;
    // What happened is one of: (reserved), WithdrawItem, DepositItem. The detail is [item, quantity, kind, durability].
    const kind = choice(log.data);
    if (kind !== 1 && kind !== 2) continue;
    const what = log.data[1];
    const [itemId, quantity, type] = Array.isArray(what) ? what : [what?.item_id, what?.quantity, what?.item_type];
    moves.push({ at: isoOfMicros(log.timestamp), who: String(log.subject_name ?? 'Someone'), whoId: id(log.subject_entity_id), kind: kind === 2 ? 'in' : 'out', item: ref(itemId, type), qty: Number(quantity) || 0 });
  }
  return moves.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

// ---- the live source the server reads from --------------------------------------

/** How far back a chest's log is read. */
const LOG_DAYS = 30;
/** The same cap the older way had on one chest's list. */
const ACTIVITY_LIMIT = 500;
/** A chest's log stays open this long after someone last looked at it. */
const WATCH_MS = 20 * 60_000;

export interface LiveSource {
  /** The claim, or undefined when the relay cannot answer just now. */
  claim(): Promise<ClaimDetail | undefined>;
  /** Storage and crafts for these members, or undefined when the relay cannot answer just now. */
  stock(players: string[]): Promise<LiveStock | undefined>;
  /**
   * A chest's latest deposits and withdrawals. null: not one of the shared chests.
   * undefined: the relay cannot answer just now.
   */
  activity(chest: string, owner?: string): Promise<ChestActivity | null | undefined>;
  /** For the status page: the connection, in numbers. */
  status(): Record<string, unknown>;
  close(): void;
}

export interface LiveOptions {
  claimId: string;
  /** The game data, loaded when first needed. */
  facts: () => Promise<GameFacts>;
  /** The relays to use, first choice first. Left out, both real ones (server/relay.ts). */
  relays?: RelayHost[];
  dial?: Dial;
  read?: (url: string) => Promise<string>;
  idleMs?: number;
  log?: (line: string) => void;
}

export function liveSource(options: LiveOptions): LiveSource {
  const { claimId } = options;
  const region = regionOf(claimId);
  const log = options.log ?? ((line: string) => console.log(line));
  const watched = new Map<string, number>();
  let logsFromDay = 0;

  const feed = new Feed({
    region,
    relays: options.relays,
    dial: options.dial,
    read: options.read,
    idleMs: options.idleMs,
    log,
    onConnect: () => {
      logsFromDay = Math.floor(Date.now() / 86_400_000) - LOG_DAYS;
      for (const [chest, at] of watched) if (Date.now() - at > WATCH_MS) watched.delete(chest);
    },
    plan: (tables) => planQueries(tables, claimId, region, { chests: watched.keys(), logsFromDay }),
  });

  /** A relay that is down is an everyday thing the caller handles; anything else is worth a line in the log. */
  const orNothing = async <T>(work: () => Promise<T | undefined>): Promise<T | undefined> => {
    try {
      return await work();
    } catch (err) {
      if (!(err instanceof RelayDown)) log(`Relay: could not be read (${(err as Error).message}).`);
      return undefined;
    }
  };

  return {
    claim: () => orNothing(async () => claimFrom(await feed.ready(), claimId) ?? undefined),

    stock: (players) =>
      orNothing(async () => {
        const [tables, facts] = await Promise.all([feed.ready(), options.facts()]);
        return stockFrom(tables, claimId, players, facts, region) ?? undefined;
      }),

    async activity(chest, owner) {
      try {
        const tables = await feed.ready();
        const claim = claimFrom(tables, claimId);
        if (!claim) return undefined;
        if (owner) {
          const who = claim.members.find((m) => m.id === owner);
          if (!who || !isHouseOwner(who.name)) return null;
          const house = houseOf(tables, owner, region);
          if (house === 'elsewhere') return undefined;
          if (house === 'none' || !house.things.includes(chest)) return null;
        } else {
          const ours = id(tables.get('building_state')?.get(chest)?.claim_entity_id) === claimId;
          const isStorage = rows(tables, 'inventory_state').some((inv) => id(inv.owner_entity_id) === chest && id(inv.player_owner_entity_id) === '0');
          if (!ours || !isStorage) return null;
        }
        watched.set(chest, Date.now());
        const moves = movesFrom(await feed.extend(), chest);
        return { chest, at: new Date().toISOString(), moves: moves.slice(0, ACTIVITY_LIMIT), more: moves.length > ACTIVITY_LIMIT };
      } catch (err) {
        if (!(err instanceof RelayDown)) log(`Relay: could not be read (${(err as Error).message}).`);
        return undefined;
      }
    },

    status: () => ({ ...feed.status(), chestLogsOpen: watched.size }),
    close: () => feed.close(),
  };
}
