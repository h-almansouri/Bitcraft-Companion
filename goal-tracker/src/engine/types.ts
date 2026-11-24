/**
 * Shared vocabulary for the planner.
 *
 * A Ref is a game thing with a one-letter prefix so items, cargo and buildings
 * can never collide: "i.5130001" (item), "c.1632765422" (cargo), "b.5020" (building).
 */
export type Ref = string;

export type ThingKind = 'item' | 'cargo' | 'building';

export interface Thing {
  id: Ref;
  name: string;
  /** 1-10, or 0 when the thing has no tier (water, salt, sandpaper...). */
  tier: number;
  kind: ThingKind;
  /** The game's own grouping, e.g. "Plank", "Rope", "Plant Fiber". */
  tag?: string;
  rarity?: number;
}

export interface Stack {
  id: Ref;
  /** Expected quantity per run (already multiplied by any drop chance). */
  qty: number;
}

/**
 * craft   - made at a station from other things
 * build   - a building placed in the world from materials
 * gather  - taken from a resource node or creature in the world
 * unpack  - opening a package/crate into the loose items inside
 */
export type RecipeKind = 'craft' | 'build' | 'gather' | 'unpack';

export interface Recipe {
  id: string;
  kind: RecipeKind;
  name?: string;
  inputs: Stack[];
  outputs: Stack[];
  /** Profession that performs it, e.g. "Tailoring". */
  skill?: string;
  /** Minimum profession level. */
  level?: number;
  /** Station it is made at, e.g. "Loom", and that station's minimum tier. */
  station?: string;
  stationTier?: number;
  /** Effort (swings/actions) one run takes; the game calls this "actions required". */
  effort?: number;
  /** For gather recipes: the node or creature it comes from. */
  source?: string;
  /**
   * For gather recipes: true when the source is a one-off find (dungeon chest, ruin
   * loot, event node) rather than something you can go and farm on purpose.
   */
  loot?: boolean;
  /** For gather recipes: the thing in the world you gather from. */
  node?: GatherNode;
}

/** A resource node or creature, as the game identifies it. */
export interface GatherNode {
  kind: 'resource' | 'creature';
  /** The game's own id for it, which community maps also use. */
  id: number;
  tier: number;
  /** Minimum tool tier needed to work it, when it needs a tool. */
  toolTier?: number;
}

export interface GameData {
  version: string;
  things: Record<Ref, Thing>;
  recipes: Recipe[];
}

export interface Goal {
  id: Ref;
  qty: number;
}

/** How a material is obtained once nothing more can be crafted from stock. */
export type SourceKind = 'craft' | 'build' | 'gather' | 'buy' | 'unpack';

/** One place a material's required quantity goes. */
export interface Use {
  /** The thing being made with it, or null when it is itself one of the push's goals. */
  into: Ref | null;
  recipeId?: string;
  /** How much of this material that destination takes. */
  qty: number;
  /** Runs of the destination recipe this covers. */
  runs?: number;
}

/** A recipe the plan will actually run, and how many times. */
export interface Step {
  recipe: Recipe;
  runs: number;
  /** True when this run only exists to use up stock that was already on hand. */
  fromStock?: boolean;
}

export interface PlanNode {
  id: Ref;
  /** Quantity asked for directly as a goal of the push. */
  goal: number;
  /** Everything required: the goal plus what every other step consumes. */
  needed: number;
  have: number;
  /** needed - have, never below zero. */
  toGo: number;
  /** have - needed, never below zero. */
  surplus: number;
  source: SourceKind;
  /** Recipes that will be run to produce the shortfall (empty for gather/buy). */
  steps: Step[];
  /** Total this plan's steps will produce (can exceed toGo because of batch sizes). */
  produced: number;
  /** Where the needed quantity goes, largest first. */
  uses: Use[];
  /** Other ways this could be made, for the "change route" control. */
  alternatives: Recipe[];
  /** Distance from the goals: 0 = a goal, higher = deeper in the chain. */
  depth: number;
}

export interface Plan {
  nodes: Map<Ref, PlanNode>;
  /** Parents-first order: every node appears after everything that consumes it. */
  order: Ref[];
  /** Things the plan could not resolve (unknown ids, unbreakable cycles). */
  warnings: string[];
}

export interface PlanOptions {
  /** Force a specific recipe for a thing. Use null to treat it as gathered/bought. */
  routes?: Record<Ref, string | null>;
  /** Recipes never to pick automatically. */
  excluded?: Iterable<string>;
  /** Spend on-hand stock of alternative ingredients before planning new gathering. Default true. */
  useStockAlternates?: boolean;
}
