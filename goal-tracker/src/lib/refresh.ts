/**
 * When a page that is on screen asks for storage again by itself.
 *
 * The server shares one read of storage between everyone for 15 minutes, so the
 * page asks once the read it is showing is that old. Asking never forces a new
 * read: whoever asks first after the 15 minutes causes one, and everyone else
 * gets that same answer. That keeps Bitjita at four reads an hour at most,
 * however many people have the page open.
 */
export const AUTO_REFRESH_MINUTES = 15;

const GAP = AUTO_REFRESH_MINUTES * 60_000;
/** Ask a little late, so the server's own 15 minutes are certainly up when the ask arrives. */
const SLACK = 15_000;

/**
 * `readAt` is when the storage on screen was read (null when there is none).
 * `asked` is when this page last asked without getting a newer read back, or 0.
 * A page never asks by itself more than once in 15 minutes, whatever came back.
 */
export function dueForAutoRead(now: number, readAt: number | null, asked: number): boolean {
  const countFrom = Math.max(readAt === null ? 0 : readAt + SLACK, asked);
  return now - countFrom >= GAP;
}
