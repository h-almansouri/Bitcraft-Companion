/**
 * When a page that is on screen asks for storage again by itself.
 *
 * The server keeps one relay connection and always holds the game as it stands
 * (server/live.ts). A page asking is answered from the server's memory and costs the
 * relay nothing, so pages look again every 15 seconds while they are on screen. That is
 * what makes them live.
 *
 * While no relay can be reached the server reads the older way, and the limit that
 * protects Bitjita sits on the server, not here (server/bitjita.ts): one fetched read
 * is shared by everyone for 15 minutes, however often pages ask.
 */
export const LIVE_REFRESH_SECONDS = 15;

/** A page whose last answer is older than this no longer calls itself live: its asks are failing, or it was in the background. */
const LIVE_FOR_MS = 45_000;

/** `asked` is when this page last asked. A page never asks by itself more often than every 15 seconds. */
export function dueForAutoRead(now: number, asked: number): boolean {
  return now - asked >= LIVE_REFRESH_SECONDS * 1000;
}

/**
 * Whether what is on screen may be called live: it came over the relay (`live`), and the
 * server's last answer to this page (`answeredAt`) is recent.
 */
export function showsLive(now: number, live: boolean | undefined, answeredAt: number): boolean {
  return !!live && now - answeredAt < LIVE_FOR_MS;
}
