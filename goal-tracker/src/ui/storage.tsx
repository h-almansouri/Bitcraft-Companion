import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../lib/api.ts';
import { ago } from '../lib/format.ts';
import { useLoad, type Loaded } from '../lib/hooks.ts';
import type { StockSnapshot } from '../lib/shapes.ts';
import { IconButton, cx } from './kit.tsx';

/** Storage older than this is flagged, since nothing refreshes it in the background. */
const STALE_MINUTES = 20;

/**
 * Loads the claim's storage once for the page. It is never re-read on a timer:
 * only when the page opens, or when `refresh` is called by the person pressing the
 * button (and the server only goes back to Bitjita if its copy is old enough).
 */
export function useStock(key: string | null, players: string[]): Loaded<StockSnapshot> & { refresh: () => void } {
  const wantFresh = useRef(false);
  const stock = useLoad<StockSnapshot>(key, () => {
    const fresh = wantFresh.current;
    wantFresh.current = false;
    return api.stock(players, fresh);
  });
  const { reload } = stock;
  const refresh = () => {
    wantFresh.current = true;
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
      <span className={cx('hidden text-xs sm:inline', stale ? 'text-warn' : 'text-muted')} title={stale ? 'This is getting old. Press refresh for a newer read.' : undefined}>
        {at ? `Storage read ${ago(at)}` : ''}
      </span>
      <IconButton label="Read storage again. To go easy on the data service this fetches a new copy at most every 5 minutes." onClick={stock.refresh}>
        <RefreshCw size={15} className={stock.loading ? 'animate-spin' : ''} />
      </IconButton>
    </>
  );
}
