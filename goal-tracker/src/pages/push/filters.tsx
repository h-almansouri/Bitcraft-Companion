import { useState, type ReactNode } from 'react';
import { Layers, ListFilter, Search, User, Users, X } from 'lucide-react';
import type { Ref } from '../../engine/types.ts';
import { professionRank, type TodoKind } from '../../lib/derive.ts';
import { num } from '../../lib/format.ts';
import { useLocal } from '../../lib/hooks.ts';
import { Chip, MultiSelect, inputBase } from '../../ui/kit.tsx';
import type { PushScope } from '../PushPage.tsx';
import { assigneesOf } from './parts.tsx';

/**
 * One set of filters for the Gather and Process tabs.
 *
 * Tier, role and person are shared: pick "Tier 5, Foraging, chels" once and both
 * tabs narrow to it. Process adds the stage a job is at. Choices are remembered on
 * this device.
 */
export interface Filters {
  /** Stage a processing job is at: collect, craft now, being crafted, waiting. */
  actions: string[];
  tiers: string[];
  roles: string[];
  people: string[];
  /** Chains only: hide chains that are fully covered. */
  short: boolean;
}

const NONE: Filters = { actions: [], tiers: [], roles: [], people: [], short: false };

/** Stands for "nobody has taken this" in the person filter. */
export const UNASSIGNED = 'nobody';

/** The stage a job is at. Bringing things in is one side of a push; working them up is the other. */
export type StageId = 'gather' | 'buy' | 'pickup' | 'craft' | 'progress' | 'blocked';
export const STAGES: { id: StageId; label: string; side: 'gather' | 'process' }[] = [
  { id: 'gather', label: 'Gather', side: 'gather' },
  { id: 'pickup', label: 'Collect', side: 'process' },
  { id: 'craft', label: 'Craft now', side: 'process' },
  { id: 'buy', label: 'Buy', side: 'process' },
  { id: 'progress', label: 'Being crafted', side: 'process' },
  { id: 'blocked', label: 'Waiting on materials', side: 'process' },
];
/**
 * A one-step shortcut from storage (unpack a package, process a raw material that
 * is already there) is, to whoever does it, just another craft that can be done now.
 */
export const stageOf = (kind: TodoKind): StageId => (kind === 'stock' ? 'craft' : kind);

interface Option {
  id: string;
  label: string;
  count?: number;
}

/** What a tab offers to filter by. Leaving a list out hides that filter on the tab. */
export interface FilterConfig {
  actions?: Option[];
  /** Tiers that occur on this tab, with how many things are in each. */
  tiers?: { tier: number; count?: number }[];
  /** Professions that occur on this tab. */
  roles?: { id: string; count?: number }[];
  /** How many things each member (or UNASSIGNED) has on this tab. Passing it shows the person filter. */
  people?: (person: string) => number;
  short?: boolean;
  searchPlaceholder?: string;
}

/** Who has taken on a material: members (ignoring anyone no longer in the claim) or the claim buy order. */
export function takenBy(scope: PushScope, id: Ref): string[] {
  const members = assigneesOf(scope);
  return (scope.push.assignments?.[id] ?? []).filter((p) => members.some((m) => m.id === p));
}

export const matchTier = (f: Filters, tier: number) => !f.tiers.length || f.tiers.includes(String(tier));
export const matchRole = (f: Filters, profession: string) => !f.roles.length || f.roles.includes(profession);
export function matchPeople(scope: PushScope, f: Filters, id: Ref) {
  if (!f.people.length) return true;
  const taken = takenBy(scope, id);
  return taken.length ? taken.some((p) => f.people.includes(p)) : f.people.includes(UNASSIGNED);
}
export function matchText(query: string, ...names: string[]) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  return names.some((name) => words.every((w) => name.toLowerCase().includes(w)));
}

export function useFilterBar(scope: PushScope, config: FilterConfig) {
  const [saved, setSaved] = useLocal<Partial<Filters>>('qm.filters', {});
  const [query, setQuery] = useState('');
  const all: Filters = { ...NONE, ...saved };
  const set = (patch: Partial<Filters>) => setSaved({ ...all, ...patch });

  const members = config.people ? assigneesOf(scope) : [];
  const tiers = [...(config.tiers ?? [])].sort((a, b) => (a.tier || 99) - (b.tier || 99));
  const roles = [...(config.roles ?? [])].sort((a, b) => professionRank(a.id) - professionRank(b.id));
  const people: Option[] = config.people ? [...members.map((m) => ({ id: m.id, label: m.label, count: config.people!(m.id) })), { id: UNASSIGNED, label: 'Nobody yet', count: config.people(UNASSIGNED) }] : [];

  // A choice made on another tab only applies here if this tab has it; otherwise it would hide everything for no visible reason.
  const only = (chosen: string[], offered: { id: string }[] | undefined) => (offered ? chosen.filter((c) => offered.some((o) => o.id === c)) : []);
  const f: Filters = {
    actions: only(all.actions, config.actions),
    tiers: only(
      all.tiers,
      tiers.map((t) => ({ id: String(t.tier) })),
    ),
    roles: only(all.roles, roles),
    people: only(all.people, people),
    short: !!config.short && all.short,
  };
  const active = f.actions.length + f.tiers.length + f.roles.length + f.people.length + (f.short ? 1 : 0) + (query.trim() ? 1 : 0);

  const clear = () => {
    setQuery('');
    // Only what this tab shows is cleared, so a choice that belongs to another tab survives.
    set({
      ...(config.actions && { actions: [] }),
      ...(config.tiers && { tiers: [] }),
      ...(config.roles && { roles: [] }),
      ...(config.people && { people: [] }),
      ...(config.short && { short: false }),
    });
  };

  const bar = (shown: number, total: number, noun: string): ReactNode => (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {config.actions && (
          <MultiSelect label="Stages" placeholder="Filter by stage" allLabel="Every stage" icon={<ListFilter size={13} />} value={f.actions} onChange={(actions) => set({ actions })} options={config.actions} />
        )}
        {tiers.length > 1 && (
          <MultiSelect
            label="Tiers"
            allLabel="All tiers"
            icon={<Layers size={13} />}
            value={f.tiers}
            onChange={(next) => set({ tiers: next })}
            options={tiers.map((t) => ({ id: String(t.tier), label: t.tier ? `Tier ${t.tier}` : 'No tier', count: t.count }))}
          />
        )}
        {roles.length > 1 && (
          <MultiSelect label="Roles" allLabel="All roles" icon={<Users size={13} />} value={f.roles} onChange={(next) => set({ roles: next })} options={roles.map((r) => ({ id: r.id, label: r.id, count: r.count }))} />
        )}
        {people.length > 1 && <MultiSelect label="People" allLabel="Assigned to anyone" icon={<User size={13} />} value={f.people} onChange={(next) => set({ people: next })} options={people} />}
        {config.short && (
          <Chip active={f.short} onClick={() => set({ short: !f.short })}>
            Only what is short
          </Chip>
        )}
        <div className="relative ml-auto w-full sm:w-56">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <input className={inputBase + ' h-8 w-full pl-8'} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={config.searchPlaceholder ?? 'Find a material'} aria-label={config.searchPlaceholder ?? 'Find a material'} />
        </div>
      </div>
      <div className="mt-2 flex min-h-5 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-2">
        {active > 0 ? (
          <>
            <span>
              Showing {num(shown)} of {num(total)} {noun}
            </span>
            <button type="button" onClick={clear} className="inline-flex items-center gap-1 text-accent-ink hover:underline">
              <X size={12} /> Clear filters
            </button>
            <span className="text-muted">Filters carry across tabs and are remembered on this device.</span>
          </>
        ) : (
          <span className="text-muted">
            {num(total)} {noun}
          </span>
        )}
      </div>
    </div>
  );

  return { f, query, bar, active: active > 0 };
}
