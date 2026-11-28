import { useEffect, useMemo, type ReactNode } from 'react';
import { Bookmark, Check, CornerDownRight, Flag, Hourglass } from 'lucide-react';
import { buildChains, professionRank, type Chain, type ChainStage } from '../../lib/derive.ts';
import { num } from '../../lib/format.ts';
import { useQuery } from '../../lib/router.tsx';
import type { Ref } from '../../engine/types.ts';
import { Bar, Card, Empty, SectionLabel, TierChip, cx } from '../../ui/kit.tsx';
import type { PushScope } from '../PushPage.tsx';
import { STAGES, UNASSIGNED, matchPeople, matchRole, matchText, matchTier, stageOf, takenBy, useFilterBar } from './filters.tsx';
import { FoldGroup, StationLines } from './parts.tsx';

const ratio = (n: number) => (Number.isInteger(n) ? num(n) : n.toFixed(n < 10 ? 2 : 1));

/** Width of the "kept as it is" column, and so of each step in the staircase. */
const STEP = 128;
const GAP = 6;
/** Room for a step's name and progress, to the left of the staircase. */
const NAME = 212;
/** The furthest right the staircase may start its last row. */
const LONGEST = 400;

/**
 * The push as supply chains: the full picture. Each chain starts at something
 * gathered and reads downward, every row becoming the row under it. What is kept
 * as it is at a step stops there, on the left; the rest carries on to the right,
 * so the rows form a staircase and it is plain how the raw material divides up.
 */
export function ChainsTab({ scope }: { scope: PushScope }) {
  const { ctx, view, openItem } = scope;
  const chains = useMemo(() => buildChains(ctx, view), [ctx, view]);
  const stages = useMemo(() => chains.flatMap((c) => c.stages), [chains]);
  /** A material someone asked to see the whole chain of (from its panel). */
  const focus = useQuery().get('chain');

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
    actions: STAGES.filter((a) => a.side === 'process' && stages.some((s) => hasKind(s.id, a.id))).map((a) => ({ id: a.id, label: a.label, count: stages.filter((s) => hasKind(s.id, a.id)).length })),
    tiers: [...new Set(stages.map((s) => s.tier))].map((tier) => ({ tier, count: stages.filter((s) => s.tier === tier && s.toGo > 0).length })),
    roles: [...new Set(stages.map((s) => s.profession))].map((id) => ({ id, count: stages.filter((s) => s.profession === id && s.toGo > 0).length })),
    people: (person) => stages.filter((s) => (person === UNASSIGNED ? !takenBy(scope, s.id).length : takenBy(scope, s.id).includes(person)) && s.toGo > 0).length,
    short: true,
  });

  // A chain crosses tiers and professions, so the filters look for one step that fits all of them at once
  // ("a Tier 5 thing that needs gathering"), and the whole chain is shown around it.
  const picky = f.actions.length + f.tiers.length + f.roles.length + f.people.length > 0 || query.trim() !== '';
  const fits = (s: ChainStage) => (!f.actions.length || f.actions.some((a) => hasKind(s.id, a))) && matchTier(f, s.tier) && matchRole(f, s.profession) && matchPeople(scope, f, s.id) && matchText(query, s.name);
  const wanted = (c: Chain) => !!focus && c.stages.some((s) => s.id === focus);

  const shown = chains.filter((c) => wanted(c) || ((!f.short || c.open) && (!picky || c.stages.some(fits))));
  // Professions with chains still to cover come first; fully covered ones drop to the bottom. Each part keeps the usual order.
  const covered = (p: string) => !shown.some((c) => c.profession === p && c.open);
  const groups = [...new Set(shown.map((c) => c.profession))]
    .sort((a, b) => Number(covered(a)) - Number(covered(b)) || professionRank(a) - professionRank(b))
    .map((p) => [p, shown.filter((c) => c.profession === p)] as const);

  // Arriving from "see the full picture" on a material: bring its chain into view.
  useEffect(() => {
    if (focus) document.getElementById('chain-' + focus)?.scrollIntoView({ block: 'center' });
  }, [focus]);

  return (
    <div>
      {bar(shown.length, chains.length, 'chains')}
      <p className="mt-2 text-xs text-ink-2">
        Read down: each row becomes the row under it. <span className="font-medium text-info">Keep</span> stays as it is. A striped bar is at a station, not in hand yet.
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
              <FoldGroup
                key={profession}
                scope={scope}
                view="chains"
                id={profession}
                title={profession}
                extra={
                  <>
                    <SectionLabel>starts here</SectionLabel>
                    <span className="num text-xs text-muted">
                      {list.filter((c) => !c.open).length} of {list.length} covered
                    </span>
                  </>
                }
              >
                <div className="space-y-2.5">
                  {lines.map((chain) => (
                    <ChainPicture key={chain.key} chain={chain} onOpen={openItem} hit={picky ? fits : undefined} focus={focus} />
                  ))}
                </div>
                {singles.length > 0 && (
                  <div className={cx('grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-2', lines.length > 0 && 'mt-2.5')}>
                    {singles.map((chain) => (
                      <div key={chain.key} id={'chain-' + chain.stages[0].id} className={cx('rounded-lg border border-line bg-surface px-3 py-2.5', chain.stages[0].id === focus && 'ring-1 ring-accent')}>
                        <StageInfo stage={chain.stages[0]} onOpen={openItem} />
                        <p className="mt-1.5 truncate text-[11px] text-muted" title={chain.ends.map((e) => e.name).join(', ')}>
                          Used as it is for {chain.ends[0]?.name ?? 'the push'}
                          {chain.ends.length > 1 && ` and ${chain.ends.length - 1} more`}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </FoldGroup>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** One chain, top to bottom, as a staircase. */
function ChainPicture({ chain, onOpen, hit, focus }: { chain: Chain; onOpen: (id: Ref) => void; hit?: (stage: ChainStage) => boolean; focus: string | null }) {
  // Each step that keeps something back pushes everything after it one step to the right.
  // A very long chain takes smaller steps, so it still fits across the page.
  const holds = chain.stages.filter((stage) => stage.save.qty > 0 || stage.branches.length > 0).length;
  const stride = Math.max(44, Math.min(STEP + GAP, Math.floor(LONGEST / Math.max(1, holds))));
  let indent = 0;
  const indents = chain.stages.map((stage) => {
    const mine = indent;
    if (stage.save.qty > 0 || stage.branches.length > 0) indent += stride;
    return mine;
  });
  const goal = chain.ends.some((e) => e.id === null);
  const into = chain.ends.filter((e) => e.id !== null);

  return (
    <Card className={cx('overflow-x-auto', chain.stages.some((s) => s.id === focus) && 'ring-1 ring-accent')}>
      <div style={{ minWidth: NAME + indent + 240 }}>
        {chain.stages.map((stage, i) => {
          const next = chain.stages[i + 1];
          return (
            <div key={stage.id} id={'chain-' + stage.id} className={cx('flex items-stretch gap-3 px-3 py-2.5', i > 0 && 'border-t border-line', stage.id === focus && 'bg-accent-soft')}>
              <div className={cx('shrink-0 rounded-md', hit?.(stage) && 'outline outline-1 outline-offset-4 outline-accent')} style={{ width: NAME }}>
                <StageInfo stage={stage} onOpen={onOpen} />
              </div>

              <div className="flex min-w-0 flex-1 items-start" style={{ paddingLeft: indents[i], gap: GAP }}>
                {(stage.save.qty > 0 || stage.branches.length > 0) && (
                  <div className="flex shrink-0 flex-col" style={{ width: STEP, gap: GAP }}>
                    {stage.save.qty > 0 && (
                      <Segment tone="keep" onClick={() => onOpen(stage.id)} title={`Keep ${num(stage.save.qty)} ${stage.name} as they are. Needed unprocessed for ${stage.save.for.join(', ')}.`}>
                        <span className="flex items-center gap-1 font-semibold text-info">
                          <Bookmark size={12} className="shrink-0" />
                          Keep {num(stage.save.qty)}
                        </span>
                        <span className="block truncate text-[11px] text-ink-2">
                          for {stage.save.for[0]}
                          {stage.save.for.length > 1 && ` +${stage.save.for.length - 1}`}
                        </span>
                      </Segment>
                    )}
                    {stage.branches.slice(0, 2).map((branch) => (
                      <Segment key={branch.id} onClick={() => onOpen(branch.id)} title={`${num(branch.qty)} ${stage.name} go into ${branch.name}, which is its own chain.`}>
                        <span className="num font-semibold text-ink">{num(branch.qty)}</span>
                        <span className="block truncate text-[11px] text-ink-2">into {branch.name}</span>
                      </Segment>
                    ))}
                    {stage.branches.length > 2 && <div className="px-1 text-[11px] text-muted">and {stage.branches.length - 2} more uses</div>}
                  </div>
                )}

                {next ? (
                  <Segment grow onClick={() => onOpen(next.id)} title={next.ratio ? `${ratio(next.ratio.from)} ${stage.name} make ${ratio(next.ratio.to)} ${next.name}` : undefined}>
                    <span className="flex items-center gap-1.5">
                      <CornerDownRight size={13} className="shrink-0 text-muted" />
                      <span className="min-w-0 truncate">
                        <span className="num font-semibold text-ink">{num(stage.onward)}</span> <span className="text-ink-2">become</span> <span className="font-medium text-ink">{next.name}</span>
                      </span>
                      {next.ratio && (
                        <span className="num ml-auto shrink-0 pl-2 text-[11px] text-muted">
                          {ratio(next.ratio.from)} : {ratio(next.ratio.to)}
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 flex items-center gap-1 truncate pl-[19px] text-[11px] text-ink-2">
                      {next.recipe?.passive && (
                        <span className="inline-flex shrink-0 items-center gap-0.5 font-medium text-info">
                          <Hourglass size={11} /> Passive
                        </span>
                      )}
                      <span className="truncate">{[next.recipe?.station, next.recipe?.skill].filter(Boolean).join(' · ')}</span>
                    </span>
                  </Segment>
                ) : (
                  <Segment grow tone="end" title={chain.ends.map((e) => `${num(e.qty)} for ${e.name}`).join(', ')}>
                    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                      {goal && (
                        <span className="inline-flex items-center gap-1 font-medium text-accent-ink">
                          <Flag size={12} /> Goal of the push
                        </span>
                      )}
                      {into.length > 0 && (
                        <span className="min-w-0 truncate text-ink-2">
                          {goal ? 'and used' : 'Used'} for{' '}
                          {into.slice(0, 3).map((end, n) => (
                            <span key={end.id}>
                              {n > 0 && ', '}
                              <button type="button" onClick={() => onOpen(end.id!)} className="font-medium text-ink hover:underline">
                                {end.name}
                              </button>
                            </span>
                          ))}
                          {into.length > 3 && ` and ${into.length - 3} more`}
                        </span>
                      )}
                    </span>
                  </Segment>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/** One block of a row: what is kept, what goes elsewhere, or what carries on to the next row. */
function Segment({ children, tone, grow, onClick, title }: { children: ReactNode; tone?: 'keep' | 'end'; grow?: boolean; onClick?: () => void; title?: string }) {
  const look = cx(
    'block rounded-md border px-2.5 py-1.5 text-left text-xs leading-snug',
    grow ? 'min-w-0 flex-1' : 'w-full',
    tone === 'keep' ? 'border-info/40 bg-info-soft' : tone === 'end' ? 'border-accent/40 bg-accent-soft' : 'border-line-2 bg-surface-2',
    onClick && (tone === 'keep' ? 'transition-colors hover:border-info' : 'transition-colors hover:bg-surface-3'),
  );
  return onClick ? (
    <button type="button" onClick={onClick} title={title} className={look}>
      {children}
    </button>
  ) : (
    <div title={title} className={look}>
      {children}
    </div>
  );
}

/** A step's name and how far along it is, counted against everything the push takes of it from scratch. */
function StageInfo({ stage, onOpen }: { stage: ChainStage; onOpen: (id: Ref) => void }) {
  const done = stage.total - stage.toGo;
  const share = stage.total ? done / stage.total : 1;
  const short = stage.extras.filter((e) => e.short);
  return (
    <div className="min-w-0">
      <button type="button" onClick={() => onOpen(stage.id)} className="block w-full text-left">
        <span className="flex items-center gap-1.5">
          <TierChip tier={stage.tier} />
          <span className="truncate text-[13px] font-medium text-ink hover:underline">{stage.name}</span>
        </span>
        <Bar value={share} pending={stage.total ? stage.pending / stage.total : 0} className="mt-1.5" />
        <span className="mt-1 flex items-baseline justify-between gap-2 text-[11px] leading-none">
          <span className="num text-ink-2">
            {num(done)} of {num(stage.total)}
          </span>
          {stage.toGo <= 0 && stage.pending > 0 ? (
            <span className="inline-flex items-center gap-0.5 text-info">
              <Hourglass size={11} /> at a station
            </span>
          ) : stage.toGo <= 0 ? (
            <span className="inline-flex items-center gap-0.5 text-good">
              <Check size={11} /> covered
            </span>
          ) : (
            <span className="num font-semibold text-warn">{num(stage.toGo)} to go</span>
          )}
        </span>
      </button>
      <StationLines jobs={stage.jobs} className="mt-1.5" />
      {stage.extras.length > 0 && (
        <p className="mt-1 truncate text-[11px] text-muted" title={stage.extras.map((e) => `${ratio(e.perRun)} ${e.name}`).join(', ')}>
          also takes{' '}
          {stage.extras.slice(0, 2).map((extra, i) => (
            <span key={extra.id}>
              {i > 0 && ', '}
              <button type="button" onClick={() => onOpen(extra.id)} className={cx('hover:underline', extra.short ? 'text-warn' : 'hover:text-ink-2')}>
                {extra.name}
              </button>
            </span>
          ))}
          {stage.extras.length > 2 && ` +${stage.extras.length - 2}`}
          {short.length > 0 && stage.extras.slice(0, 2).every((e) => !e.short) && <span className="text-warn"> (some short)</span>}
        </p>
      )}
    </div>
  );
}
