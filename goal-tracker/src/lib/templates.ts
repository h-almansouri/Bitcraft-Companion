import type { Goal } from '../engine/types.ts';
import { TIER_NAMES } from './format.ts';
import type { GameCtx } from './game.ts';

/**
 * Starting points for a new push. Each returns a list of goals the player can
 * then adjust; nothing here is special-cased by the planner.
 */

/** The workstations a settlement rebuilds at each tier. The four that run on their own are usually doubled. */
const STATIONS: { type: number; qty: number }[] = [
  { type: 20, qty: 1 }, // Carpentry Station
  { type: 22, qty: 1 }, // Masonry Station
  { type: 25, qty: 1 }, // Smithing Station
  { type: 16, qty: 1 }, // Leatherworking Station
  { type: 17, qty: 1 }, // Tailoring Station
  { type: 48, qty: 1 }, // Scholar Station
  { type: 33, qty: 1 }, // Farming Station
  { type: 40, qty: 1 }, // Fishing Station
  { type: 44, qty: 1 }, // Forestry Station
  { type: 2012420824, qty: 1 }, // Foraging Station
  { type: 1559722792, qty: 1 }, // Hunting Station
  { type: 635094930, qty: 1 }, // Mining Station
  { type: 21, qty: 2 }, // Kiln
  { type: 24, qty: 2 }, // Smelter
  { type: 14, qty: 2 }, // Loom
  { type: 15, qty: 2 }, // Tanning Tub
];

/** Tiers the game has a township upgrade for. */
export const townshipTiers = (ctx: GameCtx) => ctx.game.townships.map((t) => t.tier);

export function stationGoals(ctx: GameCtx, tier: number): Goal[] {
  const goals: Goal[] = [];
  const prefix = TIER_NAMES[tier] ?? '';
  for (const station of STATIONS) {
    const options = Object.entries(ctx.game.stationType)
      .filter(([id, type]) => type === station.type && ctx.book.thing(id)?.tier === tier && ctx.book.producers(id).length)
      .map(([id]) => ctx.book.thing(id)!)
      // Prefer the plain "Exquisite Loom" over themed or oversized variants.
      .sort((a, b) => Number(!a.name.startsWith(prefix)) - Number(!b.name.startsWith(prefix)) || a.name.length - b.name.length);
    if (options[0]) goals.push({ id: options[0].id, qty: station.qty });
  }
  return goals;
}

/** Researching "Tier N Township", optionally with a full set of tier-N workstations. */
export function claimTierGoals(ctx: GameCtx, tier: number, withStations: boolean): Goal[] {
  const township = ctx.game.townships.find((t) => t.tier === tier);
  const goals: Goal[] = (township?.inputs ?? []).map(([id, qty]) => ({ id, qty }));
  return withStations ? [...goals, ...stationGoals(ctx, tier)] : goals;
}

/** What each tool costs at every tier it is pushed through. */
export const TOOL_COST = [
  { tag: 'Ingot', qty: 4 },
  { tag: 'Rope', qty: 2 },
  { tag: 'Plank', qty: 2 },
  { tag: 'Leather', qty: 2 },
];

/** Rolling `tools` tools up through tiers `from`..`to`, hoping the rarity climbs each step. */
export function toolPushGoals(ctx: GameCtx, tools: number, from: number, to: number): Goal[] {
  const goals: Goal[] = [];
  for (let tier = from; tier <= to; tier++) {
    for (const part of TOOL_COST) {
      const id = ctx.find(part.tag, tier);
      if (id) goals.push({ id, qty: part.qty * tools });
    }
  }
  return goals;
}
