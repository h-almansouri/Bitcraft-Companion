import { RecipeBook, yieldOf } from './book.ts';
import type { Recipe, Ref, SourceKind } from './types';

/**
 * Picks the default way to make each thing.
 *
 * Most things have one obvious recipe, but plenty have several: planks can be
 * sawn normally or doubled with hexite fragments, fish oil can come from a dozen
 * kinds of fish, sand can be dug or sieved out of river muck. To choose without a
 * hand-written list, every thing gets a rough "effort" price (player actions to
 * obtain one, all the way down to gathering), and the cheapest recipe wins.
 * Players can always override a choice per push.
 */

/** Stand-in effort for buying one unit from a traveler. */
const BUY_COST = 40;
/**
 * Price for something the data gives no source for (event items, legacy items,
 * trophy catches). Deliberately enormous: a recipe that needs one is only picked
 * when there is no other way, never because it looks like a shortcut.
 */
const UNKNOWN_COST = 1e7;

export interface RouterOptions {
  /** Recipes never to pick automatically. */
  excluded?: Iterable<string>;
  /** thing -> traveler that sells it */
  sold?: Record<Ref, string>;
}

export class Router {
  private readonly cost = new Map<Ref, number>();
  private readonly ranked = new Map<Ref, Recipe[]>();
  private readonly excluded: Set<string>;
  private readonly sold: Record<Ref, string>;
  private readonly book: RecipeBook;

  constructor(book: RecipeBook, options: RouterOptions = {}) {
    this.book = book;
    this.excluded = new Set(options.excluded ?? []);
    this.sold = options.sold ?? {};
    this.solve();
  }

  /** Rough player actions to obtain one of this thing. */
  costOf(id: Ref): number {
    return this.cost.get(id) ?? UNKNOWN_COST;
  }

  /** Effort for one unit of `id` through this specific recipe. */
  recipeCost(recipe: Recipe, id: Ref): number {
    const made = yieldOf(recipe, id);
    if (made <= 0) return Infinity;
    if (recipe.kind === 'gather') return (recipe.effort ?? 1) / made;
    let total = recipe.effort ?? 0;
    for (const input of recipe.inputs) total += this.costOf(input.id) * input.qty;
    return total / made;
  }

  /** Places in the world this drops from: farmable spots first, then one-off finds, richest first. */
  gatherSources(id: Ref): Recipe[] {
    return this.book
      .producers(id)
      .filter((r) => r.kind === 'gather')
      .sort((a, b) => Number(!!a.loot) - Number(!!b.loot) || yieldOf(b, id) - yieldOf(a, id));
  }

  /** Recipes that make this at a station or build site, cheapest first. Never includes unpacking. */
  crafts(id: Ref): Recipe[] {
    let list = this.ranked.get(id);
    if (!list) {
      const all = this.book.producers(id).filter((r) => (r.kind === 'craft' || r.kind === 'build') && !this.excluded.has(r.id));
      list = all
        .map((r) => ({ r, cost: this.recipeCost(r, id), boosted: all.some((other) => isBoostOf(r, other)) }))
        // A "boosted" recipe is a normal one plus an extra ingredient for bonus output
        // (hexite fragments doubling planks). It is opt-in, so it sorts after the plain version.
        .sort((a, b) => Number(a.boosted) - Number(b.boosted) || a.cost - b.cost || a.r.id.localeCompare(b.r.id))
        .map((x) => x.r);
      this.ranked.set(id, list);
    }
    return list;
  }

  /** Recipes that open a package into this thing. */
  unpacks(id: Ref): Recipe[] {
    return this.book.producers(id).filter((r) => r.kind === 'unpack');
  }

  /**
   * The recipe to plan with, or null when the thing should simply be gathered or bought.
   * `blocked` holds things already being made further up the chain; a recipe that needs
   * one of them would be a loop (seeds -> plant -> seeds), so it is skipped.
   */
  choose(id: Ref, blocked?: ReadonlySet<Ref>): Recipe | null {
    const gatherCost = this.bestGatherCost(id);
    for (const recipe of this.crafts(id)) {
      if (blocked && recipe.inputs.some((i) => blocked.has(i.id))) continue;
      // Gathering it directly is less work than this (and every later) recipe.
      if (this.recipeCost(recipe, id) > gatherCost) return null;
      return recipe;
    }
    return null;
  }

  /** How a thing is obtained when the plan does not craft it. */
  rawSource(id: Ref): SourceKind {
    if (this.gatherSources(id).length) return 'gather';
    if (this.sold[id]) return 'buy';
    return 'gather';
  }

  private bestGatherCost(id: Ref): number {
    let best = Infinity;
    for (const r of this.book.producers(id)) {
      // One-off finds (chests, ruins) are a bonus, not a plan.
      if (r.kind !== 'gather' || r.loot) continue;
      const c = this.recipeCost(r, id);
      if (c < best) best = c;
    }
    return best;
  }

  /** Shortest-path style relaxation: prices only ever go down, so this settles even through loops. */
  private solve() {
    const { book, cost } = this;
    const ids = new Set<Ref>(Object.keys(book.things));
    for (const r of book.recipes) {
      for (const s of r.inputs) ids.add(s.id);
      for (const s of r.outputs) ids.add(s.id);
    }
    const craftable = new Set<Ref>();
    const crafting = book.recipes.filter((r) => (r.kind === 'craft' || r.kind === 'build') && !this.excluded.has(r.id));
    for (const r of crafting) for (const o of r.outputs) craftable.add(o.id);

    for (const id of ids) {
      const gathered = this.bestGatherCost(id);
      if (gathered < Infinity) cost.set(id, gathered);
      else if (this.sold[id]) cost.set(id, BUY_COST);
      else if (!craftable.has(id)) cost.set(id, UNKNOWN_COST);
    }

    const relax = () => {
      for (let pass = 0; pass < 80; pass++) {
        let changed = false;
        for (const r of crafting) {
          let total = r.effort ?? 0;
          let known = true;
          for (const input of r.inputs) {
            const c = cost.get(input.id);
            if (c === undefined) {
              known = false;
              break;
            }
            total += c * input.qty;
          }
          if (!known) continue;
          for (const o of r.outputs) {
            if (o.qty <= 0) continue;
            const c = total / o.qty;
            const current = cost.get(o.id);
            if (current === undefined || c < current - 1e-9) {
              cost.set(o.id, c);
              changed = true;
            }
          }
        }
        if (!changed) break;
      }
    };
    relax();
    // Anything still unpriced only exists inside a loop with no way in.
    let stuck = false;
    for (const id of ids) {
      if (!cost.has(id)) {
        cost.set(id, UNKNOWN_COST);
        stuck = true;
      }
    }
    if (stuck) relax();
  }
}

/** True when `recipe` is `base` with at least one extra ingredient added on top. */
function isBoostOf(recipe: Recipe, base: Recipe): boolean {
  if (recipe === base || recipe.inputs.length <= base.inputs.length || !base.inputs.length) return false;
  return base.inputs.every((b) => recipe.inputs.some((i) => i.id === b.id && i.qty >= b.qty));
}
