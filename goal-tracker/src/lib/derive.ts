import { yieldOf } from '../engine/book.ts';
import { plan as runPlan } from '../engine/planner.ts';
import type { Plan, PlanNode, Recipe, Ref, Step, Thing } from '../engine/types.ts';
import type { GameCtx } from './game.ts';
import { BUY_ORDER } from './shapes.ts';
import type { CraftJob, Push, StockLocation, StockSnapshot } from './shapes.ts';

/** Display order for professions: gathering first, then crafting, then everything else. */
export const PROFESSIONS = [
  'Foraging', 'Forestry', 'Mining', 'Hunting', 'Fishing', 'Farming', 'Carpentry', 'Masonry', 'Smithing',
  'Leatherworking', 'Tailoring', 'Scholar', 'Cooking', 'Construction', 'Trade', 'Other',
];

/** Where a profession sorts in lists; ones the list above doesn't know go last. */
export const professionRank = (profession: string) => {
  const i = PROFESSIONS.indexOf(profession);
  return i < 0 ? PROFESSIONS.length : i;
};

export interface Holding {
  loc: StockLocation;
  qty: number;
}

/** What counts as "have" for a push, and where each bit of it is sitting. */
export interface StockView {
  totals: Map<Ref, number>;
  where: Map<Ref, Holding[]>;
  /** Crafts at stations that were counted into the totals. */
  atStations: Map<Ref, CraftJob[]>;
}

/**
 * Whose personal storage a push counts right now. A push with a left-out list counts
 * every current member of the claim except those, so someone who joins later is counted
 * without anyone touching the push. Older pushes, and any push while the member list
 * has not loaded, count the people saved on it.
 */
export function countedPlayers(push: Pick<Push, 'players' | 'leftOut'>, members: readonly { id: string }[] | null | undefined): string[] {
  if (!push.leftOut || !members?.length) return push.players;
  const out = new Set(push.leftOut);
  return members.map((m) => m.id).filter((id) => !out.has(id));
}

/** Whether a chest's nickname can identify it again after it is rebuilt: only claim chests someone has named. */
export const chestNickname = (loc: Pick<StockLocation, 'kind' | 'name' | 'detail'>) => (loc.kind === 'claim' && loc.detail ? loc.name.trim().toLowerCase() : null);

/** Whether a push leaves this storage out: switched off by id, or a claim chest carrying a nickname that was switched off. */
export function isLeftOut(loc: Pick<StockLocation, 'id' | 'kind' | 'name' | 'detail'>, push: Pick<Push, 'excluded' | 'excludedNames'>): boolean {
  if (push.excluded.includes(loc.id)) return true;
  const nickname = chestNickname(loc);
  return !!nickname && !!push.excludedNames?.some((n) => n.trim().toLowerCase() === nickname);
}

export function buildStock(snapshot: StockSnapshot | null, push: Pick<Push, 'excluded' | 'excludedNames' | 'players' | 'countCrafts'>): StockView {
  const totals = new Map<Ref, number>();
  const where = new Map<Ref, Holding[]>();
  const atStations = new Map<Ref, CraftJob[]>();
  if (!snapshot) return { totals, where, atStations };

  const players = new Set(push.players);
  for (const loc of snapshot.locations) {
    if (isLeftOut(loc, push)) continue;
    if (loc.kind === 'player' && loc.ownerId && !players.has(loc.ownerId)) continue;
    for (const [id, qty] of loc.items) {
      totals.set(id, (totals.get(id) ?? 0) + qty);
      const list = where.get(id);
      if (list) list.push({ loc, qty });
      else where.set(id, [{ loc, qty }]);
    }
  }
  for (const list of where.values()) list.sort((a, b) => b.qty - a.qty);

  if (push.countCrafts) {
    for (const job of snapshot.crafts) {
      if (!job.item || !players.has(job.ownerId)) continue;
      totals.set(job.item, (totals.get(job.item) ?? 0) + job.qty);
      const list = atStations.get(job.item);
      if (list) list.push(job);
      else atStations.set(job.item, [job]);
    }
  }
  return { totals, where, atStations };
}

export type RowStatus = 'done' | 'partial' | 'none';

export interface Row {
  node: PlanNode;
  id: Ref;
  name: string;
  tier: number;
  tag: string;
  profession: string;
  status: RowStatus;
  /** The recipe this is planned (or would be) made with; undefined for gathered/bought things. */
  recipe?: Recipe;
}

export type TodoKind = 'pickup' | 'progress' | 'stock' | 'craft' | 'gather' | 'buy' | 'blocked';

export interface Todo {
  key: string;
  kind: TodoKind;
  row: Row;
  /** Amount of the thing this action yields or collects. */
  qty: number;
  step?: Step;
  /** Runs that can be started right now with what is in storage. */
  doable?: number;
  /** For blocked crafts: the ingredients still short, worst first. */
  missing?: { id: Ref; short: number }[];
  /** Ingredients this craft is counting on that are still at a station (in a loom, or finished and not collected). */
  awaiting?: Awaiting[];
  job?: CraftJob;
}

/** An ingredient that exists but is not in hand yet: it is being made, or waiting at a station to be collected. */
export interface Awaiting {
  id: Ref;
  qty: number;
  jobs: CraftJob[];
}

/** Material that has already gone into a craft still sitting at a station. */
export interface Loaded {
  /** How much of the material that craft took, going by its recipe. */
  qty: number;
  /** What it is becoming. */
  into: Row;
  job: CraftJob;
}

export interface PushView {
  plan: Plan;
  stock: StockView;
  rows: Map<Ref, Row>;
  /** Rows in a stable, readable order: by profession, then family, then tier. */
  ordered: Row[];
  todos: Todo[];
  professions: string[];
  progress: { gather: StageProgress; process: StageProgress };
  /** Things handed to "Claim Buy Order": planned as bought, so nothing is asked for to make them. */
  onOrder: Set<Ref>;
  /** The same push planned from empty storage: the whole of every chain, whatever has been done so far. */
  scratch: Plan;
  /** Per material, what has already been loaded into crafts that are still at a station. */
  loaded: Map<Ref, Loaded[]>;
}

/** How far along one stage of a push is. */
export interface StageProgress {
  /** 0..1 */
  pct: number;
  /** Materials in this stage that need nothing more, out of all of them. */
  done: number;
  total: number;
}

function professionOf(node: PlanNode, recipe: Recipe | undefined, ctx: GameCtx): string {
  if (recipe?.skill) return recipe.skill;
  if (recipe?.kind === 'build') return 'Construction';
  if (ctx.game.sold[node.id] && !ctx.router.gatherSources(node.id).some((r) => !r.loot)) return 'Trade';
  const sources = ctx.router.gatherSources(node.id);
  return sources.find((r) => r.skill)?.skill ?? (ctx.game.sold[node.id] ? 'Trade' : 'Other');
}

/** A material nobody crafts in this plan: it is gathered or bought. */
const isRaw = (node: PlanNode) => !node.steps.some((s) => !s.fromStock);
/** What still has to be brought in for a raw material, after anything storage can be turned into it. */
const stillToGet = (node: PlanNode) => Math.max(0, node.toGo - node.steps.reduce((sum, s) => sum + s.runs * yieldOf(s.recipe, node.id), 0));

/**
 * Two separate answers to "how far along are we":
 *
 *  - gather: of every raw material the push needs from scratch, how much is in hand.
 *    Raw material that has already been turned into something counts as gathered.
 *    Each material weighs the same, so 5,000 pebbles do not drown out 60 roots.
 *  - process: of all the crafting the push takes from scratch, how much is behind us,
 *    weighed by the game's own effort number for each craft.
 */
function stageProgress(fromScratch: Plan, current: Plan): PushView['progress'] {
  let share = 0;
  let gathered = 0;
  let raw = 0;
  let crafted = 0;
  for (const node of fromScratch.nodes.values()) {
    if (!isRaw(node)) {
      crafted++;
      continue;
    }
    if (node.needed <= 0) continue;
    raw++;
    const now = current.nodes.get(node.id);
    const left = now && isRaw(now) ? Math.min(node.needed, stillToGet(now)) : 0;
    share += 1 - left / node.needed;
    if (left <= 0) gathered++;
  }

  const effort = (plan: Plan) => {
    let total = 0;
    const counted = new Set<string>();
    for (const node of plan.nodes.values()) {
      for (const step of node.steps) {
        // A recipe shared by two outputs (pelt and hair from one hide) is one job.
        if (step.recipe.kind === 'gather' || counted.has(step.recipe.id)) continue;
        counted.add(step.recipe.id);
        total += step.runs * (step.recipe.effort ?? 1);
      }
    }
    return total;
  };
  const all = effort(fromScratch);
  const ahead = effort(current);
  let unfinished = 0;
  for (const node of current.nodes.values()) if (!isRaw(node) && node.toGo > 0) unfinished++;

  return {
    gather: { pct: raw ? share / raw : 1, done: gathered, total: raw },
    process: { pct: all > 0 ? Math.max(0, Math.min(1, 1 - ahead / all)) : 1, done: Math.max(0, crafted - unfinished), total: crafted },
  };
}

export function buildView(ctx: GameCtx, push: Push, snapshot: StockSnapshot | null): PushView {
  const stock = buildStock(snapshot, push);
  // Whatever the claim is buying outright is not crafted or gathered, whatever route was picked for it.
  const onOrder = new Set<Ref>();
  for (const [id, people] of Object.entries(push.assignments ?? {})) if (people.includes(BUY_ORDER)) onOrder.add(id);
  const routes: Record<Ref, string | null> = { ...push.routes };
  for (const id of onOrder) routes[id] = null;
  const result = runPlan(ctx.book, ctx.router, push.goals, stock.totals, { routes });

  const rows = new Map<Ref, Row>();
  for (const id of result.order) {
    const node = result.nodes.get(id)!;
    const thing: Thing | undefined = ctx.book.thing(id);
    const main = node.steps.find((s) => !s.fromStock)?.recipe;
    const recipe = main ?? (node.source === 'craft' || node.source === 'build' ? routeFor(ctx, routes, id) : undefined);
    rows.set(id, {
      node,
      id,
      name: thing?.name ?? id,
      tier: thing?.tier ?? 0,
      tag: thing?.kind === 'building' ? 'Buildings' : (thing?.tag ?? 'Other'),
      profession: onOrder.has(id) ? 'Trade' : professionOf(node, recipe, ctx),
      status: node.toGo <= 0 ? 'done' : node.have > 0 ? 'partial' : 'none',
      recipe,
    });
  }

  const rank = (p: string) => {
    const i = PROFESSIONS.indexOf(p);
    return i < 0 ? PROFESSIONS.length : i;
  };
  const ordered = [...rows.values()].sort(
    (a, b) => rank(a.profession) - rank(b.profession) || a.tag.localeCompare(b.tag) || a.tier - b.tier || a.name.localeCompare(b.name),
  );
  const professions = [...new Set(ordered.map((r) => r.profession))];

  // ---- what to do next ----
  const todos: Todo[] = [];
  const pending = new Set<string>();
  for (const [item, jobs] of stock.atStations) {
    const row = rows.get(item);
    if (!row) continue;
    for (const job of jobs) {
      // Finished jobs want collecting; unfinished ones are counted as made but still need someone to see them through.
      todos.push({ key: (job.done ? 'pickup:' : 'progress:') + job.id, kind: job.done ? 'pickup' : 'progress', row, qty: job.qty, job });
      pending.add(job.id);
    }
  }
  for (const row of ordered) {
    const { node } = row;
    if (node.toGo <= 0) continue;
    for (const step of node.steps) {
      const made = step.runs * yieldOf(step.recipe, row.id);
      if (step.fromStock) {
        todos.push({ key: `stock:${row.id}:${step.recipe.id}`, kind: 'stock', row, qty: made, step, doable: step.runs });
        continue;
      }
      // "Craft now" means now: an ingredient still in a loom, or finished and not collected, is counted
      // as made for the plan but cannot be crafted with until it is in hand.
      let doable = step.runs;
      const missing: { id: Ref; short: number }[] = [];
      const awaiting: Awaiting[] = [];
      for (const input of step.recipe.inputs) {
        const have = stock.totals.get(input.id) ?? 0;
        const jobs = stock.atStations.get(input.id) ?? [];
        const inHand = have - atStation(stock, input.id);
        const want = step.runs * input.qty;
        doable = Math.min(doable, Math.floor(inHand / input.qty));
        if (want > have) missing.push({ id: input.id, short: want - have });
        const held = Math.min(have, want) - Math.max(0, inHand);
        if (held > 0) awaiting.push({ id: input.id, qty: held, jobs });
      }
      doable = Math.max(0, doable);
      missing.sort((a, b) => b.short - a.short);
      todos.push({ key: `craft:${row.id}`, kind: doable > 0 ? 'craft' : 'blocked', row, qty: Math.min(made, node.toGo), step, doable, missing, awaiting });
    }
    if (!node.steps.some((s) => !s.fromStock)) {
      const left = node.toGo - node.steps.reduce((sum, s) => sum + s.runs * yieldOf(s.recipe, row.id), 0);
      if (left > 0) todos.push({ key: `raw:${row.id}`, kind: row.profession === 'Trade' ? 'buy' : 'gather', row, qty: left });
    }
  }

  // ---- how far along ----
  // Measured against doing the whole push from empty storage, in two stages.
  const empty = runPlan(ctx.book, ctx.router, push.goals, new Map(), { routes, useStockAlternates: false });
  const progress = stageProgress(empty, result);

  // ---- what is already inside crafts at stations ----
  // "50 thread are in the loom becoming cloth strip": worked back from each craft's recipe.
  const loaded = new Map<Ref, Loaded[]>();
  for (const [item, jobs] of stock.atStations) {
    const into = rows.get(item);
    if (!into) continue;
    for (const job of jobs) {
      if (job.done) continue;
      const recipe = recipeBehind(ctx, into, job);
      if (!recipe) continue;
      const runs = job.qty / yieldOf(recipe, item);
      for (const input of recipe.inputs) {
        const entry = { qty: Math.round(runs * input.qty), into, job };
        const list = loaded.get(input.id);
        if (list) list.push(entry);
        else loaded.set(input.id, [entry]);
      }
    }
  }

  return { plan: result, stock, rows, ordered, todos, professions, progress, onOrder, scratch: empty, loaded };
}

/** How much of a thing is at stations (being made, or made and not collected) rather than in storage. */
export function atStation(stock: StockView, id: Ref): number {
  return (stock.atStations.get(id) ?? []).reduce((sum, job) => sum + job.qty, 0);
}

/** The recipe a craft at a station is most likely running: one made at that station, else the push's own pick. */
function recipeBehind(ctx: GameCtx, into: Row, job: CraftJob): Recipe | undefined {
  const made = ctx.book.producers(into.id).filter((r) => r.kind === 'craft');
  // The job names the building ("Exquisite Loom"); the recipe names the kind of station ("Loom").
  const here = (r: Recipe) => !!r.station && job.station.toLowerCase().includes(r.station.toLowerCase());
  return made.find((r) => here(r) && !!r.passive === job.passive) ?? made.find(here) ?? into.recipe;
}

function routeFor(ctx: GameCtx, routes: Record<Ref, string | null>, id: Ref): Recipe | undefined {
  const forced = routes[id];
  if (forced === null) return undefined;
  return (forced && ctx.book.recipe(forced)) || ctx.router.choose(id) || undefined;
}

/** One branch of "where does this end up": the thing it becomes, and how much of ours goes there. */
export interface FlowBranch {
  /** null = it is used as-is for one of the push's goals. */
  into: Row | null;
  /** Units of the source thing going down this branch. */
  qty: number;
  /** How many of the destination that makes (0 when it is just one ingredient of a build). */
  makes: number;
  recipe?: Recipe;
  /** True when the destination is a finished goal or a building, i.e. the thing is consumed as-is. */
  final: boolean;
}

/** Where a thing's required quantity goes, biggest share first. */
export function flowOf(view: PushView, id: Ref): FlowBranch[] {
  const node = view.plan.nodes.get(id);
  if (!node) return [];
  return node.uses.map((use) => {
    const into = use.into ? (view.rows.get(use.into) ?? null) : null;
    const recipe = use.recipeId ? into?.node.steps.find((s) => s.recipe.id === use.recipeId)?.recipe : undefined;
    const makes = recipe && use.runs && into ? use.runs * yieldOf(recipe, into.id) : 0;
    const final = !into || into.node.goal > 0 || recipe?.kind === 'build';
    return { into, qty: use.qty, makes, recipe, final };
  });
}

// ---------------------------------------------------------------------------
// Supply chains: the push laid out as raw material -> finished good.
//
// The shape of every chain comes from the push planned from empty storage, so
// a chain is always shown whole. (Planned against what is in storage, "thread
// becomes cloth strip" disappears the moment enough strips exist, and the chain
// falls into pieces.) What has been done so far is then marked on each step.
// ---------------------------------------------------------------------------

export interface ChainExtra {
  id: Ref;
  name: string;
  tier: number;
  perRun: number;
  /** True when this side ingredient is itself still missing somewhere in the push. */
  short: boolean;
}

export interface ChainStage {
  id: Ref;
  name: string;
  tier: number;
  profession: string;
  /** The push's row for it as things stand, when the push still asks for any of it. */
  row?: Row;
  /** Everything the push takes of it, starting from empty storage. */
  total: number;
  /** How much of that is still to gather, buy or craft. */
  toGo: number;
  /** Of what counts as done, how much is at a station rather than in hand. */
  pending: number;
  /** Crafts of it that are at stations right now. */
  jobs: CraftJob[];
  /** The recipe that makes it in this push; undefined for gathered and bought things. */
  recipe?: Recipe;
  /** How the previous stage turns into this one: `from` of it give `to` of this. */
  ratio?: { from: number; to: number };
  /** Everything else this stage's recipe needs besides the previous stage. */
  extras: ChainExtra[];
  /** Amount passed on to the next stage of this chain. */
  onward: number;
  /**
   * Amount to set aside and NOT process, because something uses it exactly as it
   * is (a station that takes raw roots, or the push goal itself). `for` names what
   * it is being kept for.
   */
  save: { qty: number; for: string[] };
  /** Amounts that are turned into something outside this chain. */
  branches: { id: Ref; name: string; qty: number }[];
}

export interface Chain {
  key: string;
  stages: ChainStage[];
  /** Who starts the chain off: the profession of its rawest stage. */
  profession: string;
  /** True while any stage still has a gap. */
  open: boolean;
  /** What the last stage is used for: the things it goes into, or id null for "it is a goal of the push". */
  ends: { id: Ref | null; name: string; qty: number }[];
}

const GOAL = 'the push goal';

/**
 * Splits the push into chains. Two materials sit next to each other in a chain
 * when each is the other's main partner: A is the costliest ingredient of B, and
 * B is where most of A goes. Everything else shows up as a side ingredient.
 */
export function buildChains(ctx: GameCtx, view: PushView): Chain[] {
  const whole = view.scratch;
  const recipeOf = (node: PlanNode) => node.steps.find((s) => !s.fromStock)?.recipe;
  const up = new Map<Ref, Ref>();
  const down = new Map<Ref, Ref>();

  for (const node of whole.nodes.values()) {
    const recipe = recipeOf(node);
    if (!recipe) continue;
    let main: Ref | undefined;
    let weight = -1;
    for (const input of recipe.inputs) {
      if (!whole.nodes.has(input.id)) continue;
      const w = ctx.router.costOf(input.id) * input.qty;
      if (w > weight) (weight = w), (main = input.id);
    }
    if (!main || up.has(main)) continue;
    const biggestUse = whole.nodes.get(main)!.uses.find((u) => u.into);
    if (biggestUse?.into === node.id) {
      up.set(main, node.id);
      down.set(node.id, main);
    }
  }

  const describe = (node: PlanNode) => {
    const thing = ctx.book.thing(node.id);
    const recipe = recipeOf(node);
    return {
      node,
      recipe,
      name: thing?.name ?? node.id,
      tier: thing?.tier ?? 0,
      tag: thing?.kind === 'building' ? 'Buildings' : (thing?.tag ?? 'Other'),
      profession: view.onOrder.has(node.id) ? 'Trade' : professionOf(node, recipe, ctx),
    };
  };
  const all = [...whole.nodes.values()].filter((node) => node.needed > 0).map(describe);
  const byId = new Map(all.map((d) => [d.node.id, d]));
  // Professions together, and within each from the lowest tier up.
  all.sort((a, b) => professionRank(a.profession) - professionRank(b.profession) || a.tier - b.tier || a.tag.localeCompare(b.tag) || a.name.localeCompare(b.name));
  const nameOf = (id: Ref) => byId.get(id)?.name ?? ctx.book.name(id);

  const chains: Chain[] = [];
  for (const start of all) {
    if (down.has(start.node.id)) continue;
    const line: typeof all = [];
    for (let cur: (typeof all)[number] | undefined = start; cur; cur = byId.get(up.get(cur.node.id) ?? '')) line.push(cur);

    const stages = line.map(({ node, recipe, name, tier, profession }, i): ChainStage => {
      const prev = line[i - 1];
      const next = line[i + 1];
      const row = view.rows.get(node.id);
      const fed = prev && recipe ? recipe.inputs.find((input) => input.id === prev.node.id) : undefined;

      // How the whole amount divides: on to the next stage, kept as it is, or off into another chain.
      const stage: ChainStage = { id: node.id, name, tier, profession, row, total: node.needed, toGo: 0, pending: 0, jobs: view.stock.atStations.get(node.id) ?? [], recipe, extras: [], onward: 0, save: { qty: 0, for: [] }, branches: [] };
      if (fed && recipe) stage.ratio = { from: fed.qty, to: yieldOf(recipe, node.id) };
      for (const use of next ? node.uses : []) {
        const target = use.into ? whole.nodes.get(use.into) : undefined;
        const built = target?.steps.find((s) => s.recipe.id === use.recipeId)?.recipe.kind === 'build';
        if (use.into === next!.node.id) stage.onward += use.qty;
        else if (!use.into || !target || target.goal > 0 || built) {
          stage.save.qty += use.qty;
          stage.save.for.push(use.into ? nameOf(use.into) : GOAL);
        } else stage.branches.push({ id: use.into, name: nameOf(use.into), qty: use.qty });
      }
      stage.extras = (recipe?.inputs ?? [])
        .filter((input) => input.id !== prev?.node.id)
        .map((input) => ({ id: input.id, name: ctx.book.name(input.id), tier: ctx.book.thing(input.id)?.tier ?? 0, perRun: input.qty, short: (view.rows.get(input.id)?.node.toGo ?? 0) > 0 }));

      return Object.assign(stage, standing(view, node.id, stage.total));
    });

    const last = line[line.length - 1];
    chains.push({
      key: start.node.id,
      stages,
      profession: start.profession,
      open: stages.some((s) => s.toGo > 0),
      ends: last.node.uses.map((u) => ({ id: u.into, name: u.into ? nameOf(u.into) : GOAL, qty: u.qty })),
    });
  }
  return chains;
}

// ---------------------------------------------------------------------------
// Products: the push seen from its finished materials.
//
// This is how a person writes the list out by hand:
//
//   880 ink (880 pigment + 1,760 fish oil)
//   605 pigment (3,025 flower)
//
// Two kinds of thing get a line of their own. An assembly puts finished things
// together (a building, cloth from strip and filament, ink from pigment and oil,
// a research from a brick and a journal): its steps are just its ingredients,
// each of which has its own line. Everything else is a chain: one material
// worked up step by step from what is gathered (roots, fiber, thread, strip,
// rope), and it is listed whole under the thing at the end of it.
// ---------------------------------------------------------------------------

/** Where one step of a product stands right now. */
export type StepState = 'done' | 'collect' | 'craft' | 'gather' | 'buy' | 'station' | 'waiting';

export interface MakeStep {
  id: Ref;
  name: string;
  tier: number;
  profession: string;
  /** Gathered or bought rather than crafted. */
  raw: boolean;
  /** How much of it this product takes. Other products may take more of the same thing. */
  share: number;
  recipe?: Recipe;
  /** What that share is made from. */
  from: { id: Ref; name: string; qty: number }[];
  /** Across the whole push: everything it takes of this, how much is still to get, and how much is only at a station. */
  total: number;
  toGo: number;
  pending: number;
  jobs: CraftJob[];
  /** The most useful thing to do about it right now, when there is one. */
  todo?: Todo;
  /** False once whatever this step feeds is covered: no more of it is wanted for this product. */
  wanted: boolean;
  state: StepState;
}

export interface Product {
  id: Ref;
  name: string;
  tier: number;
  profession: string;
  /** How many of them this line is about. */
  qty: number;
  /** What takes them: the things they are put into, or id null for "it is a goal of the push". */
  for: { id: Ref | null; name: string; qty: number }[];
  /** Put together from finished things: its steps are just its ingredients, each of which is a product of its own. */
  assembly: boolean;
  /** Gathered or bought and used as it is, so there is nothing to process. */
  raw: boolean;
  /** In making order; the last one is the product itself. */
  steps: MakeStep[];
  /** True while the product itself is not covered. */
  open: boolean;
}

/** Which job to show for a material when it has several: something that can be done now comes first. */
const TODO_ORDER: TodoKind[] = ['pickup', 'craft', 'stock', 'gather', 'buy', 'progress', 'blocked'];
const STATE_OF: Record<TodoKind, StepState> = { pickup: 'collect', craft: 'craft', stock: 'craft', gather: 'gather', buy: 'buy', progress: 'station', blocked: 'waiting' };

/** How far along one material is, against everything the push takes of it from empty storage. */
function standing(view: PushView, id: Ref, total: number): { toGo: number; pending: number } {
  const row = view.rows.get(id);
  // Anything the push no longer asks for has already been turned into later steps.
  if (!row) return { toGo: 0, pending: 0 };
  const left = isRaw(row.node) ? stillToGet(row.node) : row.node.toGo;
  const toGo = Math.min(total, left);
  const counted = Math.min(row.node.have, row.node.needed);
  const inHand = Math.max(0, row.node.have - atStation(view.stock, id));
  return { toGo, pending: Math.max(0, Math.min(counted - inHand, total - toGo)) };
}

export function buildProducts(ctx: GameCtx, view: PushView): Product[] {
  const whole = view.scratch;
  const recipeOf = (node: PlanNode | undefined) => node?.steps.find((s) => !s.fromStock)?.recipe;
  const nameOf = (id: Ref) => ctx.book.name(id);
  const professionFor = (node: PlanNode) => (view.onOrder.has(node.id) ? 'Trade' : professionOf(node, recipeOf(node), ctx));

  const todoOf = new Map<Ref, Todo>();
  for (const todo of view.todos) {
    const held = todoOf.get(todo.row.id);
    if (!held || TODO_ORDER.indexOf(todo.kind) < TODO_ORDER.indexOf(held.kind)) todoOf.set(todo.row.id, todo);
  }

  // An assembly is put together from finished things: a building, or anything made from two or more crafted ingredients.
  const crafted = (id: Ref) => !!recipeOf(whole.nodes.get(id));
  const isAssembly = (node: PlanNode | undefined) => {
    const recipe = recipeOf(node);
    return !!recipe && (recipe.kind === 'build' || recipe.inputs.filter((input) => crafted(input.id)).length >= 2);
  };

  const products: Product[] = [];
  for (const node of whole.nodes.values()) {
    if (node.needed <= 0) continue;
    const assembly = isAssembly(node);
    // Who takes it as a finished thing: the push itself, or an assembly.
    const ends: Product['for'] = [];
    for (const use of node.uses) {
      if (!use.into) ends.push({ id: null, name: GOAL, qty: use.qty });
      else if (assembly || isAssembly(whole.nodes.get(use.into))) ends.push({ id: use.into, name: nameOf(use.into), qty: use.qty });
    }
    // Anything else is a step along a chain, and is listed under whatever that chain ends in.
    if (!ends.length) continue;
    const qty = ends.reduce((sum, e) => sum + e.qty, 0);

    // Walk back through the recipes, adding up how much of each thing this product takes.
    const found = new Map<Ref, { share: number; depth: number; feeds: Set<Ref> }>();
    // The order steps are listed in: everything a thing is made from, then the thing itself.
    const order: Ref[] = [];
    const opened = new Set<Ref>();
    const visit = (id: Ref, amount: number, depth: number, path: Ref[], feeds: Ref | null, open: boolean) => {
      const entry = found.get(id) ?? { share: 0, depth: 0, feeds: new Set<Ref>() };
      entry.share += amount;
      entry.depth = Math.max(entry.depth, depth);
      if (feeds) entry.feeds.add(feeds);
      found.set(id, entry);
      const recipe = recipeOf(whole.nodes.get(id));
      if (recipe && open && !path.includes(id)) {
        opened.add(id);
        const runs = amount / yieldOf(recipe, id);
        // The ingredients of an assembly, and any assembly met along a chain, have their own line: they are named here, not opened up.
        for (const input of recipe.inputs) visit(input.id, runs * input.qty, depth + 1, [...path, id], id, !assembly && !isAssembly(whole.nodes.get(input.id)));
      }
      if (!order.includes(id)) order.push(id);
    };
    visit(node.id, qty, 0, [], null, true);

    const listed = [...found]
      .map(([id, entry]) => {
        const at = whole.nodes.get(id);
        const thing = ctx.book.thing(id);
        const recipe = opened.has(id) ? recipeOf(at) : undefined;
        const total = at?.needed ?? entry.share;
        const runs = recipe ? entry.share / yieldOf(recipe, id) : 0;
        const step: MakeStep = {
          id,
          name: thing?.name ?? id,
          tier: thing?.tier ?? 0,
          profession: at ? professionFor(at) : 'Other',
          raw: !recipeOf(at),
          share: entry.share,
          recipe,
          from: recipe ? recipe.inputs.map((input) => ({ id: input.id, name: nameOf(input.id), qty: runs * input.qty })) : [],
          total,
          ...standing(view, id, total),
          jobs: view.stock.atStations.get(id) ?? [],
          todo: todoOf.get(id),
          wanted: false,
          state: 'done',
        };
        return { step, depth: entry.depth, feeds: entry.feeds };
      })
      // Whatever something is made from comes before it, each ingredient with its own steps kept together.
      .sort((a, b) => order.indexOf(a.step.id) - order.indexOf(b.step.id));

    // More of a step is only wanted while something it feeds still has to be made.
    const stepOf = new Map(listed.map((entry) => [entry.step.id, entry.step]));
    for (const { step, feeds } of [...listed].sort((a, b) => a.depth - b.depth)) {
      step.wanted = step.toGo > 0 && (step.id === node.id || [...feeds].some((id) => stepOf.get(id)?.wanted));
      if (step.wanted) step.state = step.todo ? STATE_OF[step.todo.kind] : 'waiting';
      else if (step.pending > 0) step.state = step.jobs.length && step.jobs.every((j) => j.done) ? 'collect' : 'station';
    }

    const steps = listed.map((entry) => entry.step);
    const thing = ctx.book.thing(node.id);
    products.push({
      id: node.id,
      name: thing?.name ?? node.id,
      tier: thing?.tier ?? 0,
      profession: professionFor(node),
      qty,
      for: ends,
      assembly,
      raw: !recipeOf(node),
      steps,
      open: steps[steps.length - 1].toGo > 0,
    });
  }
  // Professions together, and within each from the lowest tier up.
  return products.sort((a, b) => professionRank(a.profession) - professionRank(b.profession) || a.tier - b.tier || a.name.localeCompare(b.name));
}

/** The step of a product to look at first: something that can be done now, else what is at a station, else what it is waiting for. */
export function nextStep(product: Product): MakeStep | undefined {
  const pick = (...states: StepState[]) => product.steps.find((s) => states.includes(s.state));
  // Something at a station to pick up or craft comes before going out to gather more.
  return pick('collect') ?? pick('craft') ?? pick('gather', 'buy') ?? pick('station') ?? pick('waiting');
}

/** The profession bought things are filed under: sold by a traveler, or on a claim buy order. */
export const BOUGHT = 'Trade';

/** A gathered or bought material, and every finished thing some of it ends up in. */
export interface RawMaterial {
  step: MakeStep;
  ends: { product: Product; share: number }[];
}

/** Every raw material in the push with what it ends up as, professions together and lowest tier first. */
export function rawMaterials(products: Product[]): RawMaterial[] {
  const found = new Map<Ref, RawMaterial>();
  for (const product of products) {
    for (const step of product.steps) {
      // A raw material an assembly takes directly is a product of its own ("used as it is"), so it is not counted twice.
      if (!step.raw || (product.assembly && step.id !== product.id)) continue;
      const raw = found.get(step.id) ?? { step, ends: [] };
      raw.ends.push({ product, share: step.share });
      found.set(step.id, raw);
    }
  }
  for (const raw of found.values()) raw.ends.sort((a, b) => b.share - a.share);
  return [...found.values()].sort((a, b) => professionRank(a.step.profession) - professionRank(b.step.profession) || a.step.tier - b.step.tier || a.step.name.localeCompare(b.step.name));
}

/**
 * Hand-picks how `id` is made (a recipe id, null for "don't craft it", undefined for the
 * default) and keeps that recipe's other outputs on the same choice. Butchering a Plains Ox
 * or a Dromai each gives pelt, meat and hair: picking Ox for the pelt alone would leave the
 * hair on Dromai and plan two hunts where one does both. An output only follows along when
 * it was coming from a twin recipe (one that also makes `id`); a pick made for its own
 * reasons is left alone.
 */
export function pickRoute(ctx: GameCtx, routes: Record<Ref, string | null>, id: Ref, value: string | null | undefined): Record<Ref, string | null> {
  const next = { ...routes };
  if (value === undefined) delete next[id];
  else next[id] = value;
  if (value === null) return next;
  const chosen = value ? ctx.book.recipe(value) : ctx.router.choose(id);
  if (!chosen) return next;
  for (const { id: other } of chosen.outputs) {
    if (other === id) continue;
    const current = other in next ? next[other] : ctx.router.choose(other)?.id;
    if (!current || current === chosen.id) continue;
    const twin = ctx.book.recipe(current);
    if (!twin || yieldOf(twin, id) <= 0) continue;
    if (ctx.router.choose(other)?.id === chosen.id) delete next[other];
    else next[other] = chosen.id;
  }
  return next;
}

/**
 * Other gathered things that would do the same job as `id`: the T5 pelt comes from
 * butchering a Plains Ox or a Dromai, three pelts either way, so whichever the plan
 * picked, the other is a stand-in. Only recipes that take that one thing and are about
 * as much work count. The planner already uses a stand-in that is sitting in storage.
 */
export function standIns(ctx: GameCtx, view: PushView, id: Ref): Ref[] {
  const node = view.plan.nodes.get(id) ?? view.scratch.nodes.get(id);
  const found = new Set<Ref>();
  for (const use of node?.uses ?? []) {
    const recipe = use.recipeId ? ctx.book.recipe(use.recipeId) : undefined;
    if (!use.into || !recipe || recipe.inputs.length !== 1 || recipe.inputs[0].id !== id) continue;
    const cost = ctx.router.recipeCost(recipe, use.into);
    for (const other of ctx.router.crafts(use.into)) {
      const input = other.inputs[0]?.id;
      if (other === recipe || other.inputs.length !== 1 || input === id) continue;
      if (ctx.router.choose(input) !== null || !ctx.router.gatherSources(input).some((r) => !r.loot)) continue;
      if (ctx.router.recipeCost(other, use.into) <= cost * 1.25 + 1e-9) found.add(input);
    }
  }
  return [...found];
}
