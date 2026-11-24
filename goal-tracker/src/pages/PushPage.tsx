import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Boxes, Hammer, Lock, Pickaxe, Search, Settings2, Target as TargetIcon } from 'lucide-react';
import { api } from '../lib/api.ts';
import { putBoard } from '../lib/boards.ts';
import { buildView, type PushView, type StageProgress } from '../lib/derive.ts';
import { num, pct } from '../lib/format.ts';
import { useGame, type GameCtx } from '../lib/game.ts';
import { useLoad } from '../lib/hooks.ts';
import { Link, setQuery, useQuery } from '../lib/router.tsx';
import type { Board, ClaimDetail, Push, StockSnapshot } from '../lib/shapes.ts';
import type { Ref } from '../engine/types.ts';
import { Bar, Button, Card, Empty, Notice, Pill, Skeleton, Tabs, TierChip, cx, inputBase } from '../ui/kit.tsx';
import { StorageRead, useStock } from '../ui/storage.tsx';
import { LockedPanel, guarded, useAccess } from '../ui/unlock.tsx';
import { KIND_LABEL } from './BoardPage.tsx';
import { GatherTab } from './push/GatherTab.tsx';
import { ProcessTab } from './push/ProcessTab.tsx';
import { StorageTab } from './push/StorageTab.tsx';
import { SetupTab } from './push/SetupTab.tsx';
import { ItemDrawer } from './push/ItemDrawer.tsx';

/** Everything the tabs of one push need. */
export interface PushScope {
  ctx: GameCtx;
  board: Board;
  push: Push;
  claim: ClaimDetail | null;
  snapshot: StockSnapshot | null;
  view: PushView;
  /** Save a change to the push. Resolves once the server has it. */
  save: (patch: Partial<Push>) => Promise<void>;
  /** Set who has taken on a material. An empty list clears it. */
  assign: (id: Ref, people: string[]) => Promise<void>;
  openItem: (id: Ref) => void;
}

type TabId = 'gather' | 'process' | 'storage' | 'setup';
const TAB_IDS: TabId[] = ['gather', 'process', 'storage', 'setup'];
/** Addresses saved before the tabs were renamed still open the right place. */
const OLD_TABS: Record<string, TabId> = { todo: 'gather', chains: 'process' };
/** Tabs that change the push for everyone. Once the board has a password they open only for people who have typed it. */
const MANAGE_TABS: Partial<Record<TabId, string>> = { storage: 'Storage', setup: 'Setup' };

export function PushPage({ slug, pushSlug }: { slug: string; pushSlug: string }) {
  const board = useLoad<Board>('board:' + slug, () => api.board(slug));
  const push = board.data?.pushes.find((p) => p.slug === pushSlug) ?? null;
  const claim = useLoad<ClaimDetail>('claim', () => api.claim());
  const { ctx, error: gameError } = useGame();
  const players = useMemo(() => [...(push?.players ?? [])].sort().join(','), [push?.players]);
  // Read when the page opens, then every 15 minutes while it is on screen (see useStock).
  const stock = useStock(push ? `stock:${players}` : null, players ? players.split(',') : []);
  const [saveError, setSaveError] = useState<string | null>(null);
  const access = useAccess(board.data);

  useEffect(() => {
    if (board.data) putBoard(board.data);
  }, [board.data]);

  const query = useQuery();
  const askedTab = query.get('tab') ?? '';
  const wantedTab = (OLD_TABS[askedTab] ?? askedTab) as TabId;
  const tab: TabId = TAB_IDS.includes(wantedTab) ? wantedTab : 'gather';
  const item = query.get('item');

  const view = useMemo(() => (ctx && push ? buildView(ctx, push, stock.data) : null), [ctx, push, stock.data]);

  const setBoard = board.set;
  // Changes are sent one after another, each built on the copy the last one saved,
  // so two quick clicks (assigning two jobs in a row) never overwrite each other.
  const latest = useRef<Push | null>(push);
  latest.current = push;
  const queue = useRef<Promise<void>>(Promise.resolve());
  const change = useCallback(
    (build: (current: Push) => Partial<Push>) => {
      const job = queue.current
        .catch(() => {})
        .then(async () => {
          const current = latest.current;
          if (!current) return;
          setSaveError(null);
          try {
            const saved = await guarded(slug, () => api.savePush(slug, { ...current, ...build(current) }, current.slug));
            latest.current = saved.push;
            setBoard(saved.board);
          } catch (err) {
            setSaveError((err as Error).message);
            throw err;
          }
        });
      queue.current = job;
      return job;
    },
    [slug, setBoard],
  );
  const save = useCallback((patch: Partial<Push>) => change(() => patch), [change]);
  const assign = useCallback(
    (id: Ref, people: string[]) =>
      change((current) => {
        const assignments = { ...(current.assignments ?? {}) };
        if (people.length) assignments[id] = people;
        else delete assignments[id];
        return { assignments };
      }),
    [change],
  );
  const openItem = useCallback((id: Ref) => setQuery('item', id, { push: true }), []);

  if (board.loading || (!ctx && !gameError)) return <Skeleton className="h-72" />;
  if (!board.data || !push) {
    return (
      <Empty title={board.data ? `No push called “${pushSlug}” here` : 'Could not open this board'}>
        <p>{board.data ? 'It may have been renamed or removed.' : board.error}</p>
        <Link to={board.data ? '/' + slug : '/'} className="mt-4 inline-block text-accent-ink underline">
          Back to all pushes
        </Link>
      </Empty>
    );
  }
  if (!ctx || !view) return <Notice tone="bad">{gameError ?? 'Could not load the game data.'}</Notice>;

  const scope: PushScope = { ctx, board: board.data, push, claim: claim.data, snapshot: stock.data, view, save, assign, openItem };
  const waitingOnStock = stock.loading && !stock.data;
  // The numbers on the tabs: what still has to be brought in, and what can be collected or crafted right now.
  const toBringIn = view.todos.filter((t) => t.kind === 'gather' || t.kind === 'buy').length;
  const readyToProcess = view.todos.filter((t) => t.kind === 'pickup' || t.kind === 'craft' || t.kind === 'stock').length;
  const hasGoals = push.goals.length > 0;
  /** The board has a password and this device has not given it. */
  const shut = access.locked && !access.allowed && !access.checking;

  return (
    <div>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold">{push.name}</h1>
            <Pill>{KIND_LABEL[push.kind]}</Pill>
            <Pill tone={push.status === 'active' ? 'accent' : push.status === 'done' ? 'good' : 'warn'}>{push.status === 'active' ? 'Active' : push.status === 'done' ? 'Done' : 'Planned'}</Pill>
          </div>
          {push.note && <p className="mt-1 max-w-2xl text-[13px] text-ink-2">{push.note}</p>}
        </div>
        <div className="flex items-center gap-2">
          {hasGoals && !waitingOnStock && <FindMaterial view={view} onPick={openItem} />}
          <StorageRead stock={stock} />
        </div>
      </div>

      {hasGoals && (
        <Card className="mt-4 px-4 py-3">
          {waitingOnStock ? (
            <Skeleton className="h-8" />
          ) : (
            <div className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
              <Stage
                label="Raw materials gathered"
                stage={view.progress.gather}
                detail={`${num(view.progress.gather.done)} of ${num(view.progress.gather.total)} raw materials fully in hand`}
                hint="Of everything this push needs gathered or bought from scratch, how much is in hand. Raw material that has already been crafted into something still counts as gathered."
              />
              <Stage
                label="Processing done"
                stage={view.progress.process}
                detail={view.progress.process.total ? `${num(view.progress.process.done)} of ${num(view.progress.process.total)} crafted materials finished` : 'Nothing in this push needs crafting'}
                hint="Of all the crafting this push takes from scratch, how much is behind you, weighed by the effort each craft takes in game."
              />
            </div>
          )}
        </Card>
      )}

      <div className="mt-3 space-y-2 empty:hidden">
        {stock.error && <Notice tone="warn">Could not read live storage ({stock.error}) The numbers below treat storage as empty until it loads.</Notice>}
        {stock.data?.problems.map((p) => (
          <Notice tone="warn" key={p}>
            {p}
          </Notice>
        ))}
        {view.plan.warnings.map((w) => (
          <Notice tone="warn" key={w}>
            {w}
          </Notice>
        ))}
        {board.data.temporary && <Notice tone="warn">This server has nowhere permanent to keep pushes, so anything saved here is lost when it restarts. Whoever hosts it needs to give it a database or a disk.</Notice>}
        {saveError && <Notice tone="bad">Not saved: {saveError}</Notice>}
      </div>

      <div className="mt-4">
        <Tabs<TabId>
          value={tab}
          onChange={(next) => setQuery('tab', next === 'gather' ? null : next, { push: true })}
          tabs={[
            { id: 'gather', label: 'Gather', icon: <Pickaxe size={15} />, count: waitingOnStock ? undefined : toBringIn },
            { id: 'process', label: 'Process', icon: <Hammer size={15} />, count: waitingOnStock ? undefined : readyToProcess },
            { id: 'storage', label: 'Storage', icon: shut ? <Lock size={14} /> : <Boxes size={15} /> },
            { id: 'setup', label: 'Setup', icon: shut ? <Lock size={14} /> : <Settings2 size={15} /> },
          ]}
        />
      </div>

      <div className="mt-4">
        {MANAGE_TABS[tab] && access.checking ? (
          <Skeleton className="h-40" />
        ) : MANAGE_TABS[tab] && shut ? (
          <LockedPanel slug={slug} what={MANAGE_TABS[tab]!} />
        ) : tab === 'setup' ? (
          <SetupTab scope={scope} />
        ) : !hasGoals ? (
          <Empty title="This push has no goals yet" icon={<TargetIcon size={30} />}>
            <p>Add what you want to make and the full list of materials appears here.</p>
            <Button variant="primary" className="mt-4" onClick={() => setQuery('tab', 'setup', { push: true })}>
              Add goals
            </Button>
          </Empty>
        ) : waitingOnStock ? (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
        ) : tab === 'process' ? (
          <ProcessTab scope={scope} />
        ) : tab === 'storage' ? (
          <StorageTab scope={scope} />
        ) : (
          <GatherTab scope={scope} />
        )}
      </div>

      <ItemDrawer scope={scope} id={item} onClose={() => setQuery('item', null, { push: true })} />
    </div>
  );
}

/** One of the two progress read-outs at the top of a push. */
function Stage({ label, stage, detail, hint }: { label: string; stage: StageProgress; detail: string; hint: string }) {
  return (
    <div title={hint}>
      <div className="flex items-baseline gap-2">
        <span className="num text-2xl font-semibold text-accent-ink">{pct(stage.pct)}</span>
        <span className="text-[13px] font-medium text-ink">{label}</span>
      </div>
      <Bar value={stage.pct} className="mt-1.5 h-2" />
      <p className="mt-1.5 text-xs text-ink-2">{detail}</p>
    </div>
  );
}

/** Jump straight to any material in the push by typing part of its name. */
function FindMaterial({ view, onPick }: { view: PushView; onPick: (id: Ref) => void }) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = words.length ? view.ordered.filter((r) => words.every((w) => r.name.toLowerCase().includes(w))).slice(0, 8) : [];
  return (
    <div className="relative w-44 sm:w-56">
      <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
      <input
        className={inputBase + ' h-9 w-full pl-8'}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        placeholder="Look up a material"
        aria-label="Look up a material in this push"
      />
      {focused && words.length > 0 && (
        <div className="absolute right-0 top-10 z-20 w-72 rounded-lg border border-line-2 bg-surface-2 p-1 shadow-xl shadow-black/40">
          {hits.length === 0 && <div className="px-2 py-2 text-xs text-ink-2">Not part of this push.</div>}
          {hits.map((row) => (
            <button
              key={row.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onPick(row.id);
                setQuery('');
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-surface-3"
            >
              <TierChip tier={row.tier} />
              <span className="min-w-0 flex-1 truncate">{row.name}</span>
              <span className={cx('num', row.node.toGo > 0 ? 'text-warn' : 'text-good')}>{row.node.toGo > 0 ? `${num(row.node.toGo)} to go` : 'covered'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
