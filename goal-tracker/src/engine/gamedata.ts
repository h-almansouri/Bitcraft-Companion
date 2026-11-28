import type { GameData, Recipe, RecipeKind, Ref, Stack, Thing, ThingKind } from './types';

/** The compact shape written by scripts/build-gamedata.mjs to public/gamedata.json. */
export interface RawGameData {
  version: string;
  source: string;
  rarity: string[];
  skills: Record<string, string>;
  stations: Record<string, string>;
  /** [ref, name, tier, tag, rarityIndex, stationType?] */
  things: [Ref, string, number, string, number, number?][];
  recipes: RawRecipe[];
  gather: RawGather[];
  /** ref -> traveler who sells it */
  sold: Record<Ref, string>;
  /** ref -> what one trade with that traveler costs: [how many it hands over, what it takes]. Older files have none. */
  price?: Record<Ref, [number, [Ref, number][]]>;
  travelers: Traveler[];
  townships: Township[];
}

/** What one trade with a traveler costs. */
export interface TradePrice {
  /** How many of the thing one trade hands over. */
  per: number;
  /** What the trade takes, usually only Hex Coins (i.1). */
  cost: Stack[];
}

interface RawRecipe {
  id: string;
  k: 'craft' | 'build' | 'unpack' | 'pack';
  n: string;
  i: [Ref, number][];
  o: [Ref, number][];
  a?: number;
  s?: number;
  l?: number;
  b?: number;
  bt?: number;
  p?: 1;
  on?: string;
}

interface RawGather {
  id: string;
  src: string;
  /** The source node's category in the game data, e.g. "Tree", "Ore Vein", "Dungeon Resource". */
  g?: string;
  t: number;
  o: [Ref, number][];
  v?: string;
  s?: number;
  l?: number;
  i?: [Ref, number][];
  /** Resource id (for nodes) or creature id (for animals), and the tool tier a node needs. */
  r?: number;
  e?: number;
  tl?: number;
}

export interface TravelerTask {
  id: number;
  /** Minimum level in the traveler's skill before this task can be offered. */
  min: number;
  d: string;
  need: [Ref, number][];
  coins: number;
  xp: number;
}

export interface Traveler {
  name: string;
  skill: number;
  tasks: TravelerTask[];
}

export interface Township {
  tier: number;
  supplies: number;
  inputs: [Ref, number][];
}

export interface Game extends GameData {
  rarity: string[];
  skills: Record<string, string>;
  stations: Record<string, string>;
  sold: Record<Ref, string>;
  price: Record<Ref, TradePrice>;
  travelers: Traveler[];
  townships: Township[];
  /** Station type id for building things, used to find "a T5 loom" style matches. */
  stationType: Record<Ref, number>;
}

/**
 * Node categories a player can deliberately go out and farm. Everything else
 * (dungeon chests, ruin loot, event nodes, quest objects) still shows up as a
 * place a thing can drop, but is never assumed as the way to get it.
 */
const EVERYDAY_SOURCES = new Set([
  'Animal', 'Tree', 'Sapling', 'Stump', 'Wood Logs', 'Wood', 'Stick', 'Rock', 'Rock Boulder', 'Rock Outcrop', 'Stone',
  'Ore Vein', 'Clay', 'Sand', 'Salt', 'Berry', 'Bountiful Berry Bush', 'Mushroom', 'Flower', 'Fiber Plant', 'Fruit',
  'Fruit Tree', 'Wild Grain', 'Wild Vegetable', 'Research', 'Lake Fish School', 'Lake Fish Spot', 'Ocean Fish School',
  'Chummed Ocean Fish School', 'Baitfish', 'Mollusks', 'Trophy Fishing Node', 'Paranensis', 'Bones', 'Insects',
  'Hexite', 'Hexite Infused Tree', 'Hexite Meteor', 'Energy Font',
]);

const KIND: Record<string, ThingKind> = { i: 'item', c: 'cargo', b: 'building' };
const stacks = (rows: [Ref, number][] | undefined): Stack[] => (rows ?? []).map(([id, qty]) => ({ id, qty }));

export function inflate(raw: RawGameData): Game {
  const things: Record<Ref, Thing> = {};
  const stationType: Record<Ref, number> = {};
  for (const [id, name, tier, tag, rarity, station] of raw.things) {
    things[id] = { id, name, tier, tag: tag || undefined, rarity, kind: KIND[id[0]] ?? 'item' };
    if (station) stationType[id] = station;
  }
  const nameOf = (id: Ref | undefined) => (id ? (things[id]?.name ?? id) : '');

  const recipes: Recipe[] = [];
  for (const r of raw.recipes) {
    const inputs = stacks(r.i);
    const outputs = stacks(r.o);
    const kind: RecipeKind = r.k === 'pack' ? 'craft' : r.k;
    recipes.push({
      id: r.id,
      kind,
      name: r.n.replace('{0}', r.on ?? nameOf(outputs[0]?.id)).replace('{1}', nameOf(inputs[0]?.id)),
      inputs,
      outputs,
      skill: r.s != null ? raw.skills[r.s] : kind === 'build' ? 'Construction' : undefined,
      level: r.l,
      station: r.b != null ? raw.stations[r.b] : undefined,
      stationTier: r.bt,
      effort: r.a,
      passive: r.p === 1 ? true : undefined,
    });
  }
  for (const g of raw.gather) {
    recipes.push({
      id: g.id,
      kind: 'gather',
      name: `${g.v ?? 'Gather'} ${g.src}`,
      inputs: [],
      outputs: stacks(g.o),
      skill: g.s != null ? raw.skills[g.s] : undefined,
      level: g.l,
      effort: 1,
      source: g.src,
      loot: !EVERYDAY_SOURCES.has(g.g ?? ''),
      node: g.r != null ? { kind: 'resource', id: g.r, tier: g.t, toolTier: g.tl } : g.e != null ? { kind: 'creature', id: g.e, tier: g.t } : undefined,
    });
  }

  return {
    version: raw.version,
    things,
    recipes,
    rarity: raw.rarity,
    skills: raw.skills,
    stations: raw.stations,
    sold: raw.sold,
    price: Object.fromEntries(Object.entries(raw.price ?? {}).map(([id, [per, cost]]) => [id, { per, cost: stacks(cost) }])),
    travelers: raw.travelers,
    townships: raw.townships,
    stationType,
  };
}
