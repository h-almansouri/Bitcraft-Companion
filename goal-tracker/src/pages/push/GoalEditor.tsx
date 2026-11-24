import { useState } from 'react';
import { Plus, Search, Trash2 } from 'lucide-react';
import type { Goal } from '../../engine/types.ts';
import type { GameCtx } from '../../lib/game.ts';
import { Button, Card, TierChip, inputBase, inputClass } from '../../ui/kit.tsx';

/** The list of things a push sets out to make, with a search box to add more. */
export function GoalEditor({ ctx, goals, onChange }: { ctx: GameCtx; goals: Goal[]; onChange: (goals: Goal[]) => void }) {
  const [query, setQuery] = useState('');
  const results = query.trim().length >= 2 ? ctx.search(query, 8) : [];

  const add = (id: string) => {
    if (goals.some((g) => g.id === id)) return;
    onChange([...goals, { id, qty: 1 }]);
    setQuery('');
  };
  const setQty = (id: string, qty: number) => onChange(goals.map((g) => (g.id === id ? { ...g, qty } : g)));

  return (
    <div>
      {goals.length > 0 && (
        <Card className="divide-y divide-line">
          {goals.map((goal) => {
            const thing = ctx.book.thing(goal.id);
            return (
              <div key={goal.id} className="flex items-center gap-3 px-4 py-2">
                <TierChip tier={thing?.tier ?? 0} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{thing?.name ?? goal.id}</span>
                <input
                  type="number"
                  min={1}
                  max={10000000}
                  aria-label={`Quantity of ${thing?.name ?? goal.id}`}
                  value={goal.qty}
                  onChange={(e) => setQty(goal.id, Math.max(1, Math.round(Number(e.target.value) || 1)))}
                  className={inputBase + ' num h-9 w-28 text-right'}
                />
                <Button variant="ghost" size="sm" className="w-8 px-0" aria-label={`Remove ${thing?.name ?? goal.id}`} onClick={() => onChange(goals.filter((g) => g.id !== goal.id))}>
                  <Trash2 size={15} />
                </Button>
              </div>
            );
          })}
        </Card>
      )}

      <div className="relative mt-3">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <input className={inputClass + ' pl-9'} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Add something to make: Exquisite Loom, Fine Rope, Healing Potion" aria-label="Search for something to make" />
        {results.length > 0 && (
          <Card className="absolute inset-x-0 top-11 z-10 max-h-72 overflow-y-auto py-1 shadow-xl">
            {results.map((thing) => {
              const added = goals.some((g) => g.id === thing.id);
              return (
                <button key={thing.id} type="button" disabled={added} onClick={() => add(thing.id)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-2 disabled:opacity-50">
                  <TierChip tier={thing.tier} />
                  <span className="min-w-0 flex-1 truncate">{thing.name}</span>
                  <span className="text-xs text-muted">{added ? 'already a goal' : thing.kind === 'building' ? 'building' : (thing.tag ?? '')}</span>
                  {!added && <Plus size={15} className="text-muted" />}
                </button>
              );
            })}
          </Card>
        )}
        {query.trim().length >= 2 && results.length === 0 && <p className="mt-2 text-[13px] text-ink-2">Nothing in the game is called that.</p>}
      </div>
    </div>
  );
}
