import type { GatherNode } from '../engine/types.ts';

/**
 * The game's biomes, from its biome_desc table (all but "Dev"). The game does not say which
 * resources grow in which biome, so players note it on the board (Board.grows); these are
 * offered as one-tap picks so the names come out spelled the same every time.
 */
export const BIOMES = [
  'Calm Forest',
  'Pine Woods',
  'Autumn Forest',
  'Breezy Grasslands',
  'Safe Meadows',
  'Misty Tundra',
  'Snowy Peaks',
  'Rocky Garden',
  'Swamp',
  'Desert Wasteland',
  'Deserted Beach',
  'Jungle',
  'Tropical Canopy',
  'Sapwoods',
  'Volcanic Crag',
  'Cave',
  'Open Ocean',
  'Uncharted Ocean',
] as const;

/** Where a note about a resource node or creature is kept on the board: r88, e12. */
export const nodeKey = (node: Pick<GatherNode, 'kind' | 'id'>) => `${node.kind === 'creature' ? 'e' : 'r'}${node.id}`;

/** The places in a note, in the order written: "Calm Forest, misty tundra" → both. */
export const placesIn = (text: string) =>
  text
    .split(/[,;\n]+/)
    .map((p) => p.trim())
    .filter(Boolean);

/** Adds a place to a note, or takes it out if it is already there (ignoring case). */
export function togglePlace(text: string, place: string) {
  const places = placesIn(text);
  const at = places.findIndex((p) => p.toLowerCase() === place.toLowerCase());
  if (at >= 0) places.splice(at, 1);
  else places.push(place);
  return places.join(', ');
}
