import { useMemo, useState, type ReactNode } from 'react';
import { Check, ChevronDown, Flag, Hourglass, PartyPopper } from 'lucide-react';
import { buildProducts, nextStep, professionRank, type MakeStep, type Product, type StepState } from '../../lib/derive.ts';
import { num } from '../../lib/format.ts';
import type { Ref } from '../../engine/types.ts';
import { Bar, Card, Empty, TierChip, cx } from '../../ui/kit.tsx';
import type { PushScope } from '../PushPage.tsx';
import { STAGES, UNASSIGNED, matchPeople, matchRole, matchText, matchTier, takenBy, useFilterBar, type StageId } from './filters.tsx';
import { AssignControl, StationLines, stationOf } from './parts.tsx';

/** Shares are worked out through recipe ratios, so they are rounded up to whole things for showing. */
export const whole = (n: number) => Math.ceil(n - 1e-6);

/** The stage filter talks about jobs; a step's state says the same thing in its own words. */
const STAGE_OF: Partial<Record<StepState, StageId>> = { collect: 'pickup', craft: 'craft', station: 'progress', waiting: 'blocked' };

/**
 * Everything the push has to end up with, one group per finished material, under
 * the profession that makes it and from the lowest tier up. Open a group to see
 * the steps that get there, in the order they are done: how much of each, what it
 * is made from, how far along it is, where it is sitting, and what can be done now.
 */
export function MakeTab({ scope }: { scope: PushScope }) {
  const { ctx, view, openItem } = scope;
  // Things that are only gathered and used as they are have no steps; they live on the Gather tab.
  const products = useMemo(() => buildProducts(ctx, view).filter((p) => !p.raw), [ctx, view]);
  const steps = useMemo(() => products.flatMap((p) => p.steps), [products]);
  const [flipped, setFlipped] = useState<Set<Ref>>(new Set());

  const having = (test: (s: MakeStep) => boolean) => products.filter((p) => p.steps.some(test)).length;
  const { f, query, bar } = useFilterBar(scope, {
    actions: STAGES.filter((a) => a.side === 'process')
      .map((a) => ({ id: a.id, label: a.label, count: having((s) => STAGE_OF[s.state] === a.id) }))
      .filter((a) => a.count > 0),
    tiers: [...new Set(steps.map((s) => s.tier))].map((tier) => ({ tier, count: having((s) => s.tier === tier && s.wanted) })),
    roles: [...new Set(steps.map((s) => s.profession))].map((id) => ({ id, count: having((s) => s.profession === id && s.wanted) })),
    people: (person) => having((s) => s.wanted && (person === UNASSIGNED ? !takenBy(scope, s.id).length : takenBy(scope, s.id).includes(person))),
    searchPlaceholder: 'Find something to make',
  });

  // The filters look for one step that fits all of them at once; its whole group is shown around it.
  const picky = f.actions.length + f.tiers.length + f.roles.length + f.people.length > 0 || query.trim() !== '';
  const fits = (s: MakeStep) =>
    (!f.actions.length || f.actions.includes(STAGE_OF[s.state] ?? '')) && matchTier(f, s.tier) && matchRole(f, s.profession) && matchPeople(scope, f, s.id) && matchText(query, s.name);
  const shown = products.filter((p) => !picky || p.steps.some(fits));
  const groups = [...new Set(shown.map((p) => p.profession))].sort((a, b) => professionRank(a) - professionRank(b)).map((p) => [p, shown.filter((x) => x.profession === p)] as const);

  // With filters on, groups start open so the matching steps are in view; otherwise they start folded.
  const isOpen = (id: Ref) => flipped.has(id) !== picky;
  const toggle = (id: Ref) =>
    setFlipped((old) => {
      const next = new Set(old);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  if (!products.length) {
    return (
      <Empty title="Nothing to process" icon={<PartyPopper size={30} />}>
        <p>This push only needs things that are gathered or bought.</p>
      </Empty>
    );
  }

  return (
    <div>
      {bar(shown.length, products.length, 'things to make')}
      {groups.length === 0 ? (
        <div className="mt-4">
          <Empty title="Nothing matches those filters">Loosen or clear the filters above.</Empty>
        </div>
      ) : (
        <div className="mt-4 space-y-7">
          {groups.map(([profession, list]) => (
            <section key={profession}>
              <div className="mb-2.5 flex items-baseline gap-2">
                <h2 className="text-[15px] font-semibold">{profession}</h2>
                <span className="num text-xs text-muted">{list.filter((p) => p.open).length} to make</span>
              </div>
              <div className="space-y-2">
                {list
                  .filter((p) => p.open)
                  .map((product) => (
                    <ProductCard key={product.id} scope={scope} product={product} open={isOpen(product.id)} onToggle={() => toggle(product.id)} onOpen={openItem} hit={picky ? fits : undefined} />
                  ))}
              </div>
              {list.some((p) => !p.open) && (
                <details className="group mt-2">
                  <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs text-ink-2 hover:text-ink [&::-webkit-details-marker]:hidden">
                    <ChevronDown size={13} className="-rotate-90 transition-transform group-open:rotate-0" />
                    {list.filter((p) => !p.open).length} done
                  </summary>
                  <div className="mt-2 space-y-2">
                    {list
                      .filter((p) => !p.open)
                      .map((product) => (
                        <ProductCard key={product.id} scope={scope} product={product} open={flipped.has(product.id)} onToggle={() => toggle(product.id)} onOpen={openItem} />
                      ))}
                  </div>
                </details>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function ProductCard({ scope, product, open, onToggle, onOpen, hit }: { scope: PushScope; product: Product; open: boolean; onToggle: () => void; onOpen: (id: Ref) => void; hit?: (step: MakeStep) => boolean }) {
  const last = product.steps[product.steps.length - 1];
  const next = nextStep(product);
  const goal = product.for.some((e) => e.id === null);
  const takers = product.for.filter((e) => e.id !== null);
  const done = product.steps.filter((s) => s.state === 'done').length;
  // A long group mostly shows what is left; the steps behind it stay a click away.
  const [all, setAll] = useState(false);
  const tuck = !all && product.open && done > 3;
  const listed = product.steps.map((step, i) => ({ step, index: i + 1 })).filter(({ step }) => !tuck || step.state !== 'done');

  return (
    <Card className={cx(!product.open && 'opacity-70')}>
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 px-3.5 py-2.5 text-left">
        <ChevronDown size={15} className={cx('shrink-0 text-muted transition-transform', !open && '-rotate-90')} />
        <span className="flex min-w-0 items-center gap-1.5">
          <TierChip tier={product.tier} />
          <span className="truncate text-sm font-semibold text-ink">
            <span className="num">{num(whole(product.qty))}</span> {product.name}
          </span>
        </span>
        <span className="min-w-0 truncate text-xs text-ink-2" title={product.for.map((e) => `${num(whole(e.qty))} for ${e.name}`).join(', ')}>
          {goal && (
            <span className="inline-flex items-center gap-1 text-accent-ink">
              <Flag size={11} /> Goal
            </span>
          )}
          {goal && takers.length > 0 && ' · '}
          {takers.length > 0 && `for ${takers[0].name}${takers.length > 1 ? ` +${takers.length - 1}` : ''}`}
        </span>
        <span className="ml-auto flex min-w-0 items-center gap-2.5">
          {product.open && next && next.id !== last.id && (
            <span className="hidden min-w-0 truncate text-xs text-ink-2 md:inline">
              {next.state === 'station' || next.state === 'waiting' ? '' : 'Next: '}
              {next.name}
            </span>
          )}
          <StatePill step={next ?? last} scope={scope} />
          <Bar value={last.total ? (last.total - last.toGo) / last.total : 1} pending={last.total ? last.pending / last.total : 0} className="hidden w-16 shrink-0 sm:flex" />
          <span className="num hidden w-[74px] shrink-0 text-right text-[11px] text-muted sm:inline">
            {done} of {product.steps.length} steps
          </span>
        </span>
      </button>

      {open && (
        <ol className="border-t border-line">
          {listed.map(({ step, index }) => (
            <StepRow key={step.id} scope={scope} step={step} index={index} building={product.assembly && step.id !== product.id} onOpen={onOpen} hit={hit?.(step)} />
          ))}
          {product.open && done > 3 && (
            <li className="px-3.5 py-2">
              <button type="button" onClick={() => setAll(!all)} className="text-xs text-accent-ink hover:underline">
                {all ? 'Hide the steps that are done' : `Show the ${done} steps already done`}
              </button>
            </li>
          )}
        </ol>
      )}
    </Card>
  );
}

function StepRow({ scope, step, index, building, onOpen, hit }: { scope: PushScope; step: MakeStep; index: number; building: boolean; onOpen: (id: Ref) => void; hit?: boolean }) {
  const { view } = scope;
  const made = step.total - step.toGo;
  const finished = step.state === 'done';
  const shared = whole(step.share) < step.total;
  const spots = (view.stock.where.get(step.id) ?? []).slice(0, 2).map((h) => `${num(h.qty)} in ${h.loc.kind === 'player' ? h.loc.owner + ': ' : ''}${h.loc.name}`);
  const where = !finished && step.recipe ? [step.recipe.station, step.recipe.skill].filter(Boolean).join(' · ') : '';

  return (
    <li className={cx('grid grid-cols-[22px_minmax(0,1fr)] items-start gap-x-2.5 gap-y-1.5 border-b border-line px-3.5 py-2.5 last:border-b-0 sm:grid-cols-[22px_minmax(0,1fr)_auto]', hit && 'bg-accent-soft')}>
      <span className="num pt-0.5 text-center text-xs text-muted">{finished ? <Check size={14} className="mx-auto mt-px text-good" /> : index}</span>
      <div className="min-w-0">
        <button type="button" onClick={() => onOpen(step.id)} className="group flex max-w-full items-start gap-1.5 text-left">
          <TierChip tier={step.tier} className="mt-px" />
          <span className={cx('min-w-0 text-[13px] leading-snug', finished ? 'text-ink-2' : 'text-ink')}>
            <span className="font-medium group-hover:underline">
              <span className="num">{num(whole(step.share))}</span> {step.name}
            </span>
            {step.from.length > 0 && (
              <span className="text-ink-2">
                {' '}
                from {step.from.map((x) => `${num(whole(x.qty))} ${x.name}`).join(' + ')}
              </span>
            )}
          </span>
        </button>
        <p className={cx('mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] leading-snug text-muted', step.tier > 0 && 'pl-[26px]')}>
          {!finished && step.recipe?.passive && (
            <span className="inline-flex items-center gap-0.5 font-medium text-info">
              <Hourglass size={11} /> Passive
            </span>
          )}
          <span>
            {[
              where,
              building ? `${num(Math.min(step.total, made))} of ${num(step.total)} ready` : `${num(made)} of ${num(step.total)} ${step.raw ? 'in hand' : 'made'}${shared ? ' across the push' : ''}`,
              !finished && spots.join(', '),
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </p>
        {step.state !== 'done' && <StationLines jobs={step.jobs} className={cx('mt-1', step.tier > 0 && 'pl-[26px]')} />}
      </div>
      <div className="col-start-2 flex flex-wrap items-center gap-2 sm:col-start-3 sm:justify-end">
        <StatePill step={step} scope={scope} />
        {step.wanted && <AssignControl scope={scope} id={step.id} />}
      </div>
    </li>
  );
}

/** What can be done about a step right now, in two or three words. */
function StatePill({ step, scope }: { step: MakeStep; scope: PushScope }) {
  const { ctx, view } = scope;
  const todo = step.todo;
  let label: ReactNode = 'Done';
  let look = 'text-good';
  let title: string | undefined;

  if (step.state === 'collect') {
    label = 'Collect';
    look = 'bg-accent-soft text-accent-ink';
    const job = step.jobs.find((j) => j.done);
    title = job ? `Finished at the ${stationOf(job)}` : undefined;
  } else if (step.state === 'craft') {
    const runs = todo?.step?.runs ?? 0;
    const partial = todo && (todo.doable ?? 0) < runs;
    label = partial ? `Craft now · ${num(todo.doable ?? 0)} of ${num(runs)}` : 'Craft now';
    look = 'bg-accent-soft text-accent-ink';
    title = partial ? 'Storage has enough for some of these crafts now.' : 'Everything it takes is in storage.';
  } else if (step.state === 'gather' || step.state === 'buy') {
    const left = todo?.qty ?? step.toGo;
    label = step.state === 'buy' ? (view.onOrder.has(step.id) ? 'Claim buy order' : `Buy ${num(left)}`) : `Gather ${num(left)}`;
    look = 'bg-warn-soft text-warn';
  } else if (step.state === 'station') {
    const passive = step.jobs.some((j) => j.passive && !j.done);
    label = (
      <>
        {passive && <Hourglass size={11} />}
        {passive ? 'Passive craft running' : 'Being crafted'}
      </>
    );
    look = 'bg-info-soft text-info';
  } else if (step.state === 'waiting') {
    const held = todo?.awaiting?.[0];
    const short = todo?.missing?.[0];
    const on = short ? ctx.book.name(short.id) : held ? ctx.book.name(held.id) : '';
    label = on ? `Waiting on ${on}` : 'Waiting';
    look = 'bg-surface-3 text-ink-2';
    title = short ? `Short ${num(short.short)} ${on}` : held ? `${num(held.qty)} ${on} still at a station` : undefined;
  }

  return (
    <span title={title} className={cx('inline-flex h-6 max-w-[230px] shrink-0 items-center gap-1 truncate rounded px-2 text-[11px] font-semibold', look)}>
      {step.state === 'done' && <Check size={12} />}
      <span className="truncate">{label}</span>
    </span>
  );
}

