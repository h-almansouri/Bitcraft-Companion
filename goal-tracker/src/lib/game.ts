import { useEffect, useState } from 'react';
import { RecipeBook } from '../engine/book.ts';
import { inflate, type Game, type RawGameData } from '../engine/gamedata.ts';
import { Router } from '../engine/routes.ts';
import type { Ref, Thing } from '../engine/types.ts';
import { HOME } from './claim.ts';

/** Everything the planner needs, loaded once per visit. */
export interface GameCtx {
  game: Game;
  book: RecipeBook;
  router: Router;
  /** Name search over everything that can be a goal. */
  search(query: string, limit?: number): Thing[];
  /** The plain material of a family at a tier, e.g. find('Plank', 3) -> Sturdy Plank. */
  find(tag: string, tier: number): Ref | undefined;
}

let pending: Promise<GameCtx> | undefined;

export function loadGame(): Promise<GameCtx> {
  pending ??= fetch(HOME + '/gamedata.json')
    .then((res) => {
      if (!res.ok) throw new Error('Could not load the game data.');
      return res.json() as Promise<RawGameData>;
    })
    .then((raw) => {
      const game = inflate(raw);
      const book = new RecipeBook(game);
      const router = new Router(book, { sold: game.sold });
      const all = Object.values(game.things);
      const index = all.map((t) => ({ t, key: t.name.toLowerCase() }));
      return {
        game,
        book,
        router,
        search(query, limit = 12) {
          const words = query.toLowerCase().split(/\s+/).filter(Boolean);
          if (!words.length) return [];
          const hits = index.filter((e) => words.every((w) => e.key.includes(w)));
          // Things that can actually be made or found rank above cosmetics and oddities.
          const score = (e: (typeof index)[number]) =>
            (e.key.startsWith(words[0]) ? 0 : 2) + (book.producers(e.t.id).length ? 0 : 1) + e.key.length / 200;
          return hits
            .sort((a, b) => score(a) - score(b))
            .slice(0, limit)
            .map((e) => e.t);
        },
        find(tag, tier) {
          const matches = all.filter((t) => t.tag === tag && t.tier === tier && t.kind === 'item' && (t.rarity ?? 1) <= 1);
          matches.sort((a, b) => a.name.length - b.name.length);
          return matches[0]?.id;
        },
      } satisfies GameCtx;
    })
    .catch((err) => {
      pending = undefined;
      throw err;
    });
  return pending;
}

export function useGame(): { ctx: GameCtx | null; error: string | null } {
  const [ctx, setCtx] = useState<GameCtx | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    loadGame().then(
      (g) => live && setCtx(g),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, []);
  return { ctx, error };
}
