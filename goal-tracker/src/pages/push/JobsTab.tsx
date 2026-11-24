import type { ReactNode } from 'react';
import { ChevronDown, Hand, Hourglass, PackageOpen, PartyPopper, Pickaxe, ShoppingBag, Timer, Wrench } from 'lucide-react';
import { flowOf, type Awaiting, type Todo } from '../../lib/derive.ts';
import { num, plural } from '../../lib/format.ts';
import { Card, Empty, TierChip, cx } from '../../ui/kit.tsx';
import type { PushScope } from '../PushPage.tsx';
import { UNASSIGNED, matchPeople, matchRole, matchText, matchTier, stageOf, takenBy, useFilterBar, type StageId } from './filters.tsx';
import { AssignControl, BranchList, SplitBar, stationOf } from './parts.tsx';

interface Section {
  stage: StageId;
  title: string;
  blurb: string;
  icon: ReactNode;
  /** Long and not actionable, so it starts folded away. */
  folded?: boolean;
}

/**
 * Bringing materials in and working them up are different jobs, usually for
 * different people, so each side of the push has its own list of jobs.
 */
const SECTIONS: Record<'gather' | 'process', Section[]> = {
  gather: [
    { stage: 'gather', title: 'Gather', blurb: 'Nothing in storage can make these', icon: <Pickaxe size={15} /> },
    { stage: 'buy', title: 'Buy', blurb: 'Sold by travelers, or on a claim buy order', icon: <ShoppingBag size={15} /> },
  ],
  process: [
    { stage: 'pickup', title: 'Collect', blurb: 'Finished and waiting at a station', icon: <Hand size={15} /> },
    { stage: 'craft', title: 'Craft now', blurb: 'Everything it takes is in storage', icon: <Wrench size={15} /> },
    { stage: 'progress', title: 'Being crafted', blurb: 'Loaded at a station, already counted as made', icon: <Timer size={15} /> },
    { stage: 'blocked', title: 'Waiting on materials', blurb: 'Can be crafted once what it needs is in hand', icon: <PackageOpen size={15} />, folded: true },
  ],
};

const NOTHING = {
  gather: { title: 'Nothing left to gather or buy', body: 'Every raw material this push needs is already in hand.' },
  process: { title: 'Nothing to process right now', body: 'Nothing is waiting at a station or ready to craft.' },
};

/** The jobs on one side of a push (gathering or processing), grouped by the stage each is at. */
export function JobList({ scope, mode }: { scope: PushScope; mode: 'gather' | 'process' }) {
  const { view, openItem } = scope;
  const sections = SECTIONS[mode];
  const all = view.todos.filter((t) => sections.some((s) => s.stage === stageOf(t.kind)));
  const count = (test: (t: Todo) => boolean) => all.filter(test).length;

  const { f, query, bar } = useFilterBar(scope, {
    // Gathering is two short lists, so narrowing it by stage would only add a button.
    actions: mode === 'process' ? sections.map((s) => ({ id: s.stage, label: s.title, count: count((t) => stageOf(t.kind) === s.stage) })).filter((s) => s.count > 0) : undefined,
    tiers: [...new Set(all.map((t) => t.row.tier))].map((tier) => ({ tier, count: count((t) => t.row.tier === tier) })),
    roles: [...new Set(all.map((t) => t.row.profession))].map((id) => ({ id, count: count((t) => t.row.profession === id) })),
    // A job counts as someone's when the material it is for is assigned to them.
    people: (person) => count((t) => (person === UNASSIGNED ? !takenBy(scope, t.row.id).length : takenBy(scope, t.row.id).includes(person))),
    searchPlaceholder: 'Find a job',
  });
  const todos = all.filter(
    (t) => (!f.actions.length || f.actions.includes(stageOf(t.kind))) && matchTier(f, t.row.tier) && matchRole(f, t.row.profession) && matchPeople(scope, f, t.row.id) && matchText(query, t.row.name),
  );

  if (!all.length) {
    return (
      <Empty title={NOTHING[mode].title} icon={<PartyPopper size={30} />}>
        <p>{NOTHING[mode].body}</p>
      </Empty>
    );
  }

  return (
    <div>
      {bar(todos.length, all.length, 'jobs')}

      <div className="mt-4 space-y-7">
        {sections.map((section) => {
          const list = todos.filter((t) => stageOf(t.kind) === section.stage);
          if (!list.length) return null;
          // Closest to ready first: jobs that have everything, and are only waiting for a station to finish.
          if (section.stage === 'blocked') list.sort((a, b) => Number(!!a.missing?.length) - Number(!!b.missing?.length));
          const body = (
            <div className="mt-2.5 grid grid-cols-1 gap-2.5 xl:grid-cols-2">
              {list.map((todo) => (
                <TodoCard key={todo.key} todo={todo} scope={scope} onOpen={() => openItem(todo.row.id)} />
              ))}
            </div>
          );
          const heading = (
            <>
              <span className="text-accent-ink">{section.icon}</span>
              <span className="text-[15px] font-semibold text-ink">{section.title}</span>
              <span className="num rounded bg-surface-3 px-1.5 text-[11px] text-ink-2">{list.length}</span>
              <span className="hidden text-xs text-muted sm:inline">{section.blurb}</span>
            </>
          );
          return section.folded ? (
            <details key={section.stage} className="group" open={f.actions.includes(section.stage)}>
              <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
                {heading}
                <ChevronDown size={15} className="-rotate-90 text-muted transition-transform group-open:rotate-0" />
              </summary>
              {body}
            </details>
          ) : (
            <section key={section.stage}>
              <h2 className="flex items-center gap-2">{heading}</h2>
              {body}
            </section>
          );
        })}
        {!todos.length && <Empty title="No jobs match those filters">Loosen or clear the filters above.</Empty>}
      </div>
    </div>
  );
}

function TodoCard({ todo, scope, onOpen }: { todo: Todo; scope: PushScope; onOpen: () => void }) {
  const { view, ctx, openItem } = scope;
  const { row, step } = todo;
  const node = row.node;
  const recipe = step?.recipe;
  const branches = flowOf(view, row.id);
  const sources = todo.kind === 'gather' ? ctx.router.gatherSources(row.id).filter((r) => !r.loot) : [];

  let verb = 'Craft';
  let detail: ReactNode = null;
  /** Set for anything to do with a passive craft, so it can be told apart at a glance. */
  let passive = false;
  const at = todo.job ? stationOf(todo.job) : '';
  // An ingredient that exists but is still at a station: say where, and whether it needs waiting for or collecting.
  const held = (a: Awaiting) => {
    const job = a.jobs.find((j) => !j.done) ?? a.jobs[0];
    const where = job ? stationOf(job) : 'a station';
    return a.jobs.every((j) => j.done) ? `Collect ${num(a.qty)} ${ctx.book.name(a.id)} from the ${where} first` : `Waiting on ${num(a.qty)} ${ctx.book.name(a.id)} in the ${where}${job?.passive ? ' (passive)' : ''}`;
  };
  if (todo.kind === 'pickup') {
    verb = 'Collect';
    detail = `${at} · made by ${todo.job!.owner}`;
  } else if (todo.kind === 'progress') {
    const job = todo.job!;
    passive = job.passive;
    verb = job.passive ? 'Passive craft · running on its own' : 'Being crafted by hand';
    const from = [...view.loaded].flatMap(([id, list]) => list.filter((l) => l.job === job).map((l) => `${num(l.qty)} ${ctx.book.name(id)}`));
    const state = job.passive ? '' : job.total ? `${Math.floor((job.progress / job.total) * 100)}% done` : 'started';
    detail = [at, job.owner, state, from.length ? `from ${from.join(' + ')}` : ''].filter(Boolean).join(' · ');
  } else if (todo.kind === 'stock' && recipe) {
    // A one-step shortcut from something already in storage: open a package, or process a raw material that is sitting there.
    const input = recipe.inputs[0];
    verb = recipe.kind === 'unpack' ? 'Unpack into' : 'Process into';
    detail = `Uses ${num(step!.runs * input.qty)} ${ctx.book.name(input.id)} already in storage`;
  } else if (todo.kind === 'gather') {
    verb = 'Gather';
    const names = [...new Set(sources.map((r) => r.source))].slice(0, 3);
    detail = names.length ? `From ${names.join(', ')}` : 'No farmable source in the game data';
  } else if (todo.kind === 'buy') {
    verb = 'Buy';
    detail = view.onOrder.has(row.id) ? 'On a claim buy order' : `Sold by ${ctx.game.sold[row.id] ?? 'a traveler'}`;
  } else if (recipe) {
    passive = !!recipe.passive;
    verb = recipe.kind === 'build' ? 'Build' : recipe.passive ? 'Passive craft · load it and it runs on its own' : 'Craft';
    const where = [recipe.skill && `${recipe.skill}${recipe.level ? ' ' + recipe.level : ''}`, recipe.station && `${recipe.station}${recipe.stationTier ? ' T' + recipe.stationTier : ''}`].filter(Boolean).join(' · ');
    const waiting = todo.awaiting?.[0];
    if (todo.kind === 'blocked') {
      const first = todo.missing?.[0];
      const short = first ? `Short ${num(first.short)} ${ctx.book.name(first.id)}${(todo.missing?.length ?? 0) > 1 ? ` and ${todo.missing!.length - 1} more` : ''}` : '';
      detail = [short, waiting && held(waiting)].filter(Boolean).join(' · ') || where;
    } else {
      const partial = (todo.doable ?? 0) < step!.runs;
      detail = partial ? [where, `enough in storage for ${num(todo.doable ?? 0)} of ${num(step!.runs)} ${plural(step!.runs, 'craft')}`, waiting && held(waiting).replace(/^Waiting on /, 'waiting on ').replace(/^Collect /, 'collect ')].filter(Boolean).join(' · ') : where;
    }
  }

  // Material of this kind that is already inside a craft at a station, on its way to becoming something else.
  const inside = new Map<string, { qty: number; text: string }>();
  if (todo.kind !== 'pickup' && todo.kind !== 'progress') {
    for (const l of view.loaded.get(row.id) ?? []) {
      const text = `in the ${stationOf(l.job)}, becoming ${l.into.name}${l.job.passive ? ' (passive)' : ''}`;
      const entry = inside.get(text);
      if (entry) entry.qty += l.qty;
      else inside.set(text, { qty: l.qty, text });
    }
  }

  const showSplit = todo.kind !== 'pickup' && todo.kind !== 'progress' && todo.kind !== 'blocked' && branches.length > 0;

  return (
    <Card className="flex min-w-0 flex-col px-3.5 py-3">
      <button type="button" onClick={onOpen} className="flex w-full items-start gap-3 text-left">
        <div className="min-w-0 flex-1">
          <div className={cx('flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide', passive ? 'text-info' : 'text-muted')}>
            {passive && <Hourglass size={11} className="shrink-0" />}
            <span className="truncate">{verb}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[13px] font-medium text-ink">
            <TierChip tier={row.tier} />
            <span className="truncate hover:underline">{row.name}</span>
          </div>
          {detail && (
            <div className="mt-0.5 line-clamp-2 text-xs text-ink-2" title={typeof detail === 'string' ? detail : undefined}>
              {detail}
            </div>
          )}
          {[...inside.values()].map((entry) => (
            <div key={entry.text} className="mt-0.5 flex items-start gap-1 text-xs text-info">
              <Hourglass size={12} className="mt-0.5 shrink-0" />
              <span>
                <span className="num font-semibold">{num(entry.qty)}</span> more already {entry.text}
              </span>
            </div>
          ))}
        </div>
        <div className="shrink-0 text-right">
          <div className="num text-xl font-semibold leading-tight text-ink">{num(todo.qty)}</div>
          {todo.kind !== 'pickup' && todo.kind !== 'progress' && (
            <div className="num text-[11px] text-muted">
              have {num(node.have)} of {num(node.needed)}
            </div>
          )}
        </div>
      </button>
      {showSplit && (
        <div className="mt-2.5 border-t border-line pt-2.5">
          <div className="mb-1.5 text-[11px] text-muted">Where the {num(node.needed)} go</div>
          <SplitBar branches={branches} className="mb-2" />
          <BranchList view={view} id={row.id} limit={3} onOpen={openItem} compact />
        </div>
      )}
      <div className="mt-auto flex items-center gap-2 pt-2.5">
        <span className="text-[11px] text-muted">Who's on it</span>
        <AssignControl scope={scope} id={row.id} />
      </div>
    </Card>
  );
}
