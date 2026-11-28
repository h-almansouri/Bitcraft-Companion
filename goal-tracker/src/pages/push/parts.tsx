import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { isAlt, withAlts } from '../../lib/claim.ts';
import { ArrowRight, ChevronDown, Hammer, Hand, Hourglass, UserPlus } from 'lucide-react';
import { flowOf, type FlowBranch, type PushView, type Row } from '../../lib/derive.ts';
import { num } from '../../lib/format.ts';
import type { Ref } from '../../engine/types.ts';
import { BUY_ORDER, BUY_ORDER_NAME, type CraftJob } from '../../lib/shapes.ts';
import { MultiSelect, TierChip, cx } from '../../ui/kit.tsx';
import type { PushScope } from '../PushPage.tsx';

/** Colours for "turns into something else" branches; plain use gets the neutral one. */
const BRANCH_COLORS = ['var(--accent)', 'var(--branch-1)', 'var(--branch-2)', 'var(--branch-3)', 'var(--branch-4)', 'var(--branch-5)'];
const AS_IS_COLOR = 'var(--muted)';

/** Which groups are folded shut on one view of one push, remembered in this browser. */
const foldKey = (scope: PushScope, view: string) => `qm.fold.${scope.push.slug}.${view}`;
function readFolds(key: string): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

/** How long a group takes to slide shut or open, matching the sidebar. */
const FOLD_MS = 300;

/**
 * A group heading (a profession, or Buy) with its cards under it. Clicking the heading slides
 * the cards shut, or open again, the way the sidebar groups fold. Each push remembers its own
 * folds per view, so coming back finds it as it was left.
 */
export function FoldGroup({ scope, view, id, title, icon, extra, children }: { scope: PushScope; view: string; id: string; title: string; icon?: ReactNode; extra?: ReactNode; children: ReactNode }) {
  const key = foldKey(scope, view);
  const [shut, setShut] = useState(() => readFolds(key).includes(id));
  // Open cards may hold a "Who's on it" menu that hangs below the group, so the body only
  // clips while it is sliding or shut.
  const [moving, setMoving] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const toggle = () => {
    const next = !shut;
    setShut(next);
    setMoving(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMoving(false), FOLD_MS + 30);
    // Read again before writing, so folds made in other groups since this one opened are kept.
    const others = readFolds(key).filter((g) => g !== id);
    try {
      localStorage.setItem(key, JSON.stringify(next ? [...others, id] : others));
    } catch {
      // Private browsing can refuse storage. The fold still works for this visit.
    }
  };
  return (
    <section>
      <h2 className={cx('flex items-center gap-2 transition-[margin] duration-300', shut ? 'mb-0' : 'mb-2.5')}>
        <button
          type="button"
          aria-expanded={!shut}
          onClick={toggle}
          className="group flex min-w-0 cursor-pointer items-baseline gap-2 rounded text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {icon && <span className="self-center">{icon}</span>}
          <span className="text-[15px] font-semibold text-ink transition-colors group-hover:text-accent-ink">{title}</span>
          {extra}
          <ChevronDown
            size={14}
            aria-hidden="true"
            className={cx('shrink-0 self-center text-muted transition-transform duration-300 ease-out group-hover:text-accent-ink', shut && '-rotate-90')}
          />
        </button>
      </h2>
      <div
        inert={shut}
        className={cx(
          'grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
          shut ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100',
        )}
      >
        <div className={cx('min-h-0', (shut || moving) && 'overflow-hidden')}>{children}</div>
      </div>
    </section>
  );
}

export function colorsFor(branches: FlowBranch[]): string[] {
  let next = 0;
  return branches.map((b) => (b.final ? AS_IS_COLOR : BRANCH_COLORS[next++ % BRANCH_COLORS.length]));
}

export function ThingLabel({ row, className }: { row: Pick<Row, 'name' | 'tier'>; className?: string }) {
  return (
    <span className={cx('inline-flex min-w-0 items-center gap-1.5', className)}>
      <TierChip tier={row.tier} />
      <span className="truncate">{row.name}</span>
    </span>
  );
}

/** One sentence for a branch: "6,160 → 154 Spool of Thread" or "40 used as-is for Tailoring Station". */
export function branchText(branch: FlowBranch): { amount: string; rest: string } {
  if (!branch.into) return { amount: num(branch.qty), rest: 'is a goal of this push' };
  if (branch.final) return { amount: num(branch.qty), rest: `used as-is for ${branch.into.name}` };
  return { amount: num(branch.qty), rest: `${num(branch.makes)} ${branch.into.name}` };
}

/**
 * The split bar: how a material's required amount divides between being turned
 * into other things and being used as it is.
 */
export function SplitBar({ branches, className }: { branches: FlowBranch[]; className?: string }) {
  const total = branches.reduce((sum, b) => sum + b.qty, 0);
  if (total <= 0) return null;
  const colors = colorsFor(branches);
  return (
    <div className={cx('flex h-2.5 gap-0.5 overflow-hidden rounded-full', className)} aria-hidden="true">
      {branches.map((b, i) => (
        <div key={i} style={{ width: `${(b.qty / total) * 100}%`, minWidth: 3, background: colors[i] } as CSSProperties} />
      ))}
    </div>
  );
}

/** The legend under a split bar. Each line opens the thing it points to. */
export function BranchList({ view, id, limit, onOpen, compact }: { view: PushView; id: Ref; limit?: number; onOpen?: (id: Ref) => void; compact?: boolean }) {
  const branches = flowOf(view, id);
  if (!branches.length) return null;
  const colors = colorsFor(branches);
  const shown = limit ? branches.slice(0, limit) : branches;
  return (
    <ul className={cx('space-y-1', compact ? 'text-[13px]' : 'text-sm')}>
      {shown.map((b, i) => {
        const text = branchText(b);
        const body = (
          <>
            <span className="mt-[7px] h-2 w-2 shrink-0 rounded-full" style={{ background: colors[i] }} />
            <span className="min-w-0">
              <span className="num font-semibold text-ink">{text.amount}</span>
              {!b.final && b.into && <ArrowRight size={13} className="mx-1 inline -translate-y-px text-muted" />}
              <span className={b.final ? 'ml-1 text-ink-2' : 'text-ink'}>{text.rest}</span>
            </span>
          </>
        );
        return (
          <li key={i}>
            {b.into && onOpen ? (
              <button type="button" onClick={() => onOpen(b.into!.id)} className="flex w-full items-start gap-2 rounded text-left hover:underline">
                {body}
              </button>
            ) : (
              <span className="flex items-start gap-2">{body}</span>
            )}
          </li>
        );
      })}
      {limit && branches.length > limit && <li className="pl-4 text-muted">and {branches.length - limit} more</li>}
    </ul>
  );
}

/** "Loom @ Tortuga Prime": the station a craft is sitting at, and whose base it is in. */
export const stationOf = (job: Pick<CraftJob, 'station' | 'claim'>) => [job.station || 'a station', job.claim].filter(Boolean).join(' @ ');

/** What a craft at a station is doing, in a few words. */
export function jobState(job: CraftJob): string {
  if (job.done) return 'finished, waiting to be collected';
  if (job.passive) return 'passive craft, running on its own';
  return job.total ? `being crafted by hand, ${Math.floor((job.progress / job.total) * 100)}% done` : 'being crafted by hand';
}

/**
 * One line per kind of craft a material has at stations: passive ones running by
 * themselves, ones someone is working by hand, and finished ones waiting to be collected.
 */
export function StationLines({ jobs, className }: { jobs: CraftJob[]; className?: string }) {
  const groups = new Map<string, { qty: number; job: CraftJob }>();
  for (const job of jobs) {
    const key = `${job.done ? 'done' : job.passive ? 'passive' : 'hand'}|${stationOf(job)}`;
    const group = groups.get(key);
    if (group) group.qty += job.qty;
    else groups.set(key, { qty: job.qty, job });
  }
  if (!groups.size) return null;
  return (
    <ul className={cx('space-y-0.5 text-[11px] leading-snug', className)}>
      {[...groups.values()].map(({ qty, job }, i) => (
        <li key={i} className={cx('flex items-start gap-1', job.done ? 'text-accent-ink' : 'text-info')}>
          {job.done ? <Hand size={12} className="mt-px shrink-0" /> : job.passive ? <Hourglass size={12} className="mt-px shrink-0" /> : <Hammer size={12} className="mt-px shrink-0" />}
          <span>
            <span className="num font-semibold">{num(qty)}</span> {job.done ? `ready to collect at the ${stationOf(job)}` : job.passive ? `in the ${stationOf(job)}, passive` : `being crafted at the ${stationOf(job)}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Everyone a job can be handed to: claim members in name order, then the claim's own buy order.
 * Alts are left out (see ROSTER), unless one already has a job on this push, so nothing goes missing.
 * `label` is how pickers show them: a main with their alts, "Velcruza (+ Vel, Cynth)".
 */
export const assigneesOf = (scope: PushScope): { id: string; name: string; label: string }[] => {
  const assigned = new Set(Object.values(scope.push.assignments ?? {}).flat());
  return [
    ...[...(scope.claim?.members ?? [])]
      .filter((m) => !isAlt(m.name) || assigned.has(m.id))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((m) => ({ id: m.id, name: m.name, label: isAlt(m.name) ? m.name : withAlts(m.name) })),
    { id: BUY_ORDER, name: BUY_ORDER_NAME, label: BUY_ORDER_NAME },
  ];
};

/** Dropdown to hand a material to one or more claim members, or to a claim buy order. Saves as soon as it changes. */
export function AssignControl({ scope, id }: { scope: PushScope; id: Ref }) {
  const members = assigneesOf(scope);
  const saved = scope.push.assignments?.[id] ?? [];
  const [value, setValue] = useState(saved);
  // Follow the server's copy once it answers (or when someone else changes it).
  const key = saved.join(',');
  useEffect(() => setValue(saved), [key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!scope.claim) return <span className="text-xs text-muted">Member list loading…</span>;
  const onChange = (next: string[]) => {
    setValue(next);
    scope.assign(id, next).catch(() => setValue(saved));
  };
  return (
    <MultiSelect
      label="People"
      allLabel="Nobody yet"
      icon={<UserPlus size={13} />}
      value={value.filter((v) => members.some((m) => m.id === v))}
      onChange={onChange}
      options={members.map((m) => ({ id: m.id, label: m.label }))}
    />
  );
}
