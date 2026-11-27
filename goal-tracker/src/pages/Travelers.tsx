import { useMemo, useState } from 'react';
import { ChevronRight, Coins, PackageCheck, Sparkles } from 'lucide-react';
import type { Traveler, TravelerTask } from '../engine/gamedata.ts';
import type { Goal, Ref } from '../engine/types.ts';
import { api } from '../lib/api.ts';
import { CLAIM } from '../lib/claim.ts';
import { buildStock, type Holding, type StockView } from '../lib/derive.ts';
import { num, plural } from '../lib/format.ts';
import { useGame, type GameCtx } from '../lib/game.ts';
import { useLoad, useLocal } from '../lib/hooks.ts';
import { navigate } from '../lib/router.tsx';
import type { ClaimDetail } from '../lib/shapes.ts';
import { Button, Card, Chip, Empty, Notice, Pill, SectionLabel, Skeleton, TierChip, cx, inputBase } from '../ui/kit.tsx';
import { guarded } from '../ui/unlock.tsx';
import { StorageRead, useStock } from '../ui/storage.tsx';

interface Part {
  id: Ref;
  name: string;
  tier: number;
  /** Needed for one turn-in. */
  need: number;
  have: number;
  where: Holding[];
}

interface TaskRow {
  task: TravelerTask;
  tier: number;
  parts: Part[];
  /** Turn-ins the claim could hand in right now. */
  covers: number;
}

/** Hex Coins. A task that only asks for coins is a purchase from the traveler, not something to keep in stock. */
const COINS: Ref = 'i.1';

function rowsFor(ctx: GameCtx, traveler: Traveler, stock: StockView): TaskRow[] {
  const stockable = traveler.tasks.filter((task) => task.need.some(([id]) => id !== COINS));
  return stockable.map((task) => {
    const parts = task.need.map(([id, need]): Part => {
      const thing = ctx.book.thing(id);
      return { id, name: thing?.name ?? id, tier: thing?.tier ?? 0, need, have: stock.totals.get(id) ?? 0, where: stock.where.get(id) ?? [] };
    });
    return {
      task,
      tier: Math.max(0, ...parts.map((p) => p.tier)),
      parts,
      covers: parts.length ? Math.min(...parts.map((p) => Math.floor(p.have / p.need))) : 0,
    };
  });
}

/**
 * Traveler restock: every task a traveler can ask for, what it pays, how much of
 * what it takes the claim is holding and where, and what is short for the number
 * of turn-ins the claim wants to keep ready.
 */
export function Travelers() {
  const { ctx, error } = useGame();
  const claim = useLoad<ClaimDetail>('claim', () => api.claim());
  const [withMembers, setWithMembers] = useLocal<boolean>('qm.restock.members', false);
  const players = useMemo(() => (withMembers ? (claim.data?.members.map((m) => m.id).sort() ?? []) : []), [withMembers, claim.data]);
  // Read when the page opens, then every 15 minutes while it is on screen (see useStock).
  const stock = useStock(`stock:${players.join(',')}`, players);
  const view = useMemo(() => buildStock(stock.data, { excluded: [], players, countCrafts: false }), [stock.data, players]);

  const [who, setWho] = useLocal<string>('qm.restock.who', '');
  const [tierPicks, setTierPicks] = useLocal<Record<string, number[]>>('qm.restock.tiers', {});
  const [target, setTarget] = useLocal<number>('qm.restock.target', 1);
  const [shortOnly, setShortOnly] = useLocal<boolean>('qm.restock.short', false);

  const traveler = ctx?.game.travelers.find((t) => t.name === who) ?? ctx?.game.travelers[0];
  const all = useMemo(() => (ctx && traveler ? rowsFor(ctx, traveler, view) : []), [ctx, traveler, view]);

  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!ctx || !traveler) return <Skeleton className="h-72" />;

  const tiers = [...new Set(all.map((r) => r.tier))].sort((a, b) => a - b);
  const picked = (tierPicks[traveler.name] ?? []).filter((t) => tiers.includes(t));
  const setPicked = (next: number[]) => setTierPicks({ ...tierPicks, [traveler.name]: next });
  const inTier = all.filter((r) => !picked.length || picked.includes(r.tier));
  const shown = inTier.filter((r) => !shortOnly || r.covers < target);
  const waiting = stock.loading && !stock.data;
  const skill = ctx.game.skills[traveler.skill] ?? 'skill';
  const shortCount = inTier.filter((r) => r.covers < target).length;

  return (
    <div>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold">Traveler restock</h1>
          <p className="mt-1 max-w-2xl text-[13px] text-ink-2">
            Every turn-in a traveler can ask for, what it pays, and how much of it {CLAIM.name} has on hand and where. Say how many turn-ins you want ready and the page shows what to restock.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StorageRead stock={stock} />
        </div>
      </div>

      {stock.error && (
        <div className="mt-3">
          <Notice tone="warn">Could not read storage ({stock.error}) The tasks are listed, but the "have" numbers are missing.</Notice>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {ctx.game.travelers.map((t) => (
          <Chip key={t.name} active={t.name === traveler.name} onClick={() => setWho(t.name)}>
            {t.name}
          </Chip>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Chip active={!picked.length} onClick={() => setPicked([])}>
          All tiers
        </Chip>
        {tiers.map((t) => (
          <Chip key={t} active={picked.includes(t)} onClick={() => setPicked(picked.includes(t) ? picked.filter((x) => x !== t) : [...picked, t])} count={all.filter((r) => r.tier === t).length}>
            {t ? `Tier ${t}` : 'No tier'}
          </Chip>
        ))}
        <span className="mx-1 hidden h-5 w-px bg-line sm:block" />
        <Chip active={shortOnly} onClick={() => setShortOnly(!shortOnly)} count={waiting ? undefined : shortCount}>
          Only what is short
        </Chip>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-ink-2">
        <label className="flex items-center gap-2">
          Keep enough for
          <input
            type="number"
            min={1}
            max={99}
            value={target}
            onChange={(e) => setTarget(Math.max(1, Math.min(99, Math.round(Number(e.target.value) || 1))))}
            className={inputBase + ' num h-8 w-16 text-right'}
            aria-label="Turn-ins to keep ready"
          />
          {plural(target, 'turn-in')} of each
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={withMembers} onChange={(e) => setWithMembers(e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
          Also count members' own bags, banks and carts
        </label>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          <div className="mb-2 flex items-baseline gap-2">
            <h2 className="text-[15px] font-semibold">{traveler.name}</h2>
            <span className="text-xs text-muted">
              pays in coins and {skill} experience · {shown.length} of {all.length} tasks shown
            </span>
          </div>
          {shown.length === 0 ? (
            <Card>
              <Empty title={shortOnly ? 'Nothing is short here' : 'No tasks in these tiers'} icon={<PackageCheck size={28} />}>
                {shortOnly ? `${CLAIM.name} has enough for ${target} ${plural(target, 'turn-in')} of every task shown.` : 'Pick another tier.'}
              </Empty>
            </Card>
          ) : (
            <div className="space-y-5">
              {tiers
                .filter((t) => shown.some((r) => r.tier === t))
                .map((t) => (
                  <section key={t}>
                    <SectionLabel className="mb-1.5">{t ? `Tier ${t}` : 'No tier'}</SectionLabel>
                    <Card className="divide-y divide-line">
                      {shown
                        .filter((r) => r.tier === t)
                        .map((row) => (
                          <TaskLine key={row.task.id} row={row} target={target} waiting={waiting} skill={skill} />
                        ))}
                    </Card>
                  </section>
                ))}
            </div>
          )}
        </div>

        <RestockList traveler={traveler} rows={inTier} target={target} waiting={waiting} players={players} tiers={picked} />
      </div>
    </div>
  );
}

function TaskLine({ row, target, waiting, skill }: { row: TaskRow; target: number; waiting: boolean; skill: string }) {
  const { task, parts, covers } = row;
  const enough = covers >= target;
  return (
    <details className="group/task">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1.5 px-3.5 py-2.5 [&::-webkit-details-marker]:hidden">
        <ChevronRight size={14} className="shrink-0 text-muted transition-transform group-open/task:rotate-90" />
        <div className="min-w-0 flex-1 basis-56">
          {parts.map((part, i) => (
            <div key={i} className="flex items-center gap-1.5 text-[13px] font-medium">
              <span className="num">{num(part.need)}</span>
              <TierChip tier={part.tier} />
              <span className="truncate">{part.name}</span>
            </div>
          ))}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[11px] text-muted">
            <span className="inline-flex items-center gap-1">
              <Coins size={11} /> {num(task.coins)}
            </span>
            <span className="inline-flex items-center gap-1">
              <Sparkles size={11} /> {num(task.xp)} xp
            </span>
            <span>
              {skill} level {task.min}+
            </span>
          </div>
        </div>
        {waiting ? (
          <Skeleton className="h-5 w-28" />
        ) : (
          <div className="flex shrink-0 items-center gap-2.5">
            <span className="num text-right text-xs text-ink-2">
              {parts.length === 1 ? (
                <>
                  have <span className="font-semibold text-ink">{num(parts[0].have)}</span>
                </>
              ) : (
                `${parts.filter((p) => p.have >= p.need * target).length} of ${parts.length} in stock`
              )}
            </span>
            <Pill tone={enough ? 'good' : covers > 0 ? 'warn' : 'bad'} className="w-[104px] justify-center normal-case tracking-normal">
              {covers > 0 ? `${num(covers)} ${plural(covers, 'turn-in')}` : 'none ready'}
            </Pill>
          </div>
        )}
      </summary>
      <div className="space-y-3 border-t border-line bg-bg/40 px-3.5 py-3 pl-9 text-xs">
        {parts.map((part, i) => {
          const short = part.need * target - part.have;
          return (
            <div key={i}>
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium text-ink">{part.name}</span>
                <span className="num text-ink-2">
                  {num(part.have)} on hand · {num(part.need)} per turn-in
                </span>
                {!waiting && short > 0 && (
                  <span className="num font-medium text-warn">
                    {num(short)} short for {target} {plural(target, 'turn-in')}
                  </span>
                )}
              </div>
              {part.where.length === 0 ? (
                <div className="mt-1 text-muted">{waiting ? 'Reading storage…' : 'None in the storage being counted.'}</div>
              ) : (
                <ul className="mt-1 space-y-0.5">
                  {part.where.map((h, j) => (
                    <li key={h.loc.id + j} className="flex gap-2 text-ink-2">
                      <span className="num w-14 shrink-0 text-right font-medium text-ink">{num(h.qty)}</span>
                      <span className="min-w-0 truncate">
                        {h.loc.name}
                        <span className="text-muted"> · {[h.loc.kind === 'claim' ? 'claim storage' : h.loc.owner, h.loc.detail].filter(Boolean).join(' · ')}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
        <p className="text-muted">{task.d}</p>
      </div>
    </details>
  );
}

/** Everything short across the tasks in view, added up per item, with a button to track it as a push. */
function RestockList({ traveler, rows, target, waiting, players, tiers }: { traveler: Traveler; rows: TaskRow[]; target: number; waiting: boolean; players: string[]; tiers: number[] }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // Two tasks can ask for the same item; being ready for both means holding the sum.
  const wanted = new Map<Ref, { name: string; tier: number; want: number; have: number }>();
  for (const row of rows) {
    for (const part of row.parts) {
      const entry = wanted.get(part.id) ?? { name: part.name, tier: part.tier, want: 0, have: part.have };
      entry.want += part.need * target;
      wanted.set(part.id, entry);
    }
  }
  const short = [...wanted].filter(([, w]) => w.want > w.have).sort((a, b) => a[1].tier - b[1].tier || a[1].name.localeCompare(b[1].name));

  const track = async () => {
    setBusy(true);
    setProblem(null);
    const goals: Goal[] = short.map(([id, w]) => ({ id, qty: w.want }));
    const scope = tiers.length ? ` T${[...tiers].sort((a, b) => a - b).join(', T')}` : '';
    try {
      const saved = await guarded(CLAIM.slug, () =>
        api.savePush(CLAIM.slug, { name: `${traveler.name} restock${scope}`, kind: 'traveler', status: 'active', goals, players, ...(players.length ? { leftOut: [] } : {}), excluded: [], excludedNames: [], routes: {}, countCrafts: true }),
      );
      navigate(`/${CLAIM.slug}/${saved.push.slug}`);
    } catch (err) {
      setProblem((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <aside className="lg:sticky lg:top-[76px] lg:self-start">
      <Card className="p-3.5">
        <h2 className="text-[15px] font-semibold">To restock</h2>
        <p className="mt-0.5 text-xs text-ink-2">
          For {target} {plural(target, 'turn-in')} of each {traveler.name} task in view.
        </p>
        {waiting ? (
          <Skeleton className="mt-3 h-24" />
        ) : short.length === 0 ? (
          <p className="mt-3 flex items-center gap-2 text-[13px] text-good">
            <PackageCheck size={16} /> Fully stocked.
          </p>
        ) : (
          <>
            <ul className="mt-3 space-y-1.5 text-[13px]">
              {short.map(([id, w]) => (
                <li key={id} className="flex items-center gap-1.5">
                  <span className="num w-14 shrink-0 text-right font-semibold text-warn">{num(w.want - w.have)}</span>
                  <TierChip tier={w.tier} />
                  <span className="min-w-0 flex-1 truncate">{w.name}</span>
                </li>
              ))}
            </ul>
            <p className={cx('mt-3 text-xs text-muted')}>
              {short.length} {plural(short.length, 'item')} short. Tracking them as a push works out everything they take to make and what to gather.
            </p>
            {problem && (
              <div className="mt-2">
                <Notice tone="bad">{problem}</Notice>
              </div>
            )}
            <Button variant="primary" className="mt-3 w-full" disabled={busy} onClick={track}>
              {busy ? 'Saving…' : 'Track as a push'}
            </Button>
          </>
        )}
      </Card>
    </aside>
  );
}
