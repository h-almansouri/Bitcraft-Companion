import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../lib/api.ts';
import { ago } from '../lib/format.ts';
import { useLoad, type Loaded } from '../lib/hooks.ts';
import { AUTO_REFRESH_MINUTES, dueForAutoRead } from '../lib/refresh.ts';
import type { StockSnapshot } from '../lib/shapes.ts';
import { IconButton, cx } from './kit.tsx';

/** Storage older than this is flagged: the page was in the background, or newer reads have been failing. */
const STALE_MINUTES = 20;
/** How often a page looks at the clock to see whether its storage is due. Looking costs nothing. */
const CHECK_EVERY_MS = 60_000;

/**
 * Loads the claim's storage for the page: when it opens, when the person presses
 * refresh, and by itself once the read on screen is 15 minutes old. The automatic
 * ask only happens while the page is actually on screen, and it never forces a new
 * read (see lib/refresh.ts), so a forgotten tab costs Bitjita nothing.
 */
export function useStock(key: string | null, players: string[]): Loaded<StockSnapshot> & { refresh: () => void } {
  const wantFresh = useRef(false);
  const stock = useLoad<StockSnapshot>(key, () => {
    const fresh = wantFresh.current;
    wantFresh.current = false;
    return api.stock(players, fresh);
  });
  const { reload } = stock;

  // When this page last asked without a newer read coming back. Opening the page is an ask.
  const asked = useRef(Date.now());
  const at = stock.data?.at ?? null;
  const readAt = useRef<string | null>(null);
  readAt.current = at;
  useEffect(() => {
    asked.current = Date.now();
  }, [key]);
  useEffect(() => {
    // A newer read arrived, so the 15 minutes are counted from its own time.
    if (at) asked.current = 0;
  }, [at]);

  useEffect(() => {
    if (key === null) return;
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      const read = readAt.current ? new Date(readAt.current).getTime() : null;
      if (!dueForAutoRead(Date.now(), read, asked.current)) return;
      asked.current = Date.now();
      reload(true);
    };
    const timer = setInterval(check, CHECK_EVERY_MS);
    // Coming back to the tab after a while catches up straight away.
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
  return { ...stock, refresh };
}

/** "Storage read 6 min ago" plus the refresh button. The wording keeps itself current without touching the network. */
export function StorageRead({ stock }: { stock: Loaded<StockSnapshot> & { refresh: () => void } }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);
  const at = stock.data?.at;
  const stale = at ? Date.now() - new Date(at).getTime() > STALE_MINUTES * 60_000 : false;
  return (
    <>
      <span
        className={cx('hidden text-xs sm:inline', stale ? 'text-warn' : 'text-muted')}
        title={stale ? 'This is getting old. Press refresh for a newer read.' : `Read again every ${AUTO_REFRESH_MINUTES} minutes while this page is on screen.`}
      >
        {at ? `Storage read ${ago(at)}` : ''}
      </span>
      <IconButton label="Read storage again. To go easy on the data service this fetches a new copy at most every 5 minutes." onClick={stock.refresh}>
        <RefreshCw size={15} className={stock.loading ? 'animate-spin' : ''} />
      </IconButton>
    </>
  );
}
