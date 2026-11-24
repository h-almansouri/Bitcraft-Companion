import { RecipeBook, yieldOf } from './book.ts';
import { Router } from './routes.ts';
import type { Goal, Plan, PlanNode, PlanOptions, Recipe, Ref, Step, Use } from './types.ts';

/**
 * Works out everything a push needs.
 *
 * Start from the goals, look at what is already in storage, and walk down the
 * recipes: whatever is still missing gets crafted, which creates demand for its
 * ingredients, and so on until only things you gather or buy are left.
 *
 * Every node records where its quantity goes (`uses`), which is what lets the
 * site say "6,220 fiber: 6,160 become thread, 60 are used as plain fiber".
 */
export function plan(book: RecipeBook, router: Router, goals: Goal[], stock: ReadonlyMap<Ref, number>, options: PlanOptions = {}): Plan {
  const warnings: string[] = [];
  const routes = options.routes ?? {};
  const useStock = options.useStockAlternates !== false;

  // ---- 1. decide how each thing is made, and in what order to work through them ----
  const chosen = new Map<Ref, Recipe | null>();
  const stockRoutes = new Map<Ref, Recipe[]>();
  const done = new Set<Ref>();
  const path = new Set<Ref>();
  const finished: Ref[] = [];

  const resolve = (id: Ref): Recipe | null => {
    if (id in routes) {
      const wanted = routes[id];
      if (wanted === null) return null;
      const recipe = book.recipe(wanted);
      if (recipe && yieldOf(recipe, id) > 0 && !recipe.inputs.some((i) => path.has(i.id))) return recipe;
      warnings.push(`The chosen route for ${book.name(id)} could not be used, so the default was planned instead.`);
    }
    return router.choose(id, path);
  };

  /** Ways to make `id` out of something already sitting in storage: open a package, or process a raw material. */
  const fromStock = (id: Ref, main: Recipe | null): Recipe[] => {
    if (!useStock) return [];
    const out: Recipe[] = [];
    for (const recipe of [...router.unpacks(id), ...router.crafts(id)]) {
      if (recipe === main || recipe.inputs.length !== 1) continue;
      const input = recipe.inputs[0];
      if ((stock.get(input.id) ?? 0) < input.qty || path.has(input.id)) continue;
      if (main && main.inputs.some((i) => i.id === input.id)) continue;
      // Only raw materials and packages: never suggest breaking down something that was crafted on purpose.
      if (recipe.kind !== 'unpack' && router.choose(input.id) !== null) continue;
      out.push(recipe);
    }
    return out;
  };

  const visit = (id: Ref) => {
    if (done.has(id) || path.has(id)) return;
    path.add(id);
    const recipe = resolve(id);
    chosen.set(id, recipe);
    if (recipe) for (const input of recipe.inputs) visit(input.id);
    const extras = fromStock(id, recipe);
    if (extras.length) {
      stockRoutes.set(id, extras);
      for (const extra of extras) visit(extra.inputs[0].id);
    }
    path.delete(id);
    done.add(id);
    finished.push(id);
  };

  const goalQty = new Map<Ref, number>();
  for (const goal of goals) {
    if (!(goal.qty > 0)) continue;
    if (!book.thing(goal.id) && !book.producers(goal.id).length) warnings.push(`Unknown goal ${goal.id}.`);
    goalQty.set(goal.id, (goalQty.get(goal.id) ?? 0) + goal.qty);
  }
  for (const id of goalQty.keys()) visit(id);
  // Everything is listed after the things that consume it.
  const order = finished.reverse();

  // ---- 2. push quantities down the chain ----
  /** thing -> (who uses it -> how much) */
  const demand = new Map<Ref, Map<string, Use>>();
  /** recipe -> runs. One run can serve several outputs at once (a hide gives pelt and hair). */
  const runs = new Map<string, number>();
  const nodes = new Map<Ref, PlanNode>();
  const depth = new Map<Ref, number>();

  const claim = (input: Ref, into: Ref, recipe: Recipe, qty: number, count: number) => {
    let users = demand.get(input);
    if (!users) demand.set(input, (users = new Map()));
    users.set(recipe.id, { into, recipeId: recipe.id, qty, runs: count });
    depth.set(input, Math.max(depth.get(input) ?? 0, (depth.get(into) ?? 0) + 1));
  };

  for (const id of order) {
    const goal = goalQty.get(id) ?? 0;
    const uses: Use[] = [...(demand.get(id)?.values() ?? [])];
    const needed = goal + uses.reduce((sum, u) => sum + u.qty, 0);
    if (needed <= 0) continue;

    const have = stock.get(id) ?? 0;
    const toGo = Math.max(0, needed - have);
    const recipe = chosen.get(id) ?? null;
    const steps: Step[] = [];
    let remaining = toGo;

    if (remaining > 0) {
      for (const extra of stockRoutes.get(id) ?? []) {
        const input = extra.inputs[0];
        const made = yieldOf(extra, id);
        const count = Math.min(Math.floor((stock.get(input.id) ?? 0) / input.qty), Math.ceil(remaining / made - 1e-9));
        if (count <= 0) continue;
        // The same run may already be planned for another of its outputs (one hide gives pelt and hair).
        const total = Math.max(runs.get(extra.id) ?? 0, count);
        runs.set(extra.id, total);
        steps.push({ recipe: extra, runs: total, fromStock: true });
        claim(input.id, id, extra, total * input.qty, total);
        remaining -= total * made;
        if (remaining <= 1e-9) break;
      }
    }

    if (remaining > 1e-9 && recipe) {
      const count = Math.ceil(remaining / yieldOf(recipe, id) - 1e-9);
      const total = Math.max(runs.get(recipe.id) ?? 0, count);
      runs.set(recipe.id, total);
      for (const input of recipe.inputs) claim(input.id, id, recipe, total * input.qty, total);
      steps.push({ recipe, runs: total });
    }

    if (goal > 0) uses.push({ into: null, qty: goal });
    uses.sort((a, b) => b.qty - a.qty);

    nodes.set(id, {
      id,
      goal,
      needed,
      have,
      toGo,
      surplus: Math.max(0, have - needed),
      source: recipe ? (recipe.kind === 'build' ? 'build' : 'craft') : router.rawSource(id),
      steps,
      produced: 0,
      uses,
      alternatives: router.crafts(id),
      depth: depth.get(id) ?? 0,
    });
  }

  // A shared recipe may have been bumped up by a later output; settle the final numbers.
  for (const node of nodes.values()) {
    for (const step of node.steps) step.runs = runs.get(step.recipe.id) ?? step.runs;
    node.produced = node.steps.reduce((sum, s) => sum + s.runs * yieldOf(s.recipe, node.id), 0);
  }

  return { nodes, order: order.filter((id) => nodes.has(id)), warnings };
}

/** Convenience for callers holding a plain object of stock counts. */
export function toStock(counts: Record<Ref, number> | ReadonlyMap<Ref, number>): ReadonlyMap<Ref, number> {
  return counts instanceof Map ? counts : new Map(Object.entries(counts as Record<Ref, number>));
}
