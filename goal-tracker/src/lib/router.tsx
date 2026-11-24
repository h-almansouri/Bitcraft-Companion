import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react';

/** Tiny history-based router: the address bar is the state, e.g. /nowhere/claim-t5-push. */
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  window.addEventListener('popstate', fn);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('popstate', fn);
  };
};

export function navigate(to: string, options: { replace?: boolean } = {}) {
  if (to === window.location.pathname + window.location.search) return;
  if (options.replace) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  listeners.forEach((fn) => fn());
  if (!options.replace) window.scrollTo(0, 0);
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

export function useQuery(): URLSearchParams {
  const search = useSyncExternalStore(subscribe, () => window.location.search);
  return new URLSearchParams(search);
}

/** Sets or clears one ?key=value without adding a history entry for every click. */
export function setQuery(key: string, value: string | null, options: { push?: boolean } = {}) {
  const params = new URLSearchParams(window.location.search);
  if (value === null || value === '') params.delete(key);
  else params.set(key, value);
  const search = params.toString();
  navigate(window.location.pathname + (search ? '?' + search : ''), { replace: !options.push });
}

export function Link({ to, onClick, ...rest }: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const handle = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={handle} {...rest} />;
}
