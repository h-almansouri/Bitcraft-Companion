import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../lib/api.ts';
import { ago } from '../lib/format.ts';
import { useLoad, type Loaded } from '../lib/hooks.ts';
import { LIVE_REFRESH_SECONDS, dueForAutoRead, showsLive } from '../lib/refresh.ts';
import type { StockSnapshot } from '../lib/shapes.ts';
import { IconButton, cx } from './kit.tsx';

/** Storage read the older way and older than this is flagged: newer reads have been failing. */
const STALE_MINUTES = 20;
/** How often a page looks at the clock to see whether it is time to ask again. Looking costs nothing. */
const CHECK_EVERY_MS = 1_000;

export interface Stock extends Loaded<StockSnapshot> {
  /** Ask for a newer read now. It only matters while the server is reading the older way. */
  refresh: () => void;
  /** When the server last answered this page, in milliseconds (0 before the first answer). */
  answeredAt: number;
}

/**
 * Loads the claim's storage for the page and keeps it live: it asks when the page opens
 * and again every 15 seconds, only while the page is actually on screen (a forgotten tab
 * asks for nothing).
 *
 * The answer comes from the server's one relay connection (server/live.ts): it is the game
 * as it stands, already in the server's memory, so asking costs the relay nothing. When no
 * relay can be reached the server reads the older way and shares one read for 15 minutes,
 * however often pages ask (see lib/refresh.ts).
 */
export function useStock(key: string | null, players: string[]): Stock {
  const wantFresh = useRef(false);
  const [answeredAt, setAnsweredAt] = useState(0);
  const shown = useRef<{ key: string | null; snapshot: StockSnapshot; text: string } | null>(null);
  const stock = useLoad<StockSnapshot>(key, async () => {
    const fresh = wantFresh.current;
    wantFresh.current = false;
    const next = await api.stock(players, fresh);
    setAnsweredAt(Date.now());
    // Most looks find that nothing has changed. Handing back the very same snapshot then means
    // nothing worked out from it (the whole plan of a push) is worked out again. A live answer is
    // stamped with the moment it was given, so that stamp is left out of the comparison.
    const text = JSON.stringify(next.live ? { ...next, at: '' } : next);
    if (shown.current?.key === key && shown.current.text === text) return shown.current.snapshot;
    shown.current = { key, snapshot: next, text };
    return next;
  });
  const { reload } = stock;

  // When this page last asked. Opening the page is an ask.
  const asked = useRef(Date.now());
  useEffect(() => {
    asked.current = Date.now();
  }, [key]);

  useEffect(() => {
    if (key === null) return;
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      if (!dueForAutoRead(Date.now(), asked.current)) return;
      asked.current = Date.now();
      reload(true);
    };
    const timer = setInterval(check, CHECK_EVERY_MS);
    // Coming back to the tab catches up straight away.
    document.addEventListener('visibilitychange', check);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
    };
  }, [key, reload]);

  const refresh = () => {
    wantFresh.current = true;
    asked.current = Date.now();
    reload(true);
  };
  return { ...stock, refresh, answeredAt };
}

/**
 * A small "Live" marker while the page is being kept current by itself. When it is not
 * (no relay can be reached, or this page's asks are not getting through) it falls back to
 * "Storage read 6 min ago" and a refresh button.
 */
export function StorageRead({ stock }: { stock: Loaded<StockSnapshot> & { refresh: () => void; answeredAt?: number } }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 10_000);
    return () => clearInterval(timer);
  }, []);
  const snapshot = stock.data;
  // (Pages that pass the storage down through their own props keep `answeredAt` on it without naming it.)
  const answeredAt = stock.answeredAt ?? 0;
  if (!snapshot && stock.loading) return null;

  if (showsLive(Date.now(), snapshot?.live, answeredAt)) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-good" title={`Straight from the game. This page updates by itself every ${LIVE_REFRESH_SECONDS} seconds while it is on screen.`}>
        <span className="h-1.5 w-1.5 rounded-full bg-good" aria-hidden="true" />
        Live
      </span>
    );
  }

  // A live answer says when it was given; one read the older way says when storage was read.
  const readAt = snapshot ? (snapshot.live ? answeredAt : new Date(snapshot.at).getTime()) : 0;
  const stale = readAt ? Date.now() - readAt > STALE_MINUTES * 60_000 : false;
  return (
    <>
      <span
        className={cx('hidden text-xs sm:inline', stale ? 'text-warn' : 'text-muted')}
        title={stale ? 'This is getting old. Press refresh for a newer read.' : 'Not live right now. Storage is being read the slower way, at most every 15 minutes.'}
      >
        {readAt ? `Storage read ${ago(new Date(readAt).toISOString())}` : ''}
      </span>
      <IconButton label="Read storage again. To go easy on the data service this fetches a new copy at most every 5 minutes." onClick={stock.refresh}>
        <RefreshCw size={15} className={stock.loading ? 'animate-spin' : ''} />
      </IconButton>
    </>
  );
}
