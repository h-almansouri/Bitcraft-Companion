/** How far along, as a colour: red, orange, yellow, then greens that deepen as it nears done. */
const STOPS: [at: number, rgb: [number, number, number]][] = [
  [0, [224, 70, 60]],
  [0.25, [238, 138, 58]],
  [0.5, [232, 197, 63]],
  [0.7, [165, 208, 90]],
  [0.85, [91, 191, 94]],
  [1, [31, 157, 77]],
];

/** The colour for a progress bar that is `value` (0..1) of the way there. */
export function progressColor(value: number): string {
  const v = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  let next = 1;
  while (next < STOPS.length - 1 && v > STOPS[next]![0]) next++;
  const [from, a] = STOPS[next - 1]!;
  const [to, b] = STOPS[next]!;
  const t = (v - from) / (to - from);
  const mix = a.map((channel, i) => Math.round(channel + (b[i]! - channel) * t));
  return `rgb(${mix.join(' ')})`;
}
