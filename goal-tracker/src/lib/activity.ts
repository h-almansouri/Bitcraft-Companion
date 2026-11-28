import type { ChestMove } from './shapes.ts';

/** One line in a chest's activity list: back-to-back moves of the same thing by the same person, added up. */
export interface MoveGroup extends ChestMove {
  /** The earliest move folded into this line (`at` is the latest). */
  from: string;
  trips: number;
}

/**
 * Folds back-to-back moves (newest first) of the same thing, by the same person, in the same
 * direction and no more than `minutes` apart, into one line. Moving 40 planks one at a time
 * reads as "+40 Plank, 40 trips" instead of filling the list.
 */
export function mergeMoves(moves: readonly ChestMove[], minutes = 5): MoveGroup[] {
  const out: MoveGroup[] = [];
  for (const m of moves) {
    const last = out[out.length - 1];
    const close = last && new Date(last.from).getTime() - new Date(m.at).getTime() <= minutes * 60_000;
    if (last && close && last.whoId === m.whoId && last.item === m.item && last.kind === m.kind) {
      last.qty += m.qty;
      last.from = m.at;
      last.trips++;
    } else out.push({ ...m, from: m.at, trips: 1 });
  }
  return out;
}
