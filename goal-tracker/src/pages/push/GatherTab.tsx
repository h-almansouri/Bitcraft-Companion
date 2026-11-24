import { useMemo } from 'react';
import { ChevronDown, PartyPopper } from 'lucide-react';
import { buildProducts, professionRank, type MakeStep, type Product } from '../../lib/derive.ts';
import { num } from '../../lib/format.ts';
import type { Ref } from '../../engine/types.ts';
import { Bar, Card, Empty, TierChip, cx } from '../../ui/kit.tsx';
import type { PushScope } from '../PushPage.tsx';
import { UNASSIGNED, matchPeople, matchRole, matchText, matchTier, takenBy, useFilterBar } from './filters.tsx';
import { whole } from './MakeTab.tsx';
import { AssignControl } from './parts.tsx';

/** A raw material, and every finished thing some of it ends up in. */
interface Raw {
  step: MakeStep;
  ends: { product: Product; share: number }[];
}

/**
 * Everything that has to be brought in from outside storage, one card per raw
 * material: how much is in hand, how much is left to get, where to get it, and
 * what it ends up as. Grouped by the profession that gathers it, lowest tier first.
 */
export function GatherTab({ scope }: { scope: PushScope }) {
  const { ctx, view } = scope;
  const raws = useMemo(() => {
    const found = new Map<Ref, Raw>();
    for (const product of buildProducts(ctx, view)) {
      for (const step of product.steps) {
        if (!step.raw || (product.assembly && step.id !== product.id)) continue;
        const raw = found.get(step.id) ?? { step, ends: [] };
        raw.ends.push({ product, share: step.share });
        found.set(step.id, raw);
      }
    }
    for (const raw of found.values()) raw.ends.sort((a, b) => b.share - a.share);
    return [...found.values()].sort((a, b) => professionRank(a.step.profession) - professionRank(b.step.profession) || a.step.tier - b.step.tier || a.step.name.localeCompare(b.step.name));
  }, [ctx, view]);

  const open = raws.filter((r) => r.step.toGo > 0);
  const count = (test: (r: Raw) => boolean) => open.filter(test).length;
  const { f, query, bar } = useFilterBar(scope, {
    tiers: [...new Set(raws.map((r) => r.step.tier))].map((tier) => ({ tier, count: count((r) => r.step.tier === tier) })),
    roles: [...new Set(raws.map((r) => r.step.profession))].map((id) => ({ id, count: count((r) => r.step.profession === id) })),
    people: (person) => count((r) => (person === UNASSIGNED ? !takenBy(scope, r.step.id).length : takenBy(scope, r.step.id).includes(person))),
    searchPlaceholder: 'Find a material',
  });
  const fits = (r: Raw) => matchTier(f, r.step.tier) && matchRole(f, r.step.profession) && matchPeople(scope, f, r.step.id) && matchText(query, r.step.name, ...r.ends.map((e) => e.product.name));
  const todo = open.filter(fits);
  const inHand = raws.filter((r) => r.step.toGo <= 0 && fits(r));
  const groups = [...new Set(todo.map((r) => r.step.profession))].map((p) => [p, todo.filter((r) => r.step.profession === p)] as const);

  if (!raws.length) {
    return (
      <Empty title="Nothing to gather or buy" icon={<PartyPopper size={30} />}>
        <p>This push needs no raw materials.</p>
      </Empty>
    );
  }

  return (
    <div>
      {bar(todo.length, open.length, 'materials to bring in')}

      {open.length === 0 && (
        <div className="mt-4">
          <Empty title="Nothing left to gather or buy" icon={<PartyPopper size={30} />}>
            <p>Every raw material this push needs is already in hand.</p>
          </Empty>
        </div>
      )}
      {open.length > 0 && todo.length === 0 && (
        <div className="mt-4">
          <Empty title="Nothing matches those filters">Loosen or clear the filters above.</Empty>
        </div>
      )}

      <div className="mt-4 space-y-7">
        {groups.map(([profession, list]) => (
          <section key={profession}>
            <div className="mb-2.5 flex items-baseline gap-2">
              <h2 className="text-[15px] font-semibold">{profession}</h2>
              <span className="num text-xs text-muted">{list.length} to bring in</span>
            </div>
            <div className="grid grid-cols-1 gap-2.5 xl:grid-cols-2">
              {list.map((raw) => (
                <RawCard key={raw.step.id} scope={scope} raw={raw} />
              ))}
            </div>
          </section>
        ))}

        {inHand.length > 0 && (
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
              <span className="text-[15px] font-semibold text-ink">Already in hand</span>
              <span className="num rounded bg-surface-3 px-1.5 text-[11px] text-ink-2">{inHand.length}</span>
              <ChevronDown size={15} className="-rotate-90 text-muted transition-transform group-open:rotate-0" />
            </summary>
            <div className="mt-2.5 grid grid-cols-1 gap-2.5 xl:grid-cols-2">
              {inHand.map((raw) => (
                <RawCard key={raw.step.id} scope={scope} raw={raw} />
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

function RawCard({ scope, raw }: { scope: PushScope; raw: Raw }) {
  const { ctx, view, openItem } = scope;
  const { step, ends } = raw;
  const got = step.total - step.toGo;
  const done = step.toGo <= 0;
  const buying = step.state === 'buy' || step.profession === 'Trade';
  const sources = buying ? [] : [...new Set(ctx.router.gatherSources(step.id).filter((r) => !r.loot).map((r) => r.source))].slice(0, 3);
  const spots = (view.stock.where.get(step.id) ?? []).slice(0, 2).map((h) => `${num(h.qty)} in ${h.loc.kind === 'player' ? h.loc.owner + ': ' : ''}${h.loc.name}`);
  const how = buying ? (view.onOrder.has(step.id) ? 'On a claim buy order' : `Sold by ${ctx.game.sold[step.id] ?? 'a traveler'}`) : sources.length ? `From ${sources.join(', ')}` : 'No farmable source in the game data';

  return (
    <Card className={cx('flex min-w-0 flex-col px-3.5 py-3', done && 'opacity-80')}>
      <button type="button" onClick={() => openItem(step.id)} className="flex w-full items-start gap-3 text-left">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-sm font-semibold text-ink">
            <TierChip tier={step.tier} />
            <span className="truncate hover:underline">{step.name}</span>
          </div>
          <div className="mt-0.5 line-clamp-2 text-xs text-ink-2">{how}</div>
        </div>
        <div className="shrink-0 text-right">
          <div className={cx('num text-xl font-semibold leading-tight', done ? 'text-good' : 'text-ink')}>{num(done ? got : step.toGo)}</div>
          <div className="text-[11px] text-muted">{done ? 'in hand' : buying ? 'to buy' : 'to gather'}</div>
        </div>
      </button>

      <Bar value={step.total ? got / step.total : 1} className="mt-2.5" />
      <div className="num mt-1 text-[11px] text-muted">
        {[`${num(got)} of ${num(step.total)} in hand`, ...spots].join(' · ')}
      </div>

      <div className="mt-2.5 border-t border-line pt-2.5">
        <div className="mb-1.5 text-[11px] text-muted">Ends up as</div>
        <div className="flex flex-wrap gap-1.5">
          {ends.slice(0, 6).map(({ product, share }) => (
            <button
              key={product.id}
              type="button"
              onClick={() => openItem(product.id)}
              title={`${num(whole(share))} ${step.name} go into ${num(whole(product.qty))} ${product.name}`}
              className="max-w-full truncate rounded border border-line-2 bg-surface-2 px-2 py-1 text-xs text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
            >
              {product.id === step.id ? (
                <>
                  <span className="num font-semibold text-ink">{num(whole(product.qty))}</span> as they are, for {product.for[0]?.name}
                  {product.for.length > 1 && ` +${product.for.length - 1}`}
                </>
              ) : (
                <>
                  <span className="num font-semibold text-ink">{num(whole(product.qty))}</span> {product.name}
                </>
              )}
            </button>
          ))}
          {ends.length > 6 && <span className="self-center text-xs text-muted">and {ends.length - 6} more</span>}
        </div>
      </div>

      {!done && (
        <div className="mt-auto flex items-center gap-2 pt-2.5">
          <span className="text-[11px] text-muted">Who's on it</span>
          <AssignControl scope={scope} id={step.id} />
        </div>
      )}
    </Card>
  );
}
