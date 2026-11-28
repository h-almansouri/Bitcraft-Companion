import { describe, expect, it } from 'vitest';
import { BIOMES, nodeKey, placesIn, togglePlace } from '../src/lib/biomes.ts';

describe('notes on where things grow', () => {
  it('keys resources and creatures apart', () => {
    expect(nodeKey({ kind: 'resource', id: 88 })).toBe('r88');
    expect(nodeKey({ kind: 'creature', id: 12 })).toBe('e12');
  });

  it('reads the places out of whatever was typed', () => {
    expect(placesIn(' Calm Forest,misty tundra ;; Swamp\n')).toEqual(['Calm Forest', 'misty tundra', 'Swamp']);
    expect(placesIn('')).toEqual([]);
  });

  it('a biome pick adds the name, and picking it again takes it out, whatever the case it was typed in', () => {
    expect(togglePlace('', 'Calm Forest')).toBe('Calm Forest');
    expect(togglePlace('Calm Forest', 'Misty Tundra')).toBe('Calm Forest, Misty Tundra');
    expect(togglePlace('calm forest, near the big lake', 'Calm Forest')).toBe('near the big lake');
  });

  it('offers the game biomes, not its test one', () => {
    expect(BIOMES).toContain('Misty Tundra');
    expect(BIOMES).not.toContain('Dev');
    expect(new Set(BIOMES).size).toBe(BIOMES.length);
  });
});
