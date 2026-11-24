/**
 * Storage for hosts that are not Cloudflare.
 *
 *  - `memoryMemo`: remembers Bitjita's answers in the server's own memory. Lost on
 *    restart, which only costs one fresh read.
 *  - `postgresStore`: keeps the board in a Postgres table. The right choice on a host
 *    whose files do not survive a restart (Render's free web services).
 *  - `fileStore`: keeps the board in one JSON file. Right when the host has a real
 *    disk (a Render persistent disk, a VPS, this computer).
 *  - `memoryStore`: keeps the board nowhere at all. Only for tests.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { KV } from './app.ts';
import type { Memo } from './bitjita.ts';

export function memoryMemo(maxEntries = 400): Memo {
  const kept = new Map<string, { text: string; until: number }>();
  return {
    async get(key) {
      const hit = kept.get(key);
      if (!hit) return null;
      if (hit.until <= Date.now()) {
        kept.delete(key);
        return null;
      }
      return hit.text;
    },
    set(key, text, ttlSeconds) {
      kept.delete(key);
      kept.set(key, { text, until: Date.now() + ttlSeconds * 1000 });
      if (kept.size <= maxEntries) return;
      // Too many: drop what has run out, then the oldest, so memory use stays bounded.
      const now = Date.now();
      for (const [k, v] of kept) if (v.until <= now) kept.delete(k);
      for (const k of kept.keys()) {
        if (kept.size <= maxEntries) break;
        kept.delete(k);
      }
    },
  };
}

export function memoryStore(): KV {
  const kept = new Map<string, string>();
  return {
    get: async (key) => kept.get(key) ?? null,
    put: async (key, value) => void kept.set(key, value),
    delete: async (key) => void kept.delete(key),
  };
}

/** One JSON file in `dir`. Writes go one at a time and replace the file whole, so a crash never leaves half a board. */
export async function fileStore(dir: string): Promise<KV> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'store.json');
  let data: Record<string, string> = {};
  try {
    data = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  let writing: Promise<void> = Promise.resolve();
  const flush = () => {
    writing = writing
      .catch(() => {})
      .then(async () => {
        const tmp = file + '.tmp';
        await writeFile(tmp, JSON.stringify(data));
        await rename(tmp, file);
      });
    return writing;
  };
  return {
    get: async (key) => data[key] ?? null,
    put: async (key, value) => {
      data[key] = value;
      await flush();
    },
    delete: async (key) => {
      delete data[key];
      await flush();
    },
  };
}

/** The part of a Postgres connection pool this needs, so tests can stand one in. */
export interface SqlPool {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

/** One small table, `goal_tracker_store (key, value)`, created on first use. */
export async function postgresStore(pool: SqlPool): Promise<KV> {
  await pool.query('create table if not exists goal_tracker_store (key text primary key, value text not null)');
  return {
    get: async (key) => (await pool.query('select value from goal_tracker_store where key = $1', [key])).rows[0]?.value ?? null,
    put: async (key, value) => void (await pool.query('insert into goal_tracker_store (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value', [key, value])),
    delete: async (key) => void (await pool.query('delete from goal_tracker_store where key = $1', [key])),
  };
}

/** Opens a pool on a `postgres://` address. The client library is only loaded when a database is actually used. */
export async function connectPostgres(url: string): Promise<SqlPool> {
  const { default: pg } = await import('pg');
  // Small on purpose: free database plans allow few connections, and this needs one at a time.
  return new pg.Pool({ connectionString: url, max: 3 });
}
