/**
 * The site's API, written once for every place it can be hosted.
 *
 * It needs two things from whoever runs it (see `Host`): somewhere durable to keep
 * the board, and somewhere to remember Bitjita's answers. `server/embed.ts` supplies
 * both when the Companion app starts the site.
 *
 * Every address here starts with /nowhere/api (`API`): plain /api/… on the same
 * host is the Companion's pass-through to Bitjita.
 */
import { Hono, type Context, type Env } from 'hono';
import { claimDetail, stockSnapshot, UpstreamError, usage, type Memo } from './bitjita.ts';
import { API, CLAIM, RESERVED_SLUGS } from '../src/lib/claim.ts';
import { BUY_ORDER } from '../src/lib/shapes.ts';
import type { Board, Push, PushKind, PushStatus } from '../src/lib/shapes.ts';

/** The little the board needs from a database: text in, text out, by key. */
export interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface Host {
  /** Where the board is kept. */
  store: KV;
  /** Where Bitjita's answers are remembered. */
  memo: Memo;
  /**
   * False when `store` will not survive a restart (a host with no disk or database).
   * The site then warns that pushes are not being kept.
   */
  durable: boolean;
  /** A word for the storage in use, shown by /nowhere/api/health so a deploy can be checked. */
  storage: string;
}

/** What is kept for the claim. Same as the public Board plus the hashed edit password. */
export interface StoredBoard extends Omit<Board, 'locked' | 'temporary'> {
  keyHash?: string;
}

/** The key the one board is stored under. */
export const BOARD_KEY = 'board:' + CLAIM.id;

const ID = /^\d{1,24}$/;
const REF = /^[icb]\.\d{1,12}$/;

export const slugify = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

async function sha256(text: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const publicBoard = ({ keyHash, ...board }: StoredBoard, host: Host): Board => ({ ...board, locked: !!keyHash, ...(host.durable ? {} : { temporary: true }) });

/** The one board this tool has. It is created the first time anyone opens it. */
async function loadBoard(kv: KV): Promise<StoredBoard> {
  const raw = await kv.get(BOARD_KEY);
  if (raw) return JSON.parse(raw) as StoredBoard;
  const board: StoredBoard = { claimId: CLAIM.id, name: CLAIM.name, slug: CLAIM.slug, region: '', pushes: [] };
  await saveBoard(kv, board);
  return board;
}

const saveBoard = (kv: KV, board: StoredBoard) => kv.put('board:' + board.claimId, JSON.stringify(board));

/** A locked board only accepts changes that come with its password. */
async function mayEdit(board: StoredBoard, key: string | undefined) {
  if (!board.keyHash) return true;
  return !!key && (await sha256(board.claimId + ':' + key)) === board.keyHash;
}

/** Keeps only well-formed fields, so nothing odd is ever stored or served back. */
function cleanPush(input: any, slug: string, previous?: Push): Push | string {
  const name = String(input?.name ?? '').trim().slice(0, 80);
  if (!name) return 'A push needs a name.';
  const kinds: PushKind[] = ['claim-tier', 'tool-push', 'traveler', 'custom'];
  const statuses: PushStatus[] = ['active', 'planned', 'done'];
  const goals = (Array.isArray(input.goals) ? input.goals : [])
    .filter((g: any) => REF.test(g?.id) && Number.isFinite(g?.qty) && g.qty > 0 && g.qty <= 1e7)
    .slice(0, 300)
    .map((g: any) => ({ id: String(g.id), qty: Math.round(g.qty) }));
  const routes: Record<string, string | null> = {};
  for (const [id, recipe] of Object.entries(input.routes ?? {}).slice(0, 500)) {
    if (REF.test(id) && (recipe === null || /^[a-z]\d{1,12}$/.test(String(recipe)))) routes[id] = recipe as string | null;
  }
  const assignments: Record<string, string[]> = {};
  for (const [id, people] of Object.entries(input.assignments ?? {}).slice(0, 600)) {
    if (!REF.test(id) || !Array.isArray(people)) continue;
    const members = [...new Set(people.map(String).filter((p) => ID.test(p) || p === BUY_ORDER))].slice(0, 20);
    if (members.length) assignments[id] = members;
  }
  const now = new Date().toISOString();
  const status: PushStatus = statuses.includes(input.status) ? input.status : 'active';
  return {
    slug,
    name,
    kind: kinds.includes(input.kind) ? input.kind : 'custom',
    status,
    note: String(input.note ?? '').slice(0, 600) || undefined,
    goals,
    players: (Array.isArray(input.players) ? input.players : []).map(String).filter((p: string) => ID.test(p)).slice(0, 60),
    // Only pushes that already keep these lists get them; older pushes go on exactly as they were.
    leftOut: Array.isArray(input.leftOut) ? [...new Set(input.leftOut.map(String).filter((p: string) => ID.test(p)))].slice(0, 60) as string[] : undefined,
    excluded: (Array.isArray(input.excluded) ? input.excluded : []).map(String).filter((x: string) => /^[bph][\d:]{1,60}$/.test(x)).slice(0, 400),
    excludedNames: Array.isArray(input.excludedNames)
      ? [...new Set(input.excludedNames.map((n: unknown) => String(n).trim().slice(0, 60)).filter(Boolean))].slice(0, 100) as string[]
      : undefined,
    routes,
    countCrafts: input.countCrafts !== false,
    assignments,
    // The day it was marked complete is set here, never taken from the page. It stays put however
    // often a finished push is saved again, and goes when the push is reopened.
    completedAt: status === 'done' ? (previous?.status === 'done' ? (previous.completedAt ?? previous.updatedAt) : now) : undefined,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
}

/** Everything under /boards/:slug is for the one claim; any other name simply does not exist. */
const notOurs = (slug: string) => slug !== CLAIM.slug;
const NO_BOARD = { error: `This tool only tracks ${CLAIM.name}.` };
const LOCKED = { error: 'This board is locked. Enter its password to make changes.' };

export function createApp<E extends Env = Env>(hostOf: (c: Context<E, any, any>) => Host) {
  const app = new Hono<E>();
  const api = app.basePath(API);

  // ---- live game data (the claim and its members only) ----------------------------

  api.get('/claim', async (c) => c.json(await claimDetail(hostOf(c).memo, CLAIM.id)));

  api.get('/stock', async (c) => {
    // Ids that are not members of the claim are dropped inside stockSnapshot.
    const players = (c.req.query('players') ?? '').split(',').filter((p) => ID.test(p)).slice(0, 60);
    // fresh=1 is someone pressing refresh; the snapshot still has to be old enough before Bitjita is asked again.
    return c.json(await stockSnapshot(hostOf(c).memo, CLAIM.id, players, c.req.query('fresh') === '1'));
  });

  /** How hard this server has been leaning on Bitjita. */
  api.get('/status', (c) => c.json(usage()));

  /** For the host's "is it up" check. Touches nothing outside this process. */
  api.get('/health', (c) => {
    const host = hostOf(c);
    return c.json({ ok: true, storage: host.storage, keepsPushes: host.durable });
  });

  // ---- the board and its pushes ---------------------------------------------------

  api.get('/boards/:slug', async (c) => {
    if (notOurs(c.req.param('slug'))) return c.json(NO_BOARD, 404);
    const host = hostOf(c);
    return c.json(publicBoard(await loadBoard(host.store), host));
  });

  api.put('/boards/:slug/pushes/:push', async (c) => {
    if (notOurs(c.req.param('slug'))) return c.json(NO_BOARD, 404);
    const host = hostOf(c);
    const board = await loadBoard(host.store);
    if (!(await mayEdit(board, c.req.header('x-edit-key')))) return c.json(LOCKED, 403);

    const body = await c.req.json().catch(() => null);
    const wanted = c.req.param('push');
    const index = board.pushes.findIndex((p) => p.slug === wanted);
    let slug = wanted;
    if (index < 0) {
      // New push: its address comes from its name, with a number if that name is taken
      // (by another push, or by a page of the site such as /nowhere/travelers).
      const base = slugify(String(body?.name ?? '')) || 'push';
      slug = base;
      for (let n = 2; RESERVED_SLUGS.includes(slug) || board.pushes.some((p) => p.slug === slug); n++) slug = `${base}-${n}`;
      if (board.pushes.length >= 200) return c.json({ error: 'This board is full. Remove an old push first.' }, 400);
    }
    const push = cleanPush(body, slug, board.pushes[index]);
    if (typeof push === 'string') return c.json({ error: push }, 400);
    if (index < 0) board.pushes.unshift(push);
    else board.pushes[index] = push;
    await saveBoard(host.store, board);
    return c.json({ board: publicBoard(board, host), push });
  });

  api.delete('/boards/:slug/pushes/:push', async (c) => {
    if (notOurs(c.req.param('slug'))) return c.json(NO_BOARD, 404);
    const host = hostOf(c);
    const board = await loadBoard(host.store);
    if (!(await mayEdit(board, c.req.header('x-edit-key')))) return c.json(LOCKED, 403);
    board.pushes = board.pushes.filter((p) => p.slug !== c.req.param('push'));
    await saveBoard(host.store, board);
    return c.json(publicBoard(board, host));
  });

  /** Sets, changes or removes the board's edit password. */
  api.post('/boards/:slug/lock', async (c) => {
    if (notOurs(c.req.param('slug'))) return c.json(NO_BOARD, 404);
    const host = hostOf(c);
    const board = await loadBoard(host.store);
    if (!(await mayEdit(board, c.req.header('x-edit-key')))) return c.json({ error: 'That password does not match.' }, 403);
    const { key } = await c.req.json<{ key?: string }>().catch(() => ({ key: undefined }));
    if (key && key.length > 100) return c.json({ error: 'That password is too long.' }, 400);
    board.keyHash = key ? await sha256(board.claimId + ':' + key) : undefined;
    await saveBoard(host.store, board);
    return c.json(publicBoard(board, host));
  });

  /** Checks a password without changing anything, so the site can say "unlocked" up front. */
  api.post('/boards/:slug/unlock', async (c) => {
    if (notOurs(c.req.param('slug'))) return c.json(NO_BOARD, 404);
    const board = await loadBoard(hostOf(c).store);
    return (await mayEdit(board, c.req.header('x-edit-key'))) ? c.json({ ok: true }) : c.json({ error: 'That password does not match.' }, 403);
  });

  // Anything else under the API is a wrong address, never the site's own page.
  api.all('/*', (c) => c.json({ error: 'Not found.' }, 404));

  app.onError((err, c) => {
    if (err instanceof UpstreamError) {
      const message = err.status === 429 ? 'Giving the game data service a breather. Try again in a minute.' : 'Could not reach the game data service just now.';
      return c.json({ error: message }, err.status as 429 | 502);
    }
    console.error(err);
    return c.json({ error: 'Something went wrong on our side.' }, 500);
  });

  return app;
}
