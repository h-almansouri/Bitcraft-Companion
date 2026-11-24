const whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** Quantities are whole things in game, so anything fractional (expected drops) rounds up. */
export const num = (n: number) => whole.format(Math.ceil(n - 1e-9) || 0);

export const pct = (fraction: number) => `${Math.floor(fraction * 100)}%`;

export function ago(iso: string | null | undefined): string {
  if (!iso) return '';
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  const days = Math.round(seconds / 86400);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export const plural = (n: number, one: string, many = one + 's') => (Math.ceil(n - 1e-9) === 1 ? one : many);

export const TIER_NAMES = ['', 'Rough', 'Simple', 'Sturdy', 'Fine', 'Exquisite', 'Peerless', 'Ornate', 'Pristine', 'Magnificent', 'Flawless'];
