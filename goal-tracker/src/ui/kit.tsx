import { useEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';
import { Check, ChevronDown, X } from 'lucide-react';
import { progressColor } from '../lib/colors.ts';

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

type Tone = 'accent' | 'good' | 'warn' | 'bad' | 'info' | 'neutral';

export function Button({
  variant = 'soft',
  size = 'md',
  className,
  ...rest
}: { variant?: 'primary' | 'soft' | 'ghost' | 'danger'; size?: 'sm' | 'md' } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cx(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border font-medium transition-colors disabled:cursor-default disabled:opacity-50',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-9 px-3.5 text-[13px]',
        variant === 'primary' && 'border-accent bg-accent-dim text-accent-ink hover:bg-accent hover:text-bg',
        variant === 'soft' && 'border-line-2 bg-surface-2 text-ink hover:bg-surface-3',
        variant === 'ghost' && 'border-transparent text-ink-2 hover:bg-surface-2 hover:text-ink',
        variant === 'danger' && 'border-line-2 bg-surface-2 text-bad hover:bg-bad-soft',
        className,
      )}
      {...rest}
    />
  );
}

/** Square icon-only button, as used in the top bar. */
export function IconButton({ label, className, children, ...rest }: { label: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx('inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-2 text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink', className)}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Card({ className, children, style }: { className?: string; children: ReactNode; style?: CSSProperties }) {
  return (
    <div className={cx('rounded-card border border-line bg-surface', className)} style={style}>
      {children}
    </div>
  );
}

export function TierChip({ tier, className }: { tier: number; className?: string }) {
  if (!tier) return null;
  return (
    <span className={cx('tier-chip num inline-flex h-[18px] shrink-0 items-center rounded px-1 text-[10px] font-semibold leading-none', className)} style={{ '--hue': `var(--tier-${tier})` } as CSSProperties}>
      T{tier}
    </span>
  );
}

const toneText: Record<Tone, string> = { accent: 'text-accent-ink', good: 'text-good', warn: 'text-warn', bad: 'text-bad', info: 'text-info', neutral: 'text-ink-2' };
const toneSoft: Record<Tone, string> = { accent: 'bg-accent-soft', good: 'bg-good-soft', warn: 'bg-warn-soft', bad: 'bg-bad-soft', info: 'bg-info-soft', neutral: 'bg-surface-2' };

/** Small label badge: status, type, counts. */
export function Pill({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] font-semibold uppercase tracking-wide', toneSoft[tone], toneText[tone], className)}>{children}</span>
  );
}

/**
 * A progress bar. `value` is 0..1, and its colour follows it: red when barely started, through orange and yellow, to deep green when done.
 * `pending` is the part of `value` that is counted but not in hand yet (still at a station); it is drawn striped.
 */
export function Bar({ value, pending = 0, className }: { value: number; pending?: number; className?: string }) {
  const filled = Math.max(0, Math.min(1, value));
  const striped = Math.max(0, Math.min(filled, pending));
  const color = progressColor(value);
  return (
    <div className={cx('flex h-1.5 overflow-hidden rounded-full bg-surface-3', className)} role="progressbar" aria-valuenow={Math.round(filled * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div className={cx('h-full transition-[width,background-color] duration-500', striped > 0 ? 'rounded-l-full' : 'rounded-full')} style={{ width: `${(filled - striped) * 100}%`, background: color }} />
      {striped > 0 && <div className="at-station h-full rounded-r-full transition-[width,background-color] duration-500" style={{ width: `${striped * 100}%`, backgroundColor: color }} />}
    </div>
  );
}

/** Toggle button for a filter. */
export function Chip({ active, children, onClick, count }: { active?: boolean; children: ReactNode; onClick?: () => void; count?: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors',
        active ? 'border-accent bg-accent-soft text-accent-ink' : 'border-line-2 bg-surface-2 text-ink-2 hover:bg-surface-3 hover:text-ink',
      )}
    >
      {children}
      {count !== undefined && <span className={cx('num text-[11px]', active ? 'opacity-80' : 'text-muted')}>{count}</span>}
    </button>
  );
}

/** Underlined section tabs. */
export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (value: T) => void; tabs: { id: T; label: string; icon?: ReactNode; count?: number }[] }) {
  return (
    <div role="tablist" className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-line">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          type="button"
          aria-selected={value === tab.id}
          onClick={() => onChange(tab.id)}
          className={cx(
            'inline-flex h-10 shrink-0 items-center gap-2 border-b-2 px-3 text-[13px] font-medium transition-colors',
            value === tab.id ? 'border-accent text-accent-ink' : 'border-transparent text-ink-2 hover:text-ink',
          )}
        >
          {tab.icon}
          {tab.label}
          {tab.count !== undefined && tab.count > 0 && <span className="num rounded bg-surface-3 px-1.5 text-[11px] text-ink-2">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * A filter button that opens a checklist: "All roles ▾". `placeholder` is what the
 * button reads while nothing is picked, when that should differ from the "all" choice in the list.
 */
export function MultiSelect({
  label,
  allLabel,
  placeholder,
  options,
  value,
  onChange,
  icon,
}: {
  label: string;
  allLabel: string;
  placeholder?: string;
  options: { id: string; label: string; count?: number }[];
  value: string[];
  onChange: (value: string[]) => void;
  icon?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const chosen = options.filter((o) => value.includes(o.id));
  const summary = chosen.length === 0 ? (placeholder ?? allLabel) : chosen.length <= 2 ? chosen.map((o) => o.label).join(', ') : `${chosen.length} ${label.toLowerCase()}`;
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cx('inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors', chosen.length ? 'border-accent bg-accent-soft text-accent-ink' : 'border-line-2 bg-surface-2 text-ink-2 hover:bg-surface-3 hover:text-ink')}
      >
        {icon}
        {summary}
        <ChevronDown size={13} />
      </button>
      {open && (
        <div role="listbox" aria-label={label} aria-multiselectable className="absolute left-0 top-9 z-20 max-h-80 w-56 overflow-y-auto rounded-lg border border-line-2 bg-surface-2 p-1 shadow-xl shadow-black/40">
          <button type="button" role="option" aria-selected={!chosen.length} onClick={() => onChange([])} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-ink hover:bg-surface-3">
            <span className="flex h-3.5 w-3.5 items-center justify-center">{!chosen.length && <Check size={13} className="text-accent-ink" />}</span>
            {allLabel}
          </button>
          {options.map((o) => (
            <button key={o.id} type="button" role="option" aria-selected={value.includes(o.id)} onClick={() => toggle(o.id)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-ink hover:bg-surface-3">
              <span className="flex h-3.5 w-3.5 items-center justify-center">{value.includes(o.id) && <Check size={13} className="text-accent-ink" />}</span>
              <span className="flex-1">{o.label}</span>
              {o.count !== undefined && <span className="num text-muted">{o.count}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Slide-over panel on the right; on phones it covers the screen. */
export function Drawer({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button type="button" aria-label="Close" className="absolute inset-0 cursor-default bg-black/55" onClick={onClose} />
      <aside role="dialog" aria-modal="true" className="drawer-panel relative flex h-full w-full max-w-[500px] flex-col border-l border-line bg-bg shadow-2xl shadow-black/50">
        <header className="flex items-start gap-3 border-b border-line bg-surface px-4 py-3.5">
          <div className="min-w-0 flex-1">{title}</div>
          <IconButton label="Close" onClick={onClose} className="h-8 w-8">
            <X size={16} />
          </IconButton>
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-4">{children}</div>
      </aside>
    </div>
  );
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8">
      <button type="button" aria-label="Close" className="fixed inset-0 cursor-default bg-black/60" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-label={title} className={cx('relative my-auto w-full rounded-xl border border-line-2 bg-surface shadow-2xl shadow-black/60', wide ? 'max-w-2xl' : 'max-w-md')}>
        <header className="flex items-center gap-3 border-b border-line px-5 py-3.5">
          <h2 className="flex-1 text-base font-semibold">{title}</h2>
          <IconButton label="Close" onClick={onClose} className="h-8 w-8">
            <X size={16} />
          </IconButton>
        </header>
        <div className="px-5 py-5">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

/** Text field look without a size, for inputs that set their own width and height. */
export const inputBase = 'rounded-md border border-line bg-surface-2 px-3 text-[13px] text-ink placeholder:text-muted focus:border-accent focus:outline-none';
export const inputClass = 'h-9 w-full ' + inputBase;

/** Tiny uppercase heading, used to title groups of things. */
export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('text-[11px] font-semibold uppercase tracking-[0.08em] text-muted', className)}>{children}</div>;
}

export function Notice({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <div className={cx('rounded-lg border border-line px-3.5 py-2.5 text-[13px]', toneSoft[tone], tone === 'neutral' ? 'text-ink-2' : toneText[tone])}>{children}</div>;
}

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="px-6 py-14 text-center">
      {icon && <div className="mb-3 flex justify-center text-muted">{icon}</div>}
      <p className="text-[15px] font-semibold text-ink">{title}</p>
      {children && <div className="mx-auto mt-1.5 max-w-md text-[13px] text-ink-2">{children}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton', className)} />;
}
