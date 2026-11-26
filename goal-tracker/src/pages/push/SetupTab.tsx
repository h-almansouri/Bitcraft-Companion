import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api.ts';
import { navigate } from '../../lib/router.tsx';
import type { Push, PushKind, PushStatus } from '../../lib/shapes.ts';
import { claimTierGoals, stationGoals, townshipTiers } from '../../lib/templates.ts';
import { Button, Card, Field, Notice, inputBase, inputClass } from '../../ui/kit.tsx';
import { guarded } from '../../ui/unlock.tsx';
import { KIND_LABEL } from '../BoardPage.tsx';
import type { PushScope } from '../PushPage.tsx';
import { GoalEditor } from './GoalEditor.tsx';

type Draft = Pick<Push, 'name' | 'kind' | 'status' | 'note' | 'goals' | 'players' | 'countCrafts'>;
const pick = (p: Push): Draft => ({ name: p.name, kind: p.kind, status: p.status, note: p.note ?? '', goals: p.goals, players: p.players, countCrafts: p.countCrafts });

export function SetupTab({ scope }: { scope: PushScope }) {
  const { push, claim, ctx, board, save } = scope;
  const [draft, setDraft] = useState<Draft>(() => pick(push));
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const saved = useMemo(() => JSON.stringify(pick(push)), [push]);
  const dirty = JSON.stringify(draft) !== saved;
  // Whenever a save lands, start again from exactly what the server stored.
  useEffect(() => setDraft(pick(push)), [push.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const members = claim?.members ?? [];
  const tiers = townshipTiers(ctx);
  const tier = Math.min(Math.max((claim?.tier ?? 2) + 1, tiers[0] ?? 3), tiers[tiers.length - 1] ?? 10);

  const addGoals = (extra: { id: string; qty: number }[]) => {
    const merged = [...draft.goals];
    for (const goal of extra) if (!merged.some((g) => g.id === goal.id)) merged.push(goal);
    set({ goals: merged });
  };

  const submit = async () => {
    setBusy(true);
    try {
      await save({ ...draft, name: draft.name.trim() || push.name, note: draft.note?.trim() || undefined });
    } catch {
      /* the page shows the error */
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await guarded(board.slug, () => api.deletePush(board.slug, push.slug));
      navigate('/' + board.slug);
    } catch (err) {
      setProblem((err as Error).message);
      setBusy(false);
    }
  };

  const routeIds = Object.keys(push.routes);

  return (
    <div className="max-w-3xl space-y-8 pb-20">
      <section>
        <h2 className="text-[15px] font-semibold">About this push</h2>
        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_180px_180px]">
          <Field label="Name">
            <input className={inputClass} value={draft.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label="Type">
            <select className={inputClass} value={draft.kind} onChange={(e) => set({ kind: e.target.value as PushKind })}>
              {(Object.keys(KIND_LABEL) as PushKind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Status">
            <select className={inputClass} value={draft.status} onChange={(e) => set({ status: e.target.value as PushStatus })}>
              <option value="active">Active</option>
              <option value="planned">Planned</option>
              <option value="done">Completed</option>
            </select>
          </Field>
        </div>
        <div className="mt-4">
          <Field label="Note for the team" hint="Shown under the title. Optional.">
            <textarea className={inputBase + ' h-20 w-full resize-y py-2'} value={draft.note ?? ''} maxLength={600} onChange={(e) => set({ note: e.target.value })} placeholder="Drop finished planks in the Wood chest." />
          </Field>
        </div>
      </section>

      <section>
        <h2 className="text-[15px] font-semibold">What we are making</h2>
        <p className="mt-1 text-sm text-ink-2">Only list the finished things. Every ingredient underneath is worked out for you.</p>
        <div className="mt-3">
          <GoalEditor ctx={ctx} goals={draft.goals} onChange={(goals) => set({ goals })} />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => addGoals(claimTierGoals(ctx, tier, false))}>
            Add Tier {tier} township research
          </Button>
          <Button size="sm" onClick={() => addGoals(stationGoals(ctx, tier))}>
            Add a set of T{tier} workstations
          </Button>
        </div>
      </section>

      <section>
        <h2 className="text-[15px] font-semibold">Whose storage counts</h2>
        <p className="mt-1 text-sm text-ink-2">The claim's chests always count. Tick the people whose own bags, bank stashes, carts and houses should count too.</p>
        {members.length === 0 ? (
          <p className="mt-3 text-sm text-ink-2">The member list has not loaded.</p>
        ) : (
          <>
            <div className="mt-3 flex gap-2">
              <Button size="sm" onClick={() => set({ players: members.map((m) => m.id) })}>
                Everyone
              </Button>
              <Button size="sm" onClick={() => set({ players: [] })}>
                Nobody
              </Button>
            </div>
            <Card className="mt-2.5 grid grid-cols-1 gap-x-4 px-4 py-2 sm:grid-cols-2">
              {members.map((m) => (
                <label key={m.id} className="flex items-center gap-2.5 py-1.5 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-[var(--accent)]"
                    checked={draft.players.includes(m.id)}
                    onChange={(e) => set({ players: e.target.checked ? [...draft.players, m.id] : draft.players.filter((p) => p !== m.id) })}
                  />
                  {m.name}
                </label>
              ))}
            </Card>
          </>
        )}
        <label className="mt-3 flex items-center gap-2.5 text-sm">
          <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={draft.countCrafts} onChange={(e) => set({ countCrafts: e.target.checked })} />
          Count crafts loaded at stations as already made, at our base or anyone else's
        </label>
      </section>

      {routeIds.length > 0 && (
        <section>
          <h2 className="text-[15px] font-semibold">Hand-picked routes</h2>
          <p className="mt-1 text-sm text-ink-2">Things this push makes a different way from the default. Change them from each thing's details.</p>
          <Card className="mt-3 divide-y divide-line">
            {routeIds.map((id) => {
              const recipe = push.routes[id] ? ctx.book.recipe(push.routes[id]!) : null;
              return (
                <div key={id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{ctx.book.name(id)}</div>
                    <div className="truncate text-xs text-ink-2">{recipe ? `from ${recipe.inputs.map((i) => ctx.book.name(i.id)).join(' + ')}` : 'gathered or bought, not crafted'}</div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      const routes = { ...push.routes };
                      delete routes[id];
                      save({ routes }).catch(() => {});
                    }}
                  >
                    Use default
                  </Button>
                </div>
              );
            })}
          </Card>
        </section>
      )}

      <section>
        <h2 className="text-[15px] font-semibold">Remove</h2>
        {problem && (
          <div className="mt-2">
            <Notice tone="bad">{problem}</Notice>
          </div>
        )}
        <div className="mt-3 flex items-center gap-3">
          {confirming ? (
            <>
              <span className="text-sm">Delete “{push.name}” for everyone? This can't be undone.</span>
              <Button variant="danger" size="sm" disabled={busy} onClick={remove}>
                Delete push
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                Keep it
              </Button>
            </>
          ) : (
            <Button variant="danger" size="sm" onClick={() => setConfirming(true)}>
              Delete this push
            </Button>
          )}
        </div>
      </section>

      {dirty && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface/95 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
            <span className="flex-1 text-sm text-ink-2">You have changes that are not saved.</span>
            <Button variant="ghost" onClick={() => setDraft(pick(push))} disabled={busy}>
              Discard
            </Button>
            <Button variant="primary" onClick={submit} disabled={busy}>
              {busy ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
