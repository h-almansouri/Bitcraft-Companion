import { useMemo } from 'react';
import { ArrowRight, Bookmark, Check, Flag } from 'lucide-react';
import { buildChains, professionRank, type Chain, type ChainStage } from '../../lib/derive.ts';
import { num } from '../../lib/format.ts';
import type { Ref } from '../../engine/types.ts';
import { Bar, Card, Empty, SectionLabel, TierChip, cx } from '../../ui/kit.tsx';
import type { PushScope } from '../PushPage.tsx';
import { STAGES, UNASSIGNED, matchPeople, matchRole, matchText, matchTier, stageOf, takenBy, useFilterBar } from './filters.tsx';

const ratio = (n: number) => (Number.isInteger(n) ? num(n) : n.toFixed(n < 10 ? 2 : 1));

/**
 * The push as supply chains. Each line starts at something gathered and runs
 * left to right through everything it is turned into, so it is obvious what a
 * raw material is for and where a chain is stuck.
 */
export function ChainsTab({ scope }: { scope: PushScope }) {
  const { ctx, view, openItem } = scope;
  const chains = useMemo(() => buildChains(ctx, view), [ctx, view]);
  const stages = useMemo(() => chains.flatMap((c) => c.stages), [chains]);

  // The stage each material is at right now (collect, craft now, waiting...), for the stage filter.
  const kinds = useMemo(() => {
    const map = new Map<Ref, Set<string>>();
    for (const todo of view.todos) {
      const set = map.get(todo.row.id);
      if (set) set.add(stageOf(todo.kind));
      else map.set(todo.row.id, new Set([stageOf(todo.kind)]));
    }
    return map;
  }, [view.todos]);
  const hasKind = (id: Ref, kind: string) => kinds.get(id)?.has(kind) ?? false;

  const { f, query, bar } = useFilterBar(scope, {
    actions: STAGES.filter((a) => a.side === 'process' && stages.some((s) => hasKind(s.row.id, a.id))).map((a) => ({ id: a.id, label: a.label, count: stages.filter((s) => hasKind(s.row.id, a.id)).length })),
    tiers: [...new Set(stages.map((s) => s.row.tier))].map((tier) => ({ tier, count: stages.filter((s) => s.row.tier === tier && s.row.node.toGo > 0).length })),
    roles: [...new Set(stages.map((s) => s.row.profession))].map((id) => ({ id, count: stages.filter((s) => s.row.profession === id && s.row.node.toGo > 0).length })),
    people: (person) => stages.filter((s) => (person === UNASSIGNED ? !takenBy(scope, s.row.id).length : takenBy(scope, s.row.id).includes(person)) && s.row.node.toGo > 0).length,
    short: true,
  });

  // A chain crosses tiers and professions, so the filters look for one step that fits all of them at once
  // ("a Tier 5 thing that needs gathering"), and the whole chain is shown around it.
  const picky = f.actions.length + f.tiers.length + f.roles.length + f.people.length > 0 || query.trim() !== '';
  const fits = (s: ChainStage) =>
    (!f.actions.length || f.actions.some((a) => hasKind(s.row.id, a))) && matchTier(f, s.row.tier) && matchRole(f, s.row.profession) && matchPeople(scope, f, s.row.id) && matchText(query, s.row.name);

  const shown = chains.filter((c) => (!f.short || c.open) && (!picky || c.stages.some(fits)));
  const groups = [...new Set(shown.map((c) => c.profession))].sort((a, b) => professionRank(a) - professionRank(b)).map((p) => [p, shown.filter((c) => c.profession === p)] as const);

  return (
    <div>
      {bar(shown.length, chains.length, 'chains')}
      <p className="mt-2 text-xs text-ink-2">
        Left to right: what is gathered, then everything it becomes. <span className="font-medium text-info">Save</span> is how many to keep unprocessed.
        {picky && ' Steps that match your filters are outlined.'}
      </p>

      {groups.length === 0 ? (
        <Empty title="No chains match those filters">Loosen or clear the filters above.</Empty>
      ) : (
        <div className="mt-5 space-y-7">
          {groups.map(([profession, list]) => {
            const lines = list.filter((c) => c.stages.length > 1);
            const singles = list.filter((c) => c.stages.length === 1);
            return (
              <section key={profession}>
                <div className="mb-2.5 flex items-baseline gap-2">
                  <h2 className="text-[15px] font-semibold">{profession}</h2>
                  <SectionLabel>starts here</SectionLabel>
                  <span className="num text-xs text-muted">
                    {list.filter((c) => !c.open).length} of {list.length} covered
                  </span>
                </div>
                <div className="space-y-2">
                  {lines.map((chain) => (
                    <ChainLine key={chain.key} chain={chain} onOpen={openItem} hit={picky ? fits : undefined} />
                  ))}
                </div>
                {singles.length > 0 && (
                  <div className={cx('grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-2', lines.length > 0 && 'mt-2')}>
                    {singles.map((chain) => (
                      <StageBox key={chain.key} stage={chain.stages[0]} onOpen={openItem} wide />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ChainLine({ chain, onOpen, hit }: { chain: Chain; onOpen: (id: Ref) => void; hit?: (stage: ChainStage) => boolean }) {
  const goal = chain.ends.includes(null);
  const into = chain.ends.filter((r) => r !== null);
  return (
    <Card className="flex flex-wrap items-start gap-y-3 p-2.5">
      {chain.stages.map((stage, i) => {
        const prev = chain.stages[i - 1];
        // Only worth spelling out how many move on when the previous step doesn't send everything this way.
        const splits = prev && (prev.save.qty > 0 || prev.branches.length > 0);
        return (
          <div key={stage.row.id} className="flex items-start">
            {prev && (
              <div
                className="flex w-14 shrink-0 flex-col items-center pt-2 text-muted"
                title={[splits && `${num(prev.onward)} ${prev.row.name} go on to become ${stage.row.name}`, stage.ratio && `${ratio(stage.ratio.from)} ${prev.row.name} make ${ratio(stage.ratio.to)} ${stage.row.name}`]
                  .filter(Boolean)
                  .join('. ')}
              >
                <span className="num h-3.5 text-[11px] font-semibold leading-none text-ink">{splits ? num(prev.onward) : ''}</span>
                <ArrowRight size={15} />
                {stage.ratio && (
                  <span className="num mt-0.5 text-[10px] leading-none text-ink-2">
                    {ratio(stage.ratio.from)}:{ratio(stage.ratio.to)}
                  </span>
                )}
              </div>
            )}
            <StageBox stage={stage} onOpen={onOpen} outlined={hit?.(stage)} />
          </div>
        );
      })}
      <div className="flex items-start">
        <div className="flex w-10 shrink-0 justify-center pt-6 text-muted">
          <ArrowRight size={15} />
        </div>
        <div className="max-w-[190px] pt-4 text-xs text-ink-2">
          {goal && (
            <span className="inline-flex items-center gap-1 rounded bg-accent-soft px-1.5 py-0.5 font-medium text-accent-ink">
              <Flag size={11} /> Goal
            </span>
          )}
          {into.slice(0, 3).map((row) => (
            <button key={row!.id} type="button" onClick={() => onOpen(row!.id)} className="block max-w-full truncate text-left hover:text-ink hover:underline">
              {row!.name}
            </button>
          ))}
          {into.length > 3 && <span className="text-muted">and {into.length - 3} more</span>}
        </div>
      </div>
    </Card>
  );
}

function StageBox({ stage, onOpen, wide, outlined }: { stage: ChainStage; onOpen: (id: Ref) => void; wide?: boolean; outlined?: boolean }) {
  const { row, extras, save, branches } = stage;
  const { node } = row;
  const done = node.toGo <= 0;
  const savedFor = save.for.map((r) => (r ? r.name : 'the push goal'));
  return (
    <div className={wide ? 'min-w-0' : 'w-[168px] shrink-0'}>
      <button
        type="button"
        onClick={() => onOpen(row.id)}
        className={cx('block w-full rounded-lg border bg-surface-2 p-2.5 text-left transition-colors hover:bg-surface-3', outlined ? 'border-accent' : done ? 'border-line' : 'border-line-2')}
      >
        <div className="flex items-start gap-1.5">
          <TierChip tier={row.tier} className="mt-px" />
          <span className="line-clamp-2 min-h-[2.5em] text-xs font-medium leading-tight text-ink">{row.name}</span>
        </div>
        <Bar value={node.needed ? Math.min(1, node.have / node.needed) : 1} className="mt-2" />
        <div className="mt-1.5 flex items-baseline justify-between gap-2 text-[11px] leading-none">
          <span className="num text-ink-2">
            {num(node.have)} / {num(node.needed)}
          </span>
          {done ? (
            <span className="inline-flex items-center gap-0.5 text-good">
              <Check size={11} /> covered
            </span>
          ) : (
            <span className="num font-semibold text-warn">{num(node.toGo)} to go</span>
          )}
        </div>
      </button>
      {save.qty > 0 && (
        <button
          type="button"
          onClick={() => onOpen(row.id)}
          title={`Keep ${num(save.qty)} ${row.name} as they are. Needed unprocessed for ${savedFor.join(', ')}.`}
          className="mt-1.5 block w-full rounded-md border border-info/40 bg-info-soft px-2 py-1.5 text-left transition-colors hover:border-info"
        >
          <span className="flex items-center gap-1 text-xs font-semibold text-info">
            <Bookmark size={12} />
            Save {num(save.qty)}
          </span>
          <span className="mt-0.5 block text-[11px] leading-snug text-ink-2">
            Don't process these. For {savedFor.slice(0, 2).join(', ')}
            {savedFor.length > 2 && ` and ${savedFor.length - 2} more`}.
          </span>
        </button>
      )}
      {(branches.length > 0 || extras.length > 0) && (
        <div className="mt-1 space-y-0.5 px-1 text-[11px] leading-snug text-muted">
          {branches.slice(0, 3).map((branch) => (
            <button key={branch.row.id} type="button" onClick={() => onOpen(branch.row.id)} className="block max-w-full truncate text-left text-ink-2 hover:text-ink hover:underline">
              {num(branch.qty)} also go into {branch.row.name}
            </button>
          ))}
          {branches.length > 3 && <div>and {branches.length - 3} more uses</div>}
          {extras.slice(0, 3).map((extra) => (
            <button key={extra.id} type="button" onClick={() => onOpen(extra.id)} className={cx('block max-w-full truncate text-left hover:underline', extra.short ? 'text-warn' : 'text-muted hover:text-ink-2')}>
              + {ratio(extra.perRun)} {extra.name}
            </button>
          ))}
          {extras.length > 3 && <div>+ {extras.length - 3} more ingredients</div>}
        </div>
      )}
    </div>
  );
}
