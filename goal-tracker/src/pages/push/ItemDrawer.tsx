import { useState, type ReactNode } from 'react';
import { ArrowRight, Check, ChevronRight, CornerDownRight, ExternalLink, MapPin, Workflow } from 'lucide-react';
import { yieldOf } from '../../engine/book.ts';
import type { Recipe, Ref } from '../../engine/types.ts';
import { flowOf, type Loaded, type PushView, type Row } from '../../lib/derive.ts';
import { num, plural } from '../../lib/format.ts';
import { navigate } from '../../lib/router.tsx';
import { Button, Card, Drawer, Notice, Pill, TierChip, cx } from '../../ui/kit.tsx';
import type { PushScope } from '../PushPage.tsx';
import { AssignControl, BranchList, SplitBar, branchText, jobState, stationOf } from './parts.tsx';

export function ItemDrawer({ scope, id, onClose }: { scope: PushScope; id: Ref | null; onClose: () => void }) {
  const row = id ? scope.view.rows.get(id) : undefined;
  const thing = id ? scope.ctx.book.thing(id) : undefined;
  return (
    <Drawer
      open={!!id}
      onClose={onClose}
      title={
        id && (
          <div>
            <div className="flex items-center gap-2">
              <TierChip tier={thing?.tier ?? 0} />
              <h2 className="truncate text-base font-semibold">{thing?.name ?? id}</h2>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {row && <Pill>{row.profession}</Pill>}
              {row && row.node.goal > 0 && <Pill tone="accent">Goal of this push</Pill>}
              {row?.status === 'done' && <Pill tone="good">Covered</Pill>}
            </div>
          </div>
        )
      }
    >
      {id && (row ? <Detail key={id} scope={scope} row={row} /> : <Notice>This is not part of the push right now. It may already be covered further up the chain.</Notice>)}
    </Drawer>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'warn' }) {
  return (
    <div className="rounded-lg bg-surface px-3 py-2.5">
      <div className="text-xs text-muted">{label}</div>
      <div className={cx('num text-base font-semibold', tone === 'good' && 'text-good', tone === 'warn' && 'text-warn')}>{value}</div>
    </div>
  );
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="mt-7">
      <div className="mb-2.5 flex items-center gap-2">
        <h3 className="flex-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Detail({ scope, row }: { scope: PushScope; row: Row }) {
  const { view, ctx, openItem, push } = scope;
  const { node, id } = row;
  const branches = flowOf(view, id);
  const holdings = view.stock.where.get(id) ?? [];
  const jobs = view.stock.atStations.get(id) ?? [];
  const atStations = jobs.reduce((sum, j) => sum + j.qty, 0);
  // Several batches in the same loom, becoming the same thing, read as one line.
  const loaded: Loaded[] = [];
  for (const l of view.loaded.get(id) ?? []) {
    const same = loaded.find((o) => o.into.id === l.into.id && stationOf(o.job) === stationOf(l.job) && jobState(o.job) === jobState(l.job));
    if (same) same.qty += l.qty;
    else loaded.push({ ...l });
  }
  const [choosing, setChoosing] = useState(false);
  // Opens Process on the full picture, with this material's chain brought into view.
  const showChain = () => {
    const params = new URLSearchParams(window.location.search);
    params.set('tab', 'process');
    params.set('chain', id);
    params.delete('item');
    navigate(window.location.pathname + '?' + params.toString());
  };

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <span className="text-xs text-muted">Who's on it</span>
        <AssignControl scope={scope} id={id} />
        <button type="button" onClick={showChain} className="ml-auto inline-flex items-center gap-1 text-[13px] text-accent-ink hover:underline">
          <Workflow size={13} /> See the full picture
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Needed in total" value={num(node.needed)} />
        <Stat label={atStations ? 'Have (incl. at stations)' : 'Have'} value={num(node.have)} />
        {node.toGo > 0 ? <Stat label="Still to go" value={num(node.toGo)} tone="warn" /> : <Stat label="Spare" value={num(node.surplus)} tone="good" />}
      </div>

      {branches.length > 0 && (
        <Section title={`Where the ${num(node.needed)} go`}>
          <Card className="px-4 py-3.5">
            <SplitBar branches={branches} className="mb-3" />
            <BranchList view={view} id={id} onOpen={openItem} />
          </Card>
          {branches.some((b) => !b.final) && (
            <details className="group mt-2">
              <summary className="cursor-pointer list-none text-[13px] text-accent-ink hover:underline [&::-webkit-details-marker]:hidden">
                <span className="group-open:hidden">Follow it all the way to the finished goods</span>
                <span className="hidden group-open:inline">Hide the full chain</span>
              </summary>
              <Card className="mt-2 px-4 py-3">
                <Chain view={view} id={id} depth={0} seen={new Set([id])} onOpen={openItem} />
              </Card>
            </details>
          )}
        </Section>
      )}

      <Section
        title="How to get it"
        aside={
          !view.onOrder.has(id) &&
          node.alternatives.length + ctx.router.gatherSources(id).length > 0 && (
            <button type="button" className="text-[13px] text-accent-ink hover:underline" onClick={() => setChoosing(!choosing)}>
              {choosing ? 'Done' : 'Change route'}
            </button>
          )
        }
      >
        {choosing ? <RouteChooser scope={scope} row={row} onDone={() => setChoosing(false)} /> : <HowTo scope={scope} row={row} />}
        {id in push.routes && !choosing && <p className="mt-2 text-xs text-muted">This push uses a hand-picked route for this.</p>}
      </Section>

      <Section title="Where it is">
        {holdings.length === 0 && jobs.length === 0 ? (
          <p className="text-sm text-ink-2">None in the storage this push counts.</p>
        ) : (
          <Card className="divide-y divide-line">
            {holdings.map((h, i) => (
              <div key={h.loc.id + i} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{h.loc.name}</div>
                  <div className="truncate text-xs text-ink-2">{[h.loc.owner, h.loc.detail].filter(Boolean).join(' · ')}</div>
                </div>
                <span className="num font-semibold">{num(h.qty)}</span>
              </div>
            ))}
            {jobs.map((job) => (
              <div key={job.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{stationOf(job)}</div>
                  <div className={cx('truncate text-xs', job.passive && !job.done ? 'text-info' : 'text-ink-2')}>
                    {job.owner} · {jobState(job)}
                  </div>
                </div>
                <span className="num font-semibold">{num(job.qty)}</span>
              </div>
            ))}
          </Card>
        )}
        {loaded.length > 0 && (
          <>
            <p className="mb-1.5 mt-3 text-xs text-muted">Already inside crafts at stations, so no longer in storage:</p>
            <Card className="divide-y divide-line">
              {loaded.map((l, i) => (
                <button key={l.job.id + i} type="button" onClick={() => openItem(l.into.id)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-surface-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{stationOf(l.job)}</div>
                    <div className={cx('truncate text-xs', l.job.passive ? 'text-info' : 'text-ink-2')}>
                      becoming {l.into.name} · {jobState(l.job)}
                    </div>
                  </div>
                  <span className="num font-semibold">{num(l.qty)}</span>
                </button>
              ))}
            </Card>
          </>
        )}
      </Section>
    </div>
  );
}

/** Downstream tree: what this turns into, and what that turns into, until it reaches a goal. */
function Chain({ view, id, depth, seen, onOpen }: { view: PushView; id: Ref; depth: number; seen: Set<Ref>; onOpen: (id: Ref) => void }) {
  const branches = flowOf(view, id);
  return (
    <ul className={cx('space-y-1.5 text-sm', depth > 0 && 'ml-4 mt-1.5 border-l border-line pl-3')}>
      {branches.map((b, i) => {
        const text = branchText(b);
        const deeper = b.into && !b.final && depth < 5 && !seen.has(b.into.id);
        return (
          <li key={i}>
            <div className="flex items-start gap-1.5">
              {depth > 0 && <CornerDownRight size={13} className="mt-1 shrink-0 text-muted" />}
              <span>
                <span className="num font-semibold">{text.amount}</span>
                {!b.final && b.into && <ArrowRight size={13} className="mx-1 inline -translate-y-px text-muted" />}
                {b.into ? (
                  <button type="button" className={cx('text-left hover:underline', b.final ? 'ml-1 text-ink-2' : 'text-ink')} onClick={() => onOpen(b.into!.id)}>
                    {text.rest}
                  </button>
                ) : (
                  <span className="ml-1 text-ink-2">{text.rest}</span>
                )}
              </span>
            </div>
            {deeper && <Chain view={view} id={b.into!.id} depth={depth + 1} seen={new Set([...seen, b.into!.id])} onOpen={onOpen} />}
          </li>
        );
      })}
    </ul>
  );
}

function RecipeCard({ scope, recipe, id, runs, fromStock }: { scope: PushScope; recipe: Recipe; id: Ref; runs: number; fromStock?: boolean }) {
  const { ctx, view, openItem } = scope;
  const made = yieldOf(recipe, id);
  const where = [recipe.station && `${recipe.station}${recipe.stationTier ? ' T' + recipe.stationTier : ''}`, recipe.skill && `${recipe.skill}${recipe.level ? ' level ' + recipe.level : ''}`].filter(Boolean);
  return (
    <Card className="px-4 py-3.5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{fromStock ? 'From what is already in storage' : recipe.kind === 'build' ? 'Build it' : 'Craft it'}</div>
          {where.length > 0 && <div className="text-[13px] text-ink-2">{where.join(' · ')}</div>}
        </div>
        {runs > 0 && (
          <div className="text-right text-[13px] text-ink-2">
            <span className="num font-semibold text-ink">{num(runs)}</span> {plural(runs, recipe.kind === 'build' ? 'build' : 'craft')}
            <div className="num text-xs">makes {num(runs * made)}</div>
          </div>
        )}
      </div>
      <ul className="mt-3 divide-y divide-line border-t border-line">
        {recipe.inputs.map((input) => {
          const total = runs * input.qty;
          const have = view.stock.totals.get(input.id) ?? 0;
          const thing = ctx.book.thing(input.id);
          const enough = runs > 0 && have >= total;
          // Which chests and bags it is sitting in, biggest pile first, then anything still at a station.
          const piles = new Map<string, number>();
          const pile = (label: string, qty: number) => piles.set(label, (piles.get(label) ?? 0) + qty);
          for (const h of view.stock.where.get(input.id) ?? []) pile(`${h.loc.kind === 'player' ? h.loc.owner + ': ' : ''}${h.loc.name}`, h.qty);
          for (const job of view.stock.atStations.get(input.id) ?? []) pile(`${stationOf(job)}, ${job.done ? 'ready to collect' : job.passive ? 'passive craft' : 'being crafted'}`, job.qty);
          const spots = [...piles].map(([label, qty]) => `${label} (${num(qty)})`);
          return (
            <li key={input.id}>
              <button type="button" onClick={() => openItem(input.id)} className="group flex w-full items-center gap-2 py-2 text-left text-sm">
                <TierChip tier={thing?.tier ?? 0} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate group-hover:underline">{thing?.name ?? input.id}</span>
                  <span className="block truncate text-[11px] text-muted" title={spots.join('\n') || undefined}>
                    {spots.length ? spots.slice(0, 2).join(' · ') + (spots.length > 2 ? ` · +${spots.length - 2} more` : '') : 'None in storage'}
                  </span>
                </span>
                <span className="num text-[13px] text-ink-2">{num(input.qty)} each</span>
                {runs > 0 && (
                  <span className={cx('num w-28 text-right text-[13px]', enough ? 'text-good' : 'text-warn')}>
                    {enough && <Check size={13} className="mr-1 inline" />}
                    {num(Math.min(have, total))} / {num(total)}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {made !== 1 && <p className="mt-2 text-xs text-muted">Each {recipe.kind === 'build' ? 'build' : 'craft'} gives {Number.isInteger(made) ? num(made) : made.toFixed(2)} on average.</p>}
    </Card>
  );
}

function HowTo({ scope, row }: { scope: PushScope; row: Row }) {
  const { ctx } = scope;
  const { node, id } = row;
  const sources = ctx.router.gatherSources(id);
  const main = node.steps.find((s) => !s.fromStock);
  const stockSteps = node.steps.filter((s) => s.fromStock);
  const gatherLeft = node.toGo - node.steps.reduce((sum, s) => sum + s.runs * yieldOf(s.recipe, id), 0);

  return (
    <div className="space-y-2">
      {stockSteps.map((s) => (
        <RecipeCard key={s.recipe.id} scope={scope} recipe={s.recipe} id={id} runs={s.runs} fromStock />
      ))}
      {main ? (
        <RecipeCard scope={scope} recipe={main.recipe} id={id} runs={main.runs} />
      ) : row.recipe ? (
        // Covered already, but still worth showing how it is made.
        <RecipeCard scope={scope} recipe={row.recipe} id={id} runs={0} />
      ) : (
        <Card className="px-4 py-3.5">
          {scope.view.onOrder.has(id) ? (
            <>
              <div className="text-sm font-medium">
                On a claim buy order{gatherLeft > 0 && <span className="font-normal text-ink-2"> · {num(gatherLeft)} to buy</span>}
              </div>
              <p className="mt-1 text-xs text-ink-2">The claim is paying for this, so nobody is asked to gather or craft it, or anything that only went into making it. Take “Claim Buy Order” off under “Who's on it” to plan it the normal way again.</p>
            </>
          ) : row.profession === 'Trade' ? (
            <p className="text-sm">
              Buy from <span className="font-medium">{ctx.game.sold[id]}</span>. It can't be crafted.
            </p>
          ) : sources.length ? (
            <>
              <div className="text-sm font-medium">
                Gather it{gatherLeft > 0 && <span className="font-normal text-ink-2"> · {num(gatherLeft)} still to bring in</span>}
              </div>
              <p className="mt-0.5 text-xs text-muted">Open a source to see what it takes and where it grows.</p>
              <SourceList scope={scope} sources={sources} id={id} />
            </>
          ) : (
            <p className="text-sm text-ink-2">The game data doesn't say where this comes from. It is usually a rare catch, an event reward or a drop.</p>
          )}
        </Card>
      )}
    </div>
  );
}

/** Lets the claim pick a different recipe for one thing in this push. */
function RouteChooser({ scope, row, onDone }: { scope: PushScope; row: Row; onDone: () => void }) {
  const { ctx, push, save } = scope;
  const { id } = row;
  const current = id in push.routes ? push.routes[id] : undefined;
  const fallback = ctx.router.choose(id);
  const [busy, setBusy] = useState(false);

  const pick = async (value: string | null | undefined) => {
    setBusy(true);
    const routes = { ...push.routes };
    if (value === undefined) delete routes[id];
    else routes[id] = value;
    try {
      await save({ routes });
      onDone();
    } catch {
      /* the page shows the error */
    } finally {
      setBusy(false);
    }
  };

  const option = (key: string, selected: boolean, title: ReactNode, sub: ReactNode, onPick: () => void) => (
    <button
      key={key}
      type="button"
      disabled={busy}
      onClick={onPick}
      className={cx('flex w-full items-start gap-3 rounded-lg border px-3.5 py-2.5 text-left text-sm transition-colors', selected ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-surface-2')}
    >
      <span className={cx('mt-1 h-3.5 w-3.5 shrink-0 rounded-full border-2', selected ? 'border-accent bg-accent' : 'border-line')} />
      <span className="min-w-0">
        <span className="block font-medium">{title}</span>
        <span className="block text-[13px] text-ink-2">{sub}</span>
      </span>
    </button>
  );

  return (
    <div className="space-y-2">
      {row.node.alternatives.map((r) =>
        option(
          r.id,
          current === r.id || (current === undefined && fallback?.id === r.id),
          <>
            {r.inputs.map((i) => `${num(i.qty)} ${ctx.book.name(i.id)}`).join(' + ')}
            {fallback?.id === r.id && <span className="ml-2 text-xs font-normal text-muted">default</span>}
          </>,
          `gives ${Number.isInteger(yieldOf(r, id)) ? num(yieldOf(r, id)) : yieldOf(r, id).toFixed(2)}${r.station ? ` · ${r.station}` : ''}`,
          () => pick(fallback?.id === r.id ? undefined : r.id),
        ),
      )}
      {option(
        'raw',
        current === null || (current === undefined && !fallback),
        <>
          Don't craft it
          {!fallback && <span className="ml-2 text-xs font-normal text-muted">default</span>}
        </>,
        'List it as something to gather, buy or trade for',
        () => pick(fallback ? null : undefined),
      )}
      <div className="flex justify-end pt-1">
        <Button variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Where a gathered thing comes from. Each source opens to show what it takes and a map of where it is. */
function SourceList({ scope, sources, id }: { scope: PushScope; sources: Recipe[]; id: Ref }) {
  const [all, setAll] = useState(false);
  // The same node can appear once per way of working it; keep its richest entry.
  const seen = new Set<string>();
  const unique = sources.filter((s) => {
    const key = s.node ? `${s.node.kind}:${s.node.id}` : s.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const shown = all ? unique : unique.slice(0, 8);
  return (
    <div className="mt-2">
      <ul className="divide-y divide-line border-y border-line">
        {shown.map((s) => (
          <li key={s.id}>
            <SourceRow scope={scope} source={s} id={id} />
          </li>
        ))}
      </ul>
      {unique.length > shown.length && (
        <button type="button" onClick={() => setAll(true)} className="mt-2 text-xs text-accent-ink hover:underline">
          Show {unique.length - shown.length} more {plural(unique.length - shown.length, 'source')}
        </button>
      )}
    </div>
  );
}

function SourceRow({ scope, source, id }: { scope: PushScope; source: Recipe; id: Ref }) {
  const { ctx } = scope;
  const node = source.node;
  const creature = node?.kind === 'creature';
  const rate = yieldOf(source, id);
  const others = source.outputs.filter((o) => o.id !== id);
  const mapUrl = node ? `https://bitcraftmap.com/?${creature ? 'enemyId' : 'resourceId'}=${node.id}` : null;
  const needs = [source.skill && `${source.skill}${source.level ? ' level ' + source.level : ''}`, node?.toolTier && `a tier ${node.toolTier} tool`].filter(Boolean);
  const unit = creature ? 'animal' : 'swing';

  return (
    <details className="group/source">
      <summary className="flex cursor-pointer list-none items-center gap-2 py-2 text-[13px] [&::-webkit-details-marker]:hidden">
        <ChevronRight size={14} className="shrink-0 text-muted transition-transform group-open/source:rotate-90" />
        <TierChip tier={node?.tier ?? 0} />
        <span className="min-w-0 flex-1 truncate text-ink">{source.source}</span>
        {source.loot ? <span className="shrink-0 text-xs text-muted">one-off find</span> : <span className="shrink-0 text-xs text-ink-2">{[source.skill, source.level && `level ${source.level}`].filter(Boolean).join(' ')}</span>}
      </summary>
      <div className="mb-3 ml-[6px] space-y-2 border-l border-line pl-4 text-xs text-ink-2">
        {mapUrl && (
          <div>
            <a href={mapUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 font-medium text-accent-ink hover:underline">
              <MapPin size={13} />
              See which regions have {source.source}
              <ExternalLink size={11} />
            </a>
            <div className="mt-0.5 text-muted">Opens BitCraft Map with every {creature ? 'herd' : 'node'} marked across all nine regions.</div>
          </div>
        )}
        {needs.length > 0 && (
          <div>
            <span className="text-muted">Needs </span>
            {needs.join(' and ')}
          </div>
        )}
        {rate > 0 && (
          <div>
            <span className="text-muted">Gives </span>
            {rate >= 1 ? `about ${rate >= 10 ? num(rate) : +rate.toFixed(1)} per ${unit}` : `about 1 every ${num(1 / rate)} ${plural(1 / rate, unit)}`}
          </div>
        )}
        {others.length > 0 && (
          <div>
            <span className="text-muted">Also drops </span>
            {others
              .slice(0, 5)
              .map((o) => ctx.book.name(o.id))
              .join(', ')}
            {others.length > 5 && ` and ${others.length - 5} more`}
          </div>
        )}
        {source.loot && <div className="text-muted">Not something you can farm on purpose: it only turns up in ruins, dungeons or events.</div>}
      </div>
    </details>
  );
}
