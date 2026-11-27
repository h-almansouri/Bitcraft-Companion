/** Shapes shared between the server (worker/) and the site (src/). */
import type { Goal, Ref } from '../engine/types.ts';

export interface ClaimSummary {
  id: string;
  name: string;
  tier: number;
  region: string;
}

export interface ClaimMember {
  id: string;
  name: string;
  lastSeen: string | null;
}

export interface ClaimDetail extends ClaimSummary {
  owner: string;
  supplies: number;
  members: ClaimMember[];
}

/** One place things are stored: a claim chest, someone's bank stash, a cart, a house chest. */
export interface StockLocation {
  id: string;
  kind: 'claim' | 'player';
  /** Claim name for claim storage, player name for personal storage. */
  owner: string;
  ownerId?: string;
  /** The chest's nickname ("Tailoring") or the bag's name ("Settlement Stash @ Tortuga Prime"). */
  name: string;
  /** For nicknamed chests, what kind of building it is. */
  detail: string;
  items: [Ref, number][];
}

/** A craft sitting at a station: still being worked on, or finished and waiting to be collected. */
export interface CraftJob {
  id: string;
  item: Ref;
  qty: number;
  owner: string;
  ownerId: string;
  station: string;
  /** The claim the station stands in, which may not be ours (a job queued at another base). */
  claim: string;
  /** True for jobs that run on their own once loaded (loom, smelter, kiln, tanning tub). */
  passive: boolean;
  progress: number;
  total: number;
  done: boolean;
  shared: boolean;
}

export interface StockSnapshot {
  at: string;
  claim: { id: string; name: string; tier: number };
  locations: StockLocation[];
  crafts: CraftJob[];
  problems: string[];
}

/**
 * Stands in for a member in `assignments` when the claim will simply buy the thing
 * ("Claim Buy Order"). Anything given to it is planned as bought: nobody is asked to
 * gather or craft it, or anything that would only have gone into making it.
 */
export const BUY_ORDER = 'buy-order';
export const BUY_ORDER_NAME = 'Claim Buy Order';

export type PushKind = 'claim-tier' | 'tool-push' | 'traveler' | 'custom';
export type PushStatus = 'active' | 'planned' | 'done';

/** A named group project: what the claim is making, and whose storage counts toward it. */
export interface Push {
  slug: string;
  name: string;
  kind: PushKind;
  status: PushStatus;
  note?: string;
  goals: Goal[];
  /**
   * Players whose personal storage counts (the claim's own chests always can). For a push
   * with `leftOut` this is only who counted when it was last saved, used if the member list
   * cannot be read; see `countedPlayers`.
   */
  players: string[];
  /**
   * Members deliberately not counted. When set, everyone else in the claim counts,
   * including people who join after the push was made. Pushes saved before this existed
   * have no list and keep counting exactly `players`.
   */
  leftOut?: string[];
  /** Storage locations left out of the count (other people's chests, the dropbox...). */
  excluded: string[];
  /**
   * Nicknames of claim chests left out. A chest that is rebuilt or upgraded gets a new id,
   * so it stays out as long as it is given the same nickname again.
   */
  excludedNames?: string[];
  /** Per-thing recipe choices; null means "we gather or buy this, don't craft it". */
  routes: Record<Ref, string | null>;
  /** Crafts at stations count as already made. */
  countCrafts: boolean;
  /** Who has taken on each material: thing -> member ids, or BUY_ORDER. Missing or empty means nobody yet. */
  assignments?: Record<Ref, string[]>;
  /** When the push was marked complete. Only there while its status is 'done'; reopening it clears it. */
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** A claim's page: every push it has run, is running, or is planning. */
export interface Board {
  claimId: string;
  name: string;
  slug: string;
  region: string;
  /** True when a password is needed to change anything. */
  locked: boolean;
  /** True when the server has nowhere lasting to keep pushes, so they vanish when it restarts. */
  temporary?: boolean;
  pushes: Push[];
}
