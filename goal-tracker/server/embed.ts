/**
 * How the Goal Tracker runs inside the Companion app.
 *
 * The Companion's own server (proxy.js, one folder up) loads the built copy of this
 * file, dist/server.mjs, the first time someone opens an address under /nowhere, and
 * hands every such request to the function `start` returns. That one function serves
 * the built site (dist/client), the game data (public/gamedata.json) and the API
 * (/nowhere/api/…). Nothing here listens on a port of its own.
 *
 *   npm run build   builds the site and this file into dist/, which is committed:
 *                   the host runs the Companion with no build step and no packages.
 *
 * Where the board is kept is chosen from the environment, best first:
 *
 *   DATABASE_URL  a Postgres address. Use this on hosts whose files vanish on
 *                 restart (Render's free web services).
 *   DATA_DIR      a folder on a disk that survives restarts (a Render persistent
 *                 disk's mount path).
 *   neither       the folder the Companion gives us (its data/goal-tracker). Fine on
 *                 your own computer; on a host without a real disk the pushes are
 *                 lost at every restart, and the site says so.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { BOARD_KEY, createApp, type Host, type KV } from './app.ts';
import { factsFrom, liveSource, type GameFacts } from './live.ts';
import { connectPostgres, fileStore, memoryMemo, postgresStore } from './storage.ts';
import { CLAIM, HOME } from '../src/lib/claim.ts';

export interface Options {
  /** This project's folder: dist/client, public and seed are found inside it. */
  root: string;
  /** Where the board goes when neither DATABASE_URL nor DATA_DIR is set. */
  dataDir: string;
}

async function chooseStore(dataDir: string): Promise<Pick<Host, 'store' | 'durable' | 'storage'>> {
  const url = process.env.DATABASE_URL?.trim();
  if (url) return { store: await postgresStore(await connectPostgres(url)), durable: true, storage: 'postgres' };
  const dir = process.env.DATA_DIR?.trim();
  if (dir) return { store: await fileStore(dir), durable: true, storage: 'disk' };
  // RENDER is set by Render itself. With no database and no disk there, nothing written survives a restart.
  const hosted = !!process.env.RENDER;
  return { store: await fileStore(dataDir), durable: !hosted, storage: hosted ? 'temporary' : 'local-folder' };
}

/** A board saved with `npm run export-board` travels in the repository and fills an empty store. */
async function seed(store: KV, file: string) {
  if ((await store.get(BOARD_KEY)) !== null || !existsSync(file)) return false;
  const board = JSON.parse(readFileSync(file, 'utf8'));
  // Never carry a password or host-specific flags over from wherever it was exported.
  delete board.keyHash;
  delete board.locked;
  delete board.temporary;
  await store.put(BOARD_KEY, JSON.stringify(board));
  return true;
}

const isFile = (address: string) => /\.[a-z0-9]+$/i.test(address);

/** Sets the site up and returns what answers one request (Node's own request and response). */
export async function start({ root, dataDir }: Options) {
  const site = path.join(root, 'dist', 'client');
  if (!existsSync(path.join(site, 'index.html'))) throw new Error(`No built site at ${site}. Run "npm run build" in ${root} first.`);
  const page = readFileSync(path.join(site, 'index.html'), 'utf8');

  const chosen = await chooseStore(dataDir);
  const seeded = await seed(chosen.store, path.join(root, 'seed', 'board.json'));
  // Live numbers come over one connection to a relay: Bitjita's, or BitCraftSync's while that one
  // cannot be reached (server/relay.ts). GOAL_TRACKER_RELAY=off
  // goes back to fetching only. The game data it needs is read from disk the first time it is used.
  let facts: GameFacts | undefined;
  const live =
    process.env.GOAL_TRACKER_RELAY?.trim().toLowerCase() === 'off'
      ? undefined
      : liveSource({ claimId: CLAIM.id, facts: async () => (facts ??= factsFrom(JSON.parse(readFileSync(path.join(root, 'public', 'gamedata.json'), 'utf8')))) });
  const host: Host = { ...chosen, memo: memoryMemo(), live };

  const app = new Hono();
  app.use(compress());
  app.route('/', createApp(() => host));

  // Friendly addresses like /nowhere/claim-t5-push are pages of the single-page site. The page
  // names its scripts by their contents, so it is always checked for a newer copy.
  app.get('*', (c, next) => (isFile(c.req.path) ? next() : c.html(page, 200, { 'Cache-Control': 'no-cache' })));

  // Everything else is a file: the built site first, then public/ (the game data, which
  // is served from where `npm run gamedata` writes it rather than copied into every build).
  for (const folder of [site, path.join(root, 'public')]) {
    app.use(
      '*',
      serveStatic({
        root: folder,
        rewriteRequestPath: (address) => address.slice(HOME.length),
        onFound: (file, c) => {
          // Files under /assets have their contents in their name, so they can be kept for good.
          c.header('Cache-Control', /[\\/]assets[\\/]/.test(file) ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
        },
      }),
    );
  }
  // A missing file (an old script name after an update) falls through to a 404, so a browser never gets the page in place of a script.

  console.log(`Goal Tracker ready at ${HOME}. Board storage: ${host.storage}${seeded ? ' (filled from seed/board.json)' : ''}. Live numbers: ${live ? 'one relay connection (relay.bitjita.com, or relay.bitcraftsync.app as its stand-in), opened when a page asks' : 'fetched (relay turned off)'}.`);
  if (!host.durable) console.warn('Goal Tracker: no DATABASE_URL or DATA_DIR is set, so pushes will be lost whenever this server restarts.');
  return getRequestListener(app.fetch);
}
