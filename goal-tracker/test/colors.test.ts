import { describe, expect, it } from 'vitest';
import { progressColor } from '../src/lib/colors.ts';

const parts = (value: number) => progressColor(value).match(/\d+/g)!.map(Number) as [number, number, number];

describe('progress bar colour', () => {
  it('runs red, orange, yellow, then green', () => {
    expect(progressColor(0)).toBe('rgb(224 70 60)');
    expect(progressColor(0.25)).toBe('rgb(238 138 58)');
    expect(progressColor(0.5)).toBe('rgb(232 197 63)');
    expect(progressColor(1)).toBe('rgb(31 157 77)');
    // Red leads below halfway, green leads above it.
    for (const v of [0.05, 0.2, 0.4]) expect(parts(v)[0]).toBeGreaterThan(parts(v)[1]);
    for (const v of [0.6, 0.8, 0.95]) expect(parts(v)[1]).toBeGreaterThan(parts(v)[0]);
  });

  it('greens get deeper the closer to done', () => {
    const brightness = (v: number) => parts(v).reduce((sum, c) => sum + c, 0);
    expect(brightness(0.7)).toBeGreaterThan(brightness(0.8));
    expect(brightness(0.8)).toBeGreaterThan(brightness(0.9));
    expect(brightness(0.9)).toBeGreaterThan(brightness(1));
  });

  it('copes with values outside 0 to 1', () => {
    expect(progressColor(-3)).toBe(progressColor(0));
    expect(progressColor(7)).toBe(progressColor(1));
    expect(progressColor(Number.NaN)).toBe(progressColor(0));
  });
});
