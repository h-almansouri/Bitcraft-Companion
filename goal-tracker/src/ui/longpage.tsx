import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from 'react';
import { ArrowUp, ChevronDown } from 'lucide-react';
import { SectionLabel, cx } from './kit.tsx';

/**
 * Pieces for the site's long one-scroll pages (General and Resources): a sticky bar that
 * jumps between sections, section headings that fold their section shut, and the gold divider
 * between sections. Also the floating back-to-top button that every page has.
 */
export type PageSection = { id: string; label: string };

let glide = 0;
/**
 * Scrolls the window to `top` in a quick, smooth glide: fast to start, easing in to land.
 * Longer trips take a little longer, but never more than about two thirds of a second.
 * Scrolling with the wheel or a finger mid-glide stops it.
 */
export function glideTo(top: number) {
  const from = window.scrollY;
  const to = Math.max(0, Math.min(top, document.documentElement.scrollHeight - window.innerHeight));
  const distance = to - from;
  const run = ++glide;
  if (Math.abs(distance) < 2) {
    window.scrollTo({ top: to, behavior: 'instant' });
    return;
  }
  const ms = Math.min(650, 280 + Math.abs(distance) * 0.05);
  const start = performance.now();
  const stop = () => {
    glide++;
  };
  window.addEventListener('wheel', stop, { once: true, passive: true });
  window.addEventListener('touchstart', stop, { once: true, passive: true });
  const step = (now: number) => {
    if (run !== glide) return;
    const t = Math.min(1, (now - start) / ms);
    const eased = 1 - Math.pow(1 - t, 3);
    window.scrollTo({ top: from + distance * eased, behavior: 'instant' });
    if (t < 1) requestAnimationFrame(step);
    else {
      window.removeEventListener('wheel', stop);
      window.removeEventListener('touchstart', stop);
    }
  };
  requestAnimationFrame(step);
}

/** Glides to a section (opening it if it was folded) without stacking up history entries. */
export function jumpTo(id: string, event?: MouseEvent) {
  const target = document.getElementById(id);
  if (!target) return;
  event?.preventDefault();
  setFolded(id, false);
  const margin = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
  glideTo(target.getBoundingClientRect().top + window.scrollY - margin);
  window.history.replaceState(null, '', '#' + id);
}

/** Opening a page at /nowhere/resources#faq lands on that section once it has rendered. */
export function useLandOnHash() {
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id) requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }));
  }, []);
}

/** Sticks under the header and lights up the section on screen. */
export function JumpBar({ sections }: { sections: readonly PageSection[] }) {
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    const seen = new Map<string, boolean>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting);
        // The first section, in page order, with any part in the band near the top of the screen.
        setCurrent(sections.find((s) => seen.get(s.id))?.id ?? null);
      },
      { rootMargin: '-120px 0px -55% 0px' },
    );
    for (const s of sections) {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [sections]);

  return (
    <nav aria-label="On this page" className="sticky top-14 z-20 -mx-3 mt-4 border-b border-line bg-bg/90 px-3 py-2 backdrop-blur sm:-mx-5 sm:px-5">
      <div className="flex gap-1.5 overflow-x-auto [scrollbar-width:none]">
        {sections.map((s) => (
          <a
            key={s.id}
            href={'#' + s.id}
            onClick={(e) => jumpTo(s.id, e)}
            aria-current={current === s.id ? 'true' : undefined}
            className={cx(
              'inline-flex h-8 shrink-0 items-center rounded-md border px-3 text-xs font-medium no-underline transition-colors',
              current === s.id ? 'border-accent bg-accent-soft text-accent-ink' : 'border-transparent text-ink-2 hover:bg-surface-2 hover:text-ink',
            )}
          >
            {s.label}
          </a>
        ))}
      </div>
    </nav>
  );
}

/** A round arrow button floating in the corner once you've scrolled a way down. It glides back to the top. */
export function BackToTop() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const check = () => setShown(window.scrollY > 600);
    check();
    window.addEventListener('scroll', check, { passive: true });
    return () => window.removeEventListener('scroll', check);
  }, []);
  const go = () => {
    glideTo(0);
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
  };
  return (
    <button
      type="button"
      aria-label="Back to top"
      title="Back to top"
      onClick={go}
      tabIndex={shown ? 0 : -1}
      className={cx(
        'fixed bottom-5 right-5 z-30 flex h-11 w-11 items-center justify-center rounded-full border border-accent bg-accent-dim text-accent-ink shadow-lg shadow-black/30 transition-all hover:bg-accent hover:text-bg',
        shown ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-3 opacity-0',
      )}
    >
      <ArrowUp size={18} />
    </button>
  );
}

/** The line between sections, with a small gold diamond in the middle. Decoration only. */
export function SectionBreak() {
  const line = (side: 'right' | 'left') => `linear-gradient(to ${side}, transparent, var(--line-2) 35%, color-mix(in oklab, var(--accent) 65%, var(--line-2)))`;
  return (
    <div aria-hidden="true" className="my-12 flex items-center gap-2.5 sm:my-16">
      <span className="h-px flex-1" style={{ background: line('right') }} />
      <span className="h-1.5 w-1.5 rotate-45 bg-accent/60" />
      <span className="h-3 w-3 rotate-45 border border-accent bg-accent-dim" />
      <span className="h-1.5 w-1.5 rotate-45 bg-accent/60" />
      <span className="h-px flex-1" style={{ background: line('left') }} />
    </div>
  );
}

/** Card and sub-section titles share the headings' serif. */
export const titleFont = 'font-display font-semibold text-ink';

/**
 * Which sections are folded shut. A tiny store rather than state, so the jump bar and the
 * cards that jump to a section can open it on the way.
 */
const folded = new Set<string>();
const foldWatchers = new Set<() => void>();
function setFolded(id: string, shut: boolean) {
  if (folded.has(id) === shut) return;
  if (shut) folded.add(id);
  else folded.delete(id);
  foldWatchers.forEach((notify) => notify());
}
function useFolded(id: string | undefined) {
  return useSyncExternalStore(
    (notify) => {
      foldWatchers.add(notify);
      return () => {
        foldWatchers.delete(notify);
      };
    },
    () => (id ? folded.has(id) : false),
  );
}

/** Heading block at the top of a section. Clicking the title folds the section shut, or opens it again. */
export function SectionHead({ id, eyebrow, title, children, extra }: { id?: string; eyebrow: string; title: string; children?: ReactNode; extra?: ReactNode }) {
  const shut = useFolded(id);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <SectionLabel>{eyebrow}</SectionLabel>
        {extra}
      </div>
      <h2 id={id ? `${id}-title` : undefined} className="mt-1.5 text-[24px] font-semibold text-ink sm:text-[28px]">
        {id ? (
          <button
            type="button"
            aria-expanded={!shut}
            onClick={() => setFolded(id, !shut)}
            className="group inline-flex cursor-pointer items-center gap-2 rounded-md text-left transition-colors hover:text-accent-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {title}
            <ChevronDown
              size={20}
              aria-hidden="true"
              className={cx('shrink-0 text-muted transition-transform duration-300 ease-out group-hover:text-accent-ink', shut && '-rotate-90')}
            />
          </button>
        ) : (
          title
        )}
      </h2>
      {children && <div className="mt-2 space-y-2 text-[14px] leading-relaxed text-ink-2">{children}</div>}
    </div>
  );
}

/** Fold and unfold timing: quick, with a soft landing. */
const FOLD_MS = 320;
const FOLD_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';

/**
 * A section the jump bar can land on, clear of the sticky header and bar. When its title is
 * clicked it slides shut down to just the heading, and everything after the title fades out;
 * clicking again slides it open. The fade comes from the "fold" rules in styles.css, which hide
 * whatever comes after the elements marked data-fold-keep (the way from the section to its title).
 */
export function Section({ id, children, className }: { id: string; children: ReactNode; className?: string }) {
  const shut = useFolded(id);
  const ref = useRef<HTMLElement>(null);
  const first = useRef(true);

  useLayoutEffect(() => {
    const el = ref.current;
    const title = el?.querySelector<HTMLElement>(`[id="${id}-title"]`);
    if (!el || !title) return;
    for (let n: HTMLElement | null = title; n && n !== el; n = n.parentElement) n.setAttribute('data-fold-keep', '');
    if (first.current) {
      first.current = false;
      if (!shut) return;
    }
    const closed = title.getBoundingClientRect().bottom - el.getBoundingClientRect().top + 4;
    el.style.overflow = 'hidden';
    el.style.transition = 'none';
    el.style.height = `${shut ? el.getBoundingClientRect().height : closed}px`;
    void el.offsetHeight; // Let the browser take in the starting height before it animates.
    el.style.transition = `height ${FOLD_MS}ms ${FOLD_EASE}`;
    el.style.height = `${shut ? closed : el.scrollHeight}px`;
    const done = window.setTimeout(() => {
      el.style.transition = '';
      // Open again: back to its natural height, so it can grow as live numbers come in.
      if (!shut) {
        el.style.height = '';
        el.style.overflow = '';
      }
    }, FOLD_MS + 30);
    return () => window.clearTimeout(done);
  }, [shut, id]);

  return (
    <section ref={ref} id={id} aria-labelledby={`${id}-title`} data-folded={shut ? '' : undefined} className={cx('fold scroll-mt-32', className)}>
      {children}
    </section>
  );
}

/** A smaller heading inside a section. */
export function SubHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div>
      <h3 className={cx('text-[20px]', titleFont)}>{title}</h3>
      {children && <p className="mt-1.5 text-[14px] leading-relaxed text-ink-2">{children}</p>}
    </div>
  );
}
