import { useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, ChevronRight, Compass, House, LayoutList, Menu, MessageCircle } from 'lucide-react';
import { api } from './lib/api.ts';
import { putBoard, useCachedBoard } from './lib/boards.ts';
import { CLAIM, DISCORD_URL, HOME } from './lib/claim.ts';
import { useLoad } from './lib/hooks.ts';
import { Link, usePath } from './lib/router.tsx';
import type { Board, PushStatus } from './lib/shapes.ts';
import { IconButton, SectionLabel, cx } from './ui/kit.tsx';
import { AboutPage } from './pages/AboutPage.tsx';
import { BoardPage } from './pages/BoardPage.tsx';
import { PushPage } from './pages/PushPage.tsx';
import { Travelers } from './pages/Travelers.tsx';
import { UnlockHost } from './ui/unlock.tsx';

export const APP_NAME = 'Goal Tracker';
const TRAVELERS = HOME + '/travelers';
const PUSHES = HOME + '/pushes';

const STATUS_DOT: Record<PushStatus, string> = { active: 'bg-accent', planned: 'bg-warn', done: 'bg-good' };

/** On every page: bottom of the sidebar on wide screens, bottom of the page on narrow ones. */
const DISCLAIMER = 'Not affiliated with Clockwork Labs.';

/** Which screen an address points at. Anything unrecognised falls back to the claim's front page. */
type Route = { page: 'about' } | { page: 'pushes' } | { page: 'push'; slug: string } | { page: 'travelers' };
function routeOf(path: string): Route {
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== CLAIM.slug || !parts[1]) return { page: 'about' };
  // These names are kept from pushes (RESERVED_SLUGS), so they are never someone's push.
  if (parts[1] === 'pushes') return { page: 'pushes' };
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
        <img src={HOME + '/logo.png'} alt="" aria-hidden="true" width={36} height={36} className="h-9 w-9 shrink-0 rounded-full" />
        <span className="min-w-0">
          <span className="block truncate font-display text-[17px] font-semibold leading-tight text-ink">{CLAIM.name}</span>
          <span className="block text-[11px] leading-tight text-muted">{APP_NAME}</span>
        </span>
      </Link>

      <nav className="flex-1 overflow-y-auto pb-6" aria-label="Main">
        {/* A plain link: the Companion's home is outside this site, so it is a full page load. */}
        <a
          href="/"
          className="mt-3 flex h-9 items-center gap-2.5 border-l-2 border-transparent pl-[18px] pr-3 text-[13px] text-ink-2 no-underline transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <span className="flex w-4 shrink-0 justify-center">
            <ArrowLeft size={15} />
          </span>
          <span className="min-w-0 flex-1 truncate">Bitcraft Companion</span>
        </a>
        <a
          href={DISCORD_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex h-9 items-center gap-2.5 border-l-2 border-transparent pl-[18px] pr-3 text-[13px] text-ink-2 no-underline transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <span className="flex w-4 shrink-0 justify-center">
            <MessageCircle size={15} />
          </span>
          <span className="min-w-0 flex-1 truncate">Join us on Discord</span>
        </a>
        <SectionLabel className="px-5 pb-2 pt-4">Claim</SectionLabel>
        <NavItem to={HOME} active={route.page === 'about'} icon={<House size={15} />} onNavigate={onNavigate}>
          About {CLAIM.name}
        </NavItem>
        <NavItem to={PUSHES} active={route.page === 'pushes'} icon={<LayoutList size={15} />} onNavigate={onNavigate}>
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
            <SectionLabel className="px-5 pb-2 pt-6">Completed</SectionLabel>
            {done.map(pushLink)}
          </>
        )}
      </nav>
      <p className="shrink-0 border-t border-line px-5 py-3 text-[11px] leading-snug text-muted">{DISCLAIMER}</p>
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

  const title = route.page === 'travelers' ? 'Traveler restock' : route.page === 'about' ? `About ${CLAIM.name}` : 'Pushes';
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
                <Link to={PUSHES} className="shrink-0 font-normal text-ink-2 no-underline hover:text-ink">
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
        <footer className="px-3 pb-5 text-[11px] text-muted sm:px-5 lg:hidden">{DISCLAIMER}</footer>
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
      {route.page === 'about' ? (
        <AboutPage />
      ) : route.page === 'travelers' ? (
        <Travelers />
      ) : route.page === 'push' ? (
        <PushPage slug={CLAIM.slug} pushSlug={route.slug} />
      ) : (
        <BoardPage slug={CLAIM.slug} />
      )}
      <UnlockHost />
    </Shell>
  );
}
