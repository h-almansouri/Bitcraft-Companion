import { useEffect, useState, type ReactNode } from 'react';
import { ChevronRight, Compass, Hexagon, LayoutList, Menu } from 'lucide-react';
import { api } from './lib/api.ts';
import { putBoard, useCachedBoard } from './lib/boards.ts';
import { CLAIM, HOME } from './lib/claim.ts';
import { useLoad } from './lib/hooks.ts';
import { Link, usePath } from './lib/router.tsx';
import type { Board, PushStatus } from './lib/shapes.ts';
import { IconButton, SectionLabel, cx } from './ui/kit.tsx';
import { BoardPage } from './pages/BoardPage.tsx';
import { PushPage } from './pages/PushPage.tsx';
import { Travelers } from './pages/Travelers.tsx';
import { UnlockHost } from './ui/unlock.tsx';

export const APP_NAME = 'Goal Tracker';
const TRAVELERS = HOME + '/travelers';

const STATUS_DOT: Record<PushStatus, string> = { active: 'bg-accent', planned: 'bg-warn', done: 'bg-muted' };

/** Which screen an address points at. Anything unrecognised falls back to the list of pushes. */
type Route = { page: 'pushes' } | { page: 'push'; slug: string } | { page: 'travelers' };
function routeOf(path: string): Route {
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== CLAIM.slug || !parts[1]) return { page: 'pushes' };
  // "travelers" is kept from pushes as a name (RESERVED_SLUGS), so this is never someone's push.
  if (parts[1] === 'travelers') return { page: 'travelers' };
  return { page: 'push', slug: parts[1] };
}

function NavItem({ to, active, icon, children, onNavigate }: { to: string; active: boolean; icon?: ReactNode; children: ReactNode; onNavigate: () => void }) {
  return (
    <Link
      to={to}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={cx(
        'flex h-9 items-center gap-2.5 border-l-2 pl-[18px] pr-3 text-[13px] no-underline transition-colors',
        active ? 'border-accent bg-accent-soft text-accent-ink' : 'border-transparent text-ink-2 hover:bg-surface-2 hover:text-ink',
      )}
    >
      {icon && <span className="flex w-4 shrink-0 justify-center">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </Link>
  );
}

function Sidebar({ route, onNavigate }: { route: Route; onNavigate: () => void }) {
  const board = useCachedBoard(CLAIM.slug);
  const pushes = board?.pushes ?? [];
  const open = pushes.filter((p) => p.status !== 'done');
  const done = pushes.filter((p) => p.status === 'done');
  const pushLink = (push: (typeof pushes)[number]) => (
    <NavItem
      key={push.slug}
      to={`${HOME}/${push.slug}`}
      active={route.page === 'push' && route.slug === push.slug}
      icon={<span className={cx('h-2 w-2 rounded-full', STATUS_DOT[push.status])} title={push.status} />}
      onNavigate={onNavigate}
    >
      {push.name}
    </NavItem>
  );

  return (
    <div className="flex h-full flex-col">
      <Link to={HOME} onClick={onNavigate} className="flex h-14 shrink-0 items-center gap-2.5 border-b border-line px-5 no-underline">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-dim text-accent-ink" aria-hidden="true">
          <Hexagon size={17} />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[15px] font-semibold leading-tight text-ink">{CLAIM.name}</span>
          <span className="block text-[11px] leading-tight text-muted">{APP_NAME}</span>
        </span>
      </Link>

      <nav className="flex-1 overflow-y-auto pb-6" aria-label="Main">
        <SectionLabel className="px-5 pb-2 pt-5">Claim</SectionLabel>
        <NavItem to={HOME} active={route.page === 'pushes'} icon={<LayoutList size={15} />} onNavigate={onNavigate}>
          All pushes
        </NavItem>
        <NavItem to={TRAVELERS} active={route.page === 'travelers'} icon={<Compass size={15} />} onNavigate={onNavigate}>
          Traveler restock
        </NavItem>

        {open.length > 0 && (
          <>
            <SectionLabel className="px-5 pb-2 pt-6">Pushes</SectionLabel>
            {open.map(pushLink)}
          </>
        )}
        {done.length > 0 && (
          <>
            <SectionLabel className="px-5 pb-2 pt-6">Finished</SectionLabel>
            {done.map(pushLink)}
          </>
        )}
      </nav>
    </div>
  );
}

function Shell({ route, children }: { route: Route; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const board = useCachedBoard(CLAIM.slug);
  const push = route.page === 'push' ? board?.pushes.find((p) => p.slug === route.slug) : undefined;

  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [open]);

  const title = route.page === 'travelers' ? 'Traveler restock' : 'Pushes';
  useEffect(() => {
    document.title = [push?.name ?? title, CLAIM.name, APP_NAME].join(' · ');
  }, [title, push?.name]);

  return (
    <div className="min-h-screen">
      {/* Always visible on wide screens; slides over the page on narrow ones. */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[232px] border-r border-line bg-surface lg:block">
        <Sidebar route={route} onNavigate={() => setOpen(false)} />
      </aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button type="button" aria-label="Close menu" className="absolute inset-0 cursor-default bg-black/60" onClick={() => setOpen(false)} />
          <aside className="relative h-full w-[260px] max-w-[85vw] border-r border-line bg-surface">
            <Sidebar route={route} onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}

      <div className="lg:pl-[232px]">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-surface px-3 sm:px-5">
          <IconButton label="Menu" className="lg:hidden" onClick={() => setOpen(true)}>
            <Menu size={18} />
          </IconButton>
          <div className="flex min-w-0 items-center gap-1.5 text-[15px] font-semibold">
            {route.page === 'push' ? (
              <>
                <Link to={HOME} className="shrink-0 font-normal text-ink-2 no-underline hover:text-ink">
                  Pushes
                </Link>
                <ChevronRight size={15} className="shrink-0 text-muted" />
                <span className="truncate">{push?.name ?? route.slug}</span>
              </>
            ) : (
              <span className="truncate">{title}</span>
            )}
          </div>
        </header>
        <main className="mx-auto max-w-[1180px] px-3 pb-24 pt-5 sm:px-5">{children}</main>
      </div>
    </div>
  );
}

export function App() {
  const route = routeOf(usePath());
  // Loaded once up front so the sidebar can list the pushes on every page.
  const board = useLoad<Board>('board', () => api.board(CLAIM.slug));
  useEffect(() => {
    if (board.data) putBoard(board.data);
  }, [board.data]);
  return (
    <Shell route={route}>
      {route.page === 'travelers' ? <Travelers /> : route.page === 'push' ? <PushPage slug={CLAIM.slug} pushSlug={route.slug} /> : <BoardPage slug={CLAIM.slug} />}
      <UnlockHost />
    </Shell>
  );
}
