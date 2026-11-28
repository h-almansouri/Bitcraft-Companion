import { useEffect, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { SectionLabel, cx } from './kit.tsx';

/**
 * Pieces for the site's long one-scroll pages: a sticky bar that jumps between sections,
 * section headings, the gold divider between sections, and the floating back button.
 * They look and behave like the About page's own.
 */
export type PageSection = { id: string; label: string };

/**
 * Where you were before the last jump, so the floating button can take you back.
 * A tiny store rather than state, because jumps start from several places on a page.
 */
let returnTo: number | null = null;
const returnWatchers = new Set<() => void>();
function setReturnTo(y: number | null) {
  returnTo = y;
  returnWatchers.forEach((notify) => notify());
}
function useReturnTo() {
  return useSyncExternalStore(
    (notify) => {
      returnWatchers.add(notify);
      return () => {
        returnWatchers.delete(notify);
      };
    },
    () => returnTo,
  );
}

/** Smooth-scrolls to a section without stacking up history entries, remembering where you jumped from. */
export function jumpTo(id: string, event?: MouseEvent) {
  const target = document.getElementById(id);
  if (!target) return;
  event?.preventDefault();
  setReturnTo(window.scrollY);
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

/**
 * A round arrow button floating in the corner. After a jump it takes you back to where you were,
 * pointing up or down toward that spot. Otherwise, once you've scrolled a way down, it goes to the top.
 */
export function BackButton() {
  const [y, setY] = useState(0);
  const back = useReturnTo();
  useEffect(() => {
    const check = () => setY(window.scrollY);
    check();
    window.addEventListener('scroll', check, { passive: true });
    return () => window.removeEventListener('scroll', check);
  }, []);
  // A saved spot right where you already are is no use, so the button falls back to "top".
  const returning = back !== null && Math.abs(back - y) > 200;
  const shown = returning || y > 600;
  const label = returning ? 'Back to where you were' : 'Back to top';
  const go = () => {
    if (returning && back !== null) {
      window.scrollTo({ top: back, behavior: 'smooth' });
      setReturnTo(null);
    } else {
      setReturnTo(window.scrollY);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    window.history.replaceState(null, '', window.location.pathname);
  };
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={go}
      className={cx(
        'fixed bottom-5 right-5 z-30 flex h-11 w-11 items-center justify-center rounded-full border border-accent bg-accent-dim text-accent-ink shadow-lg shadow-black/30 transition-all hover:bg-accent hover:text-bg',
        shown ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-3 opacity-0',
      )}
    >
      {returning && back !== null && back > y ? <ArrowDown size={18} /> : <ArrowUp size={18} />}
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

/** Heading block at the top of a section. */
export function SectionHead({ id, eyebrow, title, children, extra }: { id?: string; eyebrow: string; title: string; children?: ReactNode; extra?: ReactNode }) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <SectionLabel>{eyebrow}</SectionLabel>
        {extra}
      </div>
      <h2 id={id ? `${id}-title` : undefined} className="mt-1.5 text-[24px] font-semibold text-ink sm:text-[28px]">
        {title}
      </h2>
      {children && <div className="mt-2 space-y-2 text-[14px] leading-relaxed text-ink-2">{children}</div>}
    </div>
  );
}

/** A section the jump bar can land on, clear of the sticky header and bar. */
export function Section({ id, children, className }: { id: string; children: ReactNode; className?: string }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={cx('scroll-mt-32', className)}>
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
