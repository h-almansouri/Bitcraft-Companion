import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Castle, Compass, Hammer, ListPlus } from 'lucide-react';
import { api } from '../lib/api.ts';
import { HOME } from '../lib/claim.ts';
import type { GameCtx } from '../lib/game.ts';
import { navigate } from '../lib/router.tsx';
import type { Board, ClaimDetail, PushKind, PushStatus } from '../lib/shapes.ts';
import { claimTierGoals, toolPushGoals, townshipTiers } from '../lib/templates.ts';
import { Button, Field, Modal, Notice, cx, inputClass } from '../ui/kit.tsx';
import { guarded } from '../ui/unlock.tsx';

const KINDS: { id: PushKind; label: string; blurb: string; icon: ReactNode }[] = [
  { id: 'claim-tier', label: 'Claim tier push', blurb: 'Township research plus a fresh set of workstations', icon: <Castle size={20} /> },
  { id: 'tool-push', label: 'Tool push', blurb: 'Ingots, rope, planks and leather for rolling tools', icon: <Hammer size={20} /> },
  { id: 'traveler', label: 'Traveler tasks', blurb: 'Turn-ins for Alesi, Brico, Heimlich and the rest', icon: <Compass size={20} /> },
  { id: 'custom', label: 'Anything else', blurb: 'Start empty and add what you want to make', icon: <ListPlus size={20} /> },
];

export function NewPush({ open, onClose, board, claim, ctx }: { open: boolean; onClose: () => void; board: Board; claim: ClaimDetail | null; ctx: GameCtx }) {
  const [kind, setKind] = useState<PushKind>('claim-tier');
  const tiers = useMemo(() => townshipTiers(ctx), [ctx]);
  const nextTier = Math.min(Math.max((claim?.tier ?? 2) + 1, tiers[0] ?? 3), tiers[tiers.length - 1] ?? 10);
  const [tier, setTier] = useState<number | null>(null);
  const [stations, setStations] = useState(true);
  const [tools, setTools] = useState(1000);
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(6);
  const [name, setName] = useState('');
  const [status, setStatus] = useState<PushStatus>('active');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const chosenTier = tier ?? nextTier;
  const suggested = kind === 'claim-tier' ? `Claim T${chosenTier} push` : kind === 'tool-push' ? `Tool push T${from}-T${to}` : kind === 'traveler' ? 'Traveler tasks' : '';

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (kind === 'traveler') {
      navigate(HOME + '/travelers');
      return;
    }
    const goals = kind === 'claim-tier' ? claimTierGoals(ctx, chosenTier, stations) : kind === 'tool-push' ? toolPushGoals(ctx, tools, Math.min(from, to), Math.max(from, to)) : [];
    setBusy(true);
    setProblem(null);
    try {
      const saved = await guarded(board.slug, () =>
        api.savePush(board.slug, {
          name: name.trim() || suggested || 'New push',
          kind,
          status,
          goals,
          // Everyone in the claim counts, including people who join later, until someone narrows it down in Setup.
          players: claim?.members.map((m) => m.id) ?? [],
          leftOut: [],
          excluded: [],
          excludedNames: [],
          routes: {},
          countCrafts: true,
        }),
      );
      navigate(`/${board.slug}/${saved.push.slug}${kind === 'custom' ? '?tab=setup' : ''}`);
    } catch (err) {
      setProblem((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={`New push for ${board.name}`} wide>
      <form onSubmit={create} className="space-y-5">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              aria-pressed={kind === k.id}
              onClick={() => setKind(k.id)}
              className={cx('flex items-start gap-3 rounded-lg border px-4 py-3 text-left transition-colors', kind === k.id ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-2')}
            >
              <span className={cx('mt-0.5', kind === k.id ? 'text-accent-ink' : 'text-ink-2')}>{k.icon}</span>
              <span>
                <span className="block text-sm font-medium">{k.label}</span>
                <span className="block text-[13px] text-ink-2">{k.blurb}</span>
              </span>
            </button>
          ))}
        </div>

        {kind === 'claim-tier' && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Upgrading to">
              <select className={inputClass} value={chosenTier} onChange={(e) => setTier(Number(e.target.value))}>
                {tiers.map((t) => (
                  <option key={t} value={t}>
                    Tier {t}
                    {t === nextTier ? ' (next for this claim)' : ''}
                  </option>
                ))}
              </select>
            </Field>
            <label className="flex items-center gap-2.5 self-end pb-2.5 text-sm">
              <input type="checkbox" checked={stations} onChange={(e) => setStations(e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
              Include a full set of T{chosenTier} workstations
            </label>
          </div>
        )}

        {kind === 'tool-push' && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Tools to roll">
              <input type="number" min={1} max={100000} className={inputClass} value={tools} onChange={(e) => setTools(Math.max(1, Number(e.target.value) || 1))} />
            </Field>
            <Field label="From tier">
              <select className={inputClass} value={from} onChange={(e) => setFrom(Number(e.target.value))}>
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((t) => (
                  <option key={t} value={t}>
                    T{t}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Up to tier">
              <select className={inputClass} value={to} onChange={(e) => setTo(Number(e.target.value))}>
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((t) => (
                  <option key={t} value={t}>
                    T{t}
                  </option>
                ))}
              </select>
            </Field>
            <p className="text-[13px] text-ink-2 sm:col-span-3">Each tool takes 4 ingots, 2 rope, 2 planks and 2 leather at every tier it passes through.</p>
          </div>
        )}

        {kind === 'traveler' ? (
          <Notice>Pick the tasks on the Traveler tasks page, then save them here as a push.</Notice>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
            <Field label="Name">
              <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder={suggested || 'Winter festival build'} maxLength={80} />
            </Field>
            <Field label="Starts as">
              <select className={inputClass} value={status} onChange={(e) => setStatus(e.target.value as PushStatus)}>
                <option value="active">Active now</option>
                <option value="planned">Planned for later</option>
              </select>
            </Field>
          </div>
        )}

        {problem && <Notice tone="bad">{problem}</Notice>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={busy}>
            {kind === 'traveler' ? 'Choose tasks' : busy ? 'Creating…' : 'Create push'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
