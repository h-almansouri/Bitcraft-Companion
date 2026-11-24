import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';
import { Lock } from 'lucide-react';
import { ApiError, api, onKeyChange, rememberKey, savedKey } from '../lib/api.ts';
import type { Board } from '../lib/shapes.ts';
import { Button, Card, Field, Modal, Notice, inputClass } from './kit.tsx';

/**
 * Boards can be password-protected. Any change goes through `guarded`: if the
 * server says the board is locked, the person is asked for the password once,
 * it is remembered on this device, and the change is retried.
 *
 * The same password opens the parts of a push that change it for everyone
 * (Storage and Setup). Those are shown as locked to anyone who has not typed it.
 */
type Ask = { slug: string; wrong: boolean; resolve: (key: string | null) => void };
let present: ((ask: Ask | null) => void) | null = null;

const askPassword = (slug: string, wrong: boolean) =>
  new Promise<string | null>((resolve) => {
    if (!present) return resolve(null);
    present({ slug, wrong, resolve });
  });

export async function guarded<T>(slug: string, action: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await action();
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 403) throw err;
      const key = await askPassword(slug, attempt > 0);
      if (key === null) throw new ApiError(403, 'This board is locked, so nothing was changed.');
      rememberKey(slug, key);
    }
  }
}

export interface Access {
  /** A password has been set on the board. */
  locked: boolean;
  /** This device may change things: no password is set, or the right one has been typed here. */
  allowed: boolean;
  /** Still asking the server whether the remembered password is right. */
  checking: boolean;
}

/** Whether this device may change the board. The server decides; this only asks it. */
export function useAccess(board: Pick<Board, 'slug' | 'locked'> | null): Access {
  const slug = board?.slug ?? '';
  const locked = !!board?.locked;
  const key = useSyncExternalStore(onKeyChange, () => (slug ? savedKey(slug) : ''));
  const [checked, setChecked] = useState<{ key: string; ok: boolean } | null>(null);

  useEffect(() => {
    if (!locked || !key) return;
    let current = true;
    api.unlock(slug).then(
      () => current && setChecked({ key, ok: true }),
      () => current && setChecked({ key, ok: false }),
    );
    return () => {
      current = false;
    };
  }, [locked, key, slug]);

  if (!locked) return { locked: false, allowed: true, checking: false };
  if (!key) return { locked: true, allowed: false, checking: false };
  const answer = checked && checked.key === key ? checked.ok : null;
  return { locked: true, allowed: answer === true, checking: answer === null };
}

/** Shown in place of a locked part of the page: says why, and takes the password. */
export function LockedPanel({ slug, what }: { slug: string; what: string }) {
  const [value, setValue] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!value || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      // Checked first and only remembered if right; `useAccess` then opens this part by itself.
      await api.unlock(slug, value);
      rememberKey(slug, value);
    } catch (err) {
      setProblem(err instanceof ApiError && err.status === 403 ? 'That password does not match. Try again.' : (err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Card className="mx-auto max-w-md px-5 py-6">
      <div className="flex items-center gap-2 text-[15px] font-semibold">
        <Lock size={16} className="text-accent-ink" />
        {what} is locked
      </div>
      <p className="mt-2 text-sm text-ink-2">This part changes the push for everyone, so it needs the board password. Everything else is open to look at.</p>
      <form onSubmit={submit} className="mt-4 space-y-3">
        {problem && <Notice tone="bad">{problem}</Notice>}
        <Field label="Board password">
          <input type="password" autoComplete="off" aria-label="Board password" className={inputClass} value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        <div className="flex justify-end">
          <Button variant="primary" type="submit" disabled={!value || busy}>
            Unlock
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function UnlockHost() {
  const [ask, setAsk] = useState<Ask | null>(null);
  const [value, setValue] = useState('');
  useEffect(() => {
    present = (next) => {
      setValue('');
      setAsk(next);
    };
    return () => {
      present = null;
    };
  }, []);

  const finish = (key: string | null) => {
    ask?.resolve(key);
    setAsk(null);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value) finish(value);
  };

  return (
    <Modal open={!!ask} onClose={() => finish(null)} title="This board is locked">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-ink-2">Anyone can look, but changes need the board password. Ask whoever set it up.</p>
        {ask?.wrong && <Notice tone="bad">That password does not match. Try again.</Notice>}
        <Field label="Board password">
          <input autoFocus type="password" className={inputClass} value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => finish(null)}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={!value}>
            Unlock
          </Button>
        </div>
      </form>
    </Modal>
  );
}
