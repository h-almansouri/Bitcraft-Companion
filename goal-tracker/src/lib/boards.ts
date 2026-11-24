import { useSyncExternalStore } from 'react';
import type { Board } from './shapes.ts';

/**
 * The most recent copy of each board seen this visit. Pages put what they load
 * or save here so the sidebar can list a claim's pushes without fetching again.
 */
const boards = new Map<string, Board>();
const listeners = new Set<() => void>();

export function putBoard(board: Board) {
  if (boards.get(board.slug) === board) return;
  boards.set(board.slug, board);
  listeners.forEach((fn) => fn());
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export function useCachedBoard(slug: string | null): Board | null {
  return useSyncExternalStore(subscribe, () => (slug ? (boards.get(slug) ?? null) : null));
}
