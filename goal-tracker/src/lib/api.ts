import { API } from './claim.ts';
import type { Board, ChestActivity, ClaimDetail, Push, StockSnapshot } from './shapes.ts';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The board password someone typed on this device, remembered so they are not asked again. */
const keyName = (slug: string) => `qm.key.${slug}`;
export const savedKey = (slug: string) => {
  try {
    return localStorage.getItem(keyName(slug)) ?? '';
  } catch {
    return '';
  }
};
const keyWatchers = new Set<() => void>();
/** Tells the page when the remembered password changes, so locked parts can open without a reload. */
export const onKeyChange = (notify: () => void) => {
  keyWatchers.add(notify);
  return () => {
    keyWatchers.delete(notify);
  };
};
export const rememberKey = (slug: string, key: string) => {
  try {
    if (key) localStorage.setItem(keyName(slug), key);
    else localStorage.removeItem(keyName(slug));
  } catch {
    /* private window: the key just isn't remembered */
  }
  keyWatchers.forEach((notify) => notify());
};

async function call<T>(path: string, { slug, key, ...init }: RequestInit & { slug?: string; key?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.body) headers['content-type'] = 'application/json';
  // The password remembered on this device, unless one is being tried out.
  const editKey = key ?? (slug ? savedKey(slug) : '');
  if (editKey) headers['x-edit-key'] = editKey;
  let res: Response;
  try {
    res = await fetch(API + path, { ...init, headers });
  } catch {
    throw new ApiError(0, "Can't reach the server. Check your connection and try again.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? 'Something went wrong.');
  return data as T;
}

export const api = {
  /** The claim itself: tier, supplies, members. */
  claim: () => call<ClaimDetail>('/claim'),
  /** What the claim's chests hold, plus the personal storage of the members listed. */
  stock: (players: string[], fresh = false) => call<StockSnapshot>(`/stock?players=${players.join(',')}${fresh ? '&fresh=1' : ''}`),
  /** A shared chest's latest deposits and withdrawals. `owner` is the house owner, for a chest inside one of the shared houses. */
  activity: (chest: string, owner?: string) => call<ChestActivity>(`/activity?chest=${chest}${owner ? `&owner=${owner}` : ''}`),
  board: (slug: string) => call<Board>(`/boards/${slug}`),
  savePush: (slug: string, push: Partial<Push> & { name: string }, pushSlug = 'new') =>
    call<{ board: Board; push: Push }>(`/boards/${slug}/pushes/${pushSlug}`, { method: 'PUT', body: JSON.stringify(push), slug }),
  deletePush: (slug: string, pushSlug: string) => call<Board>(`/boards/${slug}/pushes/${pushSlug}`, { method: 'DELETE', slug }),
  setLock: (slug: string, key: string) => call<Board>(`/boards/${slug}/lock`, { method: 'POST', body: JSON.stringify({ key }), slug }),
  /** Asks whether a password is right: the one remembered here, or `key` to try one out without remembering it. */
  unlock: (slug: string, key?: string) => call<{ ok: true }>(`/boards/${slug}/unlock`, { method: 'POST', slug, key }),
};
