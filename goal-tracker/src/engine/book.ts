import type { GameData, Recipe, Ref, Thing } from './types';

/** Indexed view of the game data: look things up, and find what makes or uses them. */
export class RecipeBook {
  readonly things: Record<Ref, Thing>;
  readonly recipes: Recipe[];
  private readonly byId = new Map<string, Recipe>();
  private readonly makes = new Map<Ref, Recipe[]>();
  private readonly consumes = new Map<Ref, Recipe[]>();

  constructor(data: GameData) {
    this.things = data.things;
    this.recipes = data.recipes;
    for (const r of data.recipes) {
      this.byId.set(r.id, r);
      for (const o of r.outputs) push(this.makes, o.id, r);
      for (const i of r.inputs) push(this.consumes, i.id, r);
    }
  }

  thing(id: Ref): Thing | undefined {
    return this.things[id];
  }

  name(id: Ref): string {
    return this.things[id]?.name ?? id;
  }

  recipe(id: string): Recipe | undefined {
    return this.byId.get(id);
  }

  /** Every recipe that outputs this thing. */
  producers(id: Ref): Recipe[] {
    return this.makes.get(id) ?? [];
  }

  /** Every recipe that takes this thing as an ingredient. */
  consumers(id: Ref): Recipe[] {
    return this.consumes.get(id) ?? [];
  }
}

/** Expected amount of `id` one run of the recipe gives. */
export function yieldOf(recipe: Recipe, id: Ref): number {
  let total = 0;
  for (const o of recipe.outputs) if (o.id === id) total += o.qty;
  return total;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
