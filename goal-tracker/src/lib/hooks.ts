import { useCallback, useEffect, useRef, useState } from 'react';

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  status: number;
  loading: boolean;
  /** Fetch again. Pass true to keep showing the current data while it loads. */
  reload: (quiet?: boolean) => void;
  /** Replace the data in place (after a save returns the new version). */
  set: (data: T) => void;
}

/** Runs an async loader whenever `key` changes. A null key means "nothing to load yet". */
export function useLoad<T>(key: string | null, loader: () => Promise<T>, refreshMs?: number): Loaded<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; status: number; loading: boolean }>({ data: null, error: null, status: 0, loading: key !== null });
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const run = useRef(0);

  const load = useCallback(
    (quiet = false) => {
      if (key === null) return;
      const mine = ++run.current;
      setState((s) => (quiet ? s : { ...s, loading: true, error: null }));
      loaderRef.current().then(
        (data) => mine === run.current && setState({ data, error: null, status: 200, loading: false }),
        (err: Error & { status?: number }) =>
          mine === run.current && setState((s) => ({ data: quiet ? s.data : null, error: err.message, status: err.status ?? 0, loading: false })),
      );
    },
    [key],
  );

  useEffect(() => {
    setState({ data: null, error: null, status: 0, loading: key !== null });
    load();
    return () => {
      run.current++;
    };
  }, [key, load]);

  useEffect(() => {
    if (!refreshMs || key === null) return;
    const timer = setInterval(() => document.visibilityState === 'visible' && load(true), refreshMs);
    return () => clearInterval(timer);
  }, [refreshMs, key, load]);

  const set = useCallback((data: T) => setState({ data, error: null, status: 200, loading: false }), []);
  return { ...state, reload: load, set };
}

/** A value remembered on this device (a chosen filter, who you are). Falls back to memory when storage is blocked. */
export function useLocal<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const update = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* kept in memory only */
      }
    },
    [key],
  );
  return [value, update];
}

export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}
