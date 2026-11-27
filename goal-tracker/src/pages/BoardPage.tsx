import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Lock, LockOpen, Plus, Trophy } from 'lucide-react';
import { api, rememberKey } from '../lib/api.ts';
import { putBoard } from '../lib/boards.ts';
import { buildView, countedPlayers } from '../lib/derive.ts';
import { day, num, pct, plural } from '../lib/format.ts';
import { useGame, type GameCtx } from '../lib/game.ts';
import { useLoad } from '../lib/hooks.ts';
import { Link } from '../lib/router.tsx';
import type { Board, ClaimDetail, Push, PushKind, PushStatus, StockSnapshot } from '../lib/shapes.ts';
import { Bar, Button, Card, Chip, Empty, Field, Modal, Notice, Pill, Skeleton, TierChip, inputClass } from '../ui/kit.tsx';
import { useStock } from '../ui/storage.tsx';
import { guarded } from '../ui/unlock.tsx';
import { NewPush } from './NewPush.tsx';

export const KIND_LABEL: Record<PushKind, string> = { 'claim-tier': 'Claim tier', 'tool-push': 'Tool push', traveler: 'Traveler tasks', custom: 'Custom' };
const SECTIONS: { status: PushStatus; title: string; empty: string }[] = [
  { status: 'active', title: 'Active', empty: 'Nothing running right now.' },
  { status: 'planned', title: 'Planned', empty: 'Nothing lined up yet.' },
  { status: 'done', title: 'Completed', empty: 'No finished pushes yet.' },
];

export function BoardPage({ slug }: { slug: string }) {
  const board = useLoad<Board>('board:' + slug, () => api.board(slug));
  const claim = useLoad<ClaimDetail>('claim', () => api.claim());
  const { ctx, error: gameError } = useGame();
  const [kind, setKind] = useState<PushKind | 'all'>('all');
  const [creating, setCreating] = useState(false);
  const [locking, setLocking] = useState(false);

  useEffect(() => {
    if (board.data) putBoard(board.data);
  }, [board.data]);

  // One stock read covers every open push on the page.
  const open = useMemo(() => board.data?.pushes.filter((p) => p.status !== 'done') ?? [], [board.data]);
  const players = useMemo(() => [...new Set(open.flatMap((p) => countedPlayers(p, claim.data?.members)))].sort(), [open, claim.data]);
  /** Some push counts whoever is in the claim, and the member list is still on its way. */
  const membersPending = claim.loading && open.some((p) => p.leftOut);
  // Read when the page opens, then every 15 minutes while it is on screen (see useStock).
  const stock = useStock(open.length && !membersPending ? `stock:${players.join(',')}` : null, players);

  if (board.loading) return <Skeleton className="h-64" />;
  if (!board.data) {
    return (
      <Empty title="Could not open the board">
        <p>{board.error}</p>
      </Empty>
    );
  }

  const b = board.data;
  const shown = b.pushes.filter((p) => kind === 'all' || p.kind === kind);
  const kinds = [...new Set(b.pushes.map((p) => p.kind))];

  return (
    <div>
      <div className="flex flex-wrap items-end gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <h1 className="truncate text-xl font-semibold">{b.name}</h1>
            {claim.data && <TierChip tier={claim.data.tier} />}
          </div>
          <p className="mt-0.5 text-[13px] text-ink-2">
            {[claim.data?.region || b.region, claim.data && `${claim.data.members.length} members`, claim.data && `${num(claim.data.supplies)} supplies`].filter(Boolean).join(' · ')}
          </p>
        </div>
        <Button variant="soft" onClick={() => setLocking(true)} title={b.locked ? 'Changes need the board password' : 'Anyone with the link can make changes'}>
          {b.locked ? <Lock size={15} /> : <LockOpen size={15} />}
          {b.locked ? 'Locked' : 'Open to edit'}
        </Button>
        <Button variant="primary" onClick={() => setCreating(true)} disabled={!ctx}>
          <Plus size={16} />
          New push
        </Button>
      </div>

      {b.temporary && (
        <div className="mt-4">
          <Notice tone="warn">This server has nowhere permanent to keep pushes, so anything saved here is lost when it restarts. Whoever hosts it needs to give it a database or a disk.</Notice>
        </div>
      )}
      {gameError && (
        <div className="mt-4">
          <Notice tone="bad">{gameError}</Notice>
        </div>
      )}
      {stock.error && (
        <div className="mt-4">
          <Notice tone="warn">Live inventories are not loading right now ({stock.error}) Progress below may be missing.</Notice>
        </div>
      )}

      {b.pushes.length === 0 ? (
        <div className="mt-8">
          <Empty title="Start this claim's first push">
            <p>A push is one group project: a claim tier upgrade, a tool push, a batch of traveler tasks. Name it, and everyone works from the same list.</p>
            <Button variant="primary" className="mt-5" onClick={() => setCreating(true)} disabled={!ctx}>
              <Plus size={16} />
              New push
            </Button>
          </Empty>
        </div>
      ) : (
        <>
          {kinds.length > 1 && (
            <div className="mt-5 flex flex-wrap gap-2">
              <Chip active={kind === 'all'} onClick={() => setKind('all')} count={b.pushes.length}>
                All
              </Chip>
              {kinds.map((k) => (
                <Chip key={k} active={kind === k} onClick={() => setKind(k)} count={b.pushes.filter((p) => p.kind === k).length}>
                  {KIND_LABEL[k]}
                </Chip>
              ))}
            </div>
          )}
          <div className="mt-5 space-y-7">
            {SECTIONS.map((section) => {
              const list = shown.filter((p) => p.status === section.status);
              if (!list.length && section.status !== 'active') return null;
              return (
                <details key={section.status} open className="group">
                  <summary className="flex cursor-pointer list-none items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted [&::-webkit-details-marker]:hidden">
                    <ChevronDown size={15} className="transition-transform group-open:rotate-0 -rotate-90" />
                    {section.title}
                    <span className="num">{list.length}</span>
                  </summary>
                  <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                    {list.length === 0 && <p className="text-sm text-ink-2">{section.empty}</p>}
                    {list.map((push) => (
                      <PushCard key={push.slug} board={b} push={push} members={claim.data?.members} ctx={ctx} stock={stock.data} stockLoading={stock.loading || membersPending} />
                    ))}
                  </div>
                </details>
              );
            })}
          </div>
        </>
      )}

      {ctx && <NewPush open={creating} onClose={() => setCreating(false)} board={b} claim={claim.data} ctx={ctx} />}
      <LockDialog open={locking} onClose={() => setLocking(false)} board={b} onChange={board.set} />
    </div>
  );
}

function PushCard({ board, push, members, ctx, stock, stockLoading }: { board: Board; push: Push; members?: ClaimDetail['members']; ctx: GameCtx | null; stock: StockSnapshot | null; stockLoading: boolean }) {
  const view = useMemo(
    () => (ctx && stock && push.status !== 'done' ? buildView(ctx, { ...push, players: countedPlayers(push, members) }, stock) : null),
    [ctx, stock, push, members],
  );
  const gather = view?.todos.filter((t) => t.kind === 'gather').sort((a, b) => b.row.tier - a.row.tier) ?? [];
  const ready = view?.todos.filter((t) => t.kind === 'craft' || t.kind === 'stock' || t.kind === 'pickup').length ?? 0;
  return (
    <Link to={`/${board.slug}/${push.slug}`} className="min-w-0 no-underline">
      <Card className="h-full px-4 py-3.5 transition-colors hover:border-accent">
        <div className="flex items-start gap-2">
          <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{push.name}</h3>
          <Pill>{KIND_LABEL[push.kind]}</Pill>
        </div>
        {push.note && <p className="mt-1 line-clamp-2 text-sm text-ink-2">{push.note}</p>}
        {push.status === 'done' ? (
          <p className="mt-3 flex flex-wrap items-center gap-x-1.5 text-sm text-ink-2">
            <Trophy size={15} className="text-good" />
            <span className="font-medium text-good">Completed {day(push.completedAt ?? push.updatedAt)}</span>
            <span>
              · {num(push.goals.length)} {plural(push.goals.length, 'goal')}
            </span>
          </p>
        ) : view ? (
          <>
            <div className="mt-3 space-y-1.5">
              {(
                [
                  ['Gathered', view.progress.gather],
                  ['Processed', view.progress.process],
                ] as const
              ).map(([label, stage]) => (
                <div key={label} className="flex items-center gap-3">
                  <span className="w-[68px] shrink-0 text-xs text-ink-2">{label}</span>
                  <Bar value={stage.pct} className="flex-1" />
                  <span className="num w-9 text-right text-[13px] font-semibold text-accent-ink">{pct(stage.pct)}</span>
                </div>
              ))}
            </div>
            {ready > 0 && (
              <p className="mt-2 text-xs text-ink-2">
                {ready} {plural(ready, 'job')} ready to do
              </p>
            )}
            {gather.length > 0 && (
              <p className="mt-0.5 truncate text-xs text-ink-2">
                Still to gather: {gather.slice(0, 3).map((t) => `${num(t.qty)} ${t.row.name}`).join(', ')}
                {gather.length > 3 && ` and ${gather.length - 3} more`}
              </p>
            )}
          </>
        ) : push.goals.length === 0 ? (
          <p className="mt-3 text-sm text-ink-2">No goals yet. Open it to add what you want to make.</p>
        ) : (
          <div className="mt-4 space-y-2">{stockLoading || !ctx ? <Skeleton className="h-2" /> : <p className="text-sm text-ink-2">{push.goals.length} goals</p>}</div>
        )}
      </Card>
    </Link>
  );
}

/** Set, change or remove the password that protects a board from edits. */
function LockDialog({ open, onClose, board, onChange }: { open: boolean; onClose: () => void; board: Board; onChange: (board: Board) => void }) {
  const [key, setKey] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const apply = async (next: string) => {
    setBusy(true);
    setProblem(null);
    try {
      const updated = await guarded(board.slug, () => api.setLock(board.slug, next));
      // The new password is what this device should send from now on.
      rememberKey(board.slug, next);
      onChange(updated);
      setKey('');
      onClose();
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={board.locked ? 'Board password' : 'Lock this board'}>
      <div className="space-y-4">
        <p className="text-sm text-ink-2">
          {board.locked
            ? "Anyone with the link can look. Only people with the password can change anything, and each push's Storage and Setup tabs stay shut without it."
            : "Right now anyone with the link can add or change pushes. Set a password and only people you share it with can make changes or open a push's Storage and Setup tabs. Looking stays open to everyone."}
        </p>
        <Field label={board.locked ? 'New password' : 'Password'} hint="Share it with your claim-mates. It is not tied to any game account.">
          <input className={inputClass} type="password" value={key} onChange={(e) => setKey(e.target.value)} maxLength={100} />
        </Field>
        {problem && <Notice tone="bad">{problem}</Notice>}
        <div className="flex justify-between gap-2">
          {board.locked ? (
            <Button variant="danger" disabled={busy} onClick={() => apply('')}>
              Remove password
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy || !key} onClick={() => apply(key)}>
              {board.locked ? 'Change password' : 'Lock board'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
