import { useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { chestNickname, isLeftOut } from '../../lib/derive.ts';
import { num, plural } from '../../lib/format.ts';
import type { StockLocation } from '../../lib/shapes.ts';
import { Card, Empty, TierChip, cx } from '../../ui/kit.tsx';
import type { PushScope } from '../PushPage.tsx';

/** Every chest, bank stash, cart and bag being counted, with a switch to leave any of them out. */
export function StorageTab({ scope }: { scope: PushScope }) {
  const { snapshot, push, view, ctx, save, openItem } = scope;
  const [busy, setBusy] = useState<string | null>(null);

  const groups = useMemo(() => {
    const map = new Map<string, { kind: StockLocation['kind']; list: StockLocation[] }>();
    for (const loc of snapshot?.locations ?? []) {
      const group = map.get(loc.owner);
      if (group) group.list.push(loc);
      else map.set(loc.owner, { kind: loc.kind, list: [loc] });
    }
    // The claim's own storage first, then people by name.
    return [...map].sort((a, b) => Number(a[1].kind !== 'claim') - Number(b[1].kind !== 'claim') || a[0].localeCompare(b[0]));
  }, [snapshot]);

  if (!snapshot) return <Empty title="Storage has not loaded yet" />;

  // A named claim chest is also left out by its nickname, so it stays out after being rebuilt or upgraded.
  const toggle = async (loc: StockLocation) => {
    setBusy(loc.id);
    const nickname = chestNickname(loc);
    const turningOff = !isLeftOut(loc, push);
    const excluded = push.excluded.filter((id) => id !== loc.id);
    const excludedNames = (push.excludedNames ?? []).filter((n) => n.trim().toLowerCase() !== nickname);
    if (turningOff) {
      excluded.push(loc.id);
      if (nickname) excludedNames.push(loc.name.trim());
    }
    try {
      await save({ excluded, excludedNames });
    } catch {
      /* the page shows the error */
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-7">
      <p className="text-sm text-ink-2">
        These are the places being counted. Switch one off to leave it out of this push, for example a chest that holds another project's materials. Choose whose personal storage counts in
        Setup.
      </p>
      {groups.map(([owner, group]) => (
        <section key={owner}>
          <h2 className="text-[15px] font-semibold">
            {owner}
            <span className="ml-2 text-[13px] font-normal text-ink-2">{group.kind === 'claim' ? 'claim storage' : 'personal storage'}</span>
          </h2>
          <Card className="mt-2.5 divide-y divide-line">
            {group.list.map((loc) => {
              const relevant = loc.items.filter(([id]) => view.rows.has(id)).sort((a, b) => b[1] - a[1]);
              const off = isLeftOut(loc, push);
              const fixed = loc.id === 'built';
              return (
                <details key={loc.id} className="group">
                  <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
                    <ChevronDown size={15} className="-rotate-90 text-muted transition-transform group-open:rotate-0" />
                    <div className={cx('min-w-0 flex-1', off && 'opacity-50')}>
                      <div className="truncate text-sm font-medium">{loc.name}</div>
                      <div className="truncate text-xs text-ink-2">
                        {[loc.detail, `${relevant.length} ${plural(relevant.length, 'thing')} this push uses`, `${loc.items.length} ${plural(loc.items.length, 'kind')} of item in total`].filter(Boolean).join(' · ')}
                      </div>
                    </div>
                    {!fixed && (
                      <label className="flex items-center gap-2 text-[13px] text-ink-2" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" checked={!off} disabled={busy === loc.id} onChange={() => toggle(loc)} className="h-4 w-4 accent-[var(--accent)]" />
                        Count it
                      </label>
                    )}
                  </summary>
                  <div className="px-4 pb-3 pl-11">
                    {relevant.length === 0 ? (
                      <p className="text-[13px] text-ink-2">Nothing in here is needed for this push.</p>
                    ) : (
                      <ul className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
                        {relevant.map(([id, qty]) => {
                          const thing = ctx.book.thing(id);
                          return (
                            <li key={id}>
                              <button type="button" onClick={() => openItem(id)} className="flex w-full items-center gap-2 text-left text-[13px] hover:underline">
                                <TierChip tier={thing?.tier ?? 0} />
                                <span className="min-w-0 flex-1 truncate">{thing?.name ?? id}</span>
                                <span className="num font-semibold">{num(qty)}</span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                </details>
              );
            })}
          </Card>
        </section>
      ))}
      {groups.length === 0 && <Empty title="No storage found">Bitjita returned no chests or bags for this claim.</Empty>}
    </div>
  );
}
