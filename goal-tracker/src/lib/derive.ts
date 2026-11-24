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

export function buildStock(snapshot: StockSnapshot | null, push: Pick<Push, 'excluded' | 'players' | 'countCrafts'>): StockView {
  const totals = new Map<Ref, number>();
  const where = new Map<Ref, Holding[]>();
  const atStations = new Map<Ref, CraftJob[]>();
  if (!snapshot) return { totals, where, atStations };

  const excluded = new Set(push.excluded);
  const players = new Set(push.players);
  for (const loc of snapshot.locations) {
    if (excluded.has(loc.id)) continue;
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
  job?: CraftJob;
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
      let doable = step.runs;
      const missing: { id: Ref; short: number }[] = [];
      for (const input of step.recipe.inputs) {
        const have = stock.totals.get(input.id) ?? 0;
        doable = Math.min(doable, Math.floor(have / input.qty));
        const short = step.runs * input.qty - have;
        if (short > 0) missing.push({ id: input.id, short });
      }
      missing.sort((a, b) => b.short - a.short);
      todos.push({ key: `craft:${row.id}`, kind: doable > 0 ? 'craft' : 'blocked', row, qty: Math.min(made, node.toGo), step, doable, missing });
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

  return { plan: result, stock, rows, ordered, todos, professions, progress, onOrder };
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
// Supply chains: the same plan, laid out as raw material -> finished good.
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
  row: Row;
  /** How the previous stage turns into this one: `from` of it give `to` of this. */
  ratio?: { from: number; to: number };
  /** Everything else this stage's recipe needs besides the previous stage. */
  extras: ChainExtra[];
  /** Amount passed on to the next stage of this chain. */
  onward: number;
  /**
   * Amount to set aside and NOT process, because something uses it exactly as it
   * is (a station that takes raw roots, or the push goal itself). `for` lists what
   * it is being saved for; null stands for "it is a goal of the push".
   */
  save: { qty: number; for: (Row | null)[] };
  /** Amounts that are turned into something outside this chain. */
  branches: { row: Row; qty: number }[];
}

export interface Chain {
  key: string;
  stages: ChainStage[];
  /** Who starts the chain off: the profession of its rawest stage. */
  profession: string;
  /** True while any stage still has a gap. */
  open: boolean;
  /** Where the last stage ends up: other materials, or null for "it is a goal". */
  ends: (Row | null)[];
}

/**
 * Splits the plan into chains. Two materials sit next to each other in a chain
 * when each is the other's main partner: A is the costliest ingredient of B, and
 * B is where most of A goes. Everything else shows up as a side ingredient.
 */
/** How a stage's quantity divides between the next stage, being saved as-is, and other chains. */
function splitOf(view: PushView, row: Row, next: Row | undefined): Pick<ChainStage, 'onward' | 'save' | 'branches'> {
  const split: Pick<ChainStage, 'onward' | 'save' | 'branches'> = { onward: 0, save: { qty: 0, for: [] }, branches: [] };
  // The last stage's destinations are shown at the end of the line instead.
  if (!next) return split;
  for (const branch of flowOf(view, row.id)) {
    if (branch.into?.id === next.id) split.onward += branch.qty;
    else if (branch.final || !branch.into) {
      split.save.qty += branch.qty;
      split.save.for.push(branch.into);
    } else split.branches.push({ row: branch.into, qty: branch.qty });
  }
  return split;
}

export function buildChains(ctx: GameCtx, view: PushView): Chain[] {
  const recipeOf = (row: Row) => row.node.steps.find((s) => !s.fromStock)?.recipe ?? row.recipe;
  const up = new Map<Ref, Ref>();
  const down = new Map<Ref, Ref>();

  for (const row of view.rows.values()) {
    const recipe = recipeOf(row);
    if (!recipe) continue;
    let main: Ref | undefined;
    let weight = -1;
    for (const input of recipe.inputs) {
      if (!view.rows.has(input.id)) continue;
      const w = ctx.router.costOf(input.id) * input.qty;
      if (w > weight) (weight = w), (main = input.id);
    }
    if (!main || up.has(main)) continue;
    const biggestUse = view.rows.get(main)!.node.uses.find((u) => u.into);
    if (biggestUse?.into === row.id) {
      up.set(main, row.id);
      down.set(row.id, main);
    }
  }

  const chains: Chain[] = [];
  for (const start of view.ordered) {
    if (down.has(start.id)) continue;
    const rows: Row[] = [];
    for (let cur: Row | undefined = start; cur; cur = view.rows.get(up.get(cur.id) ?? '')) rows.push(cur);

    const stages = rows.map((row, i): ChainStage => {
      const prev = rows[i - 1];
      const next = rows[i + 1];
      const recipe = recipeOf(row);
      const fed = prev && recipe ? recipe.inputs.find((input) => input.id === prev.id) : undefined;
      return {
        row,
        ratio: fed && recipe ? { from: fed.qty, to: yieldOf(recipe, row.id) } : undefined,
        extras: (recipe?.inputs ?? [])
          .filter((input) => input.id !== prev?.id)
          .map((input) => ({
            id: input.id,
            name: ctx.book.name(input.id),
            tier: ctx.book.thing(input.id)?.tier ?? 0,
            perRun: input.qty,
            short: (view.rows.get(input.id)?.node.toGo ?? 0) > 0,
          })),
        ...splitOf(view, row, next),
      };
    });

    const last = rows[rows.length - 1];
    chains.push({
      key: start.id,
      stages,
      profession: start.profession,
      open: rows.some((r) => r.node.toGo > 0),
      ends: last.node.uses.map((u) => (u.into ? (view.rows.get(u.into) ?? null) : null)),
    });
  }
  return chains;
}
