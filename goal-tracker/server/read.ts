/**
 * Where the site's live numbers come from.
 *
 * First choice is the one relay connection (server/live.ts; Bitjita's relay, or BitCraftSync's
 * while that one cannot be reached): it is live, and a page asking costs the relay nothing
 * because the answer is already here in memory.
 *
 * The older way, fetching from Bitjita's public API under strict limits (server/bitjita.ts),
 * is only the stand-in:
 *
 *  - when this host has no relay connection at all (`host.live` is not set);
 *  - while neither relay can be reached, so the site keeps working;
 *  - for a member who is in another region. One connection sees one region and a
 *    travelling member's bags go with them, so that one member is read the older way
 *    until they are back.
 */
import { CLAIM } from '../src/lib/claim.ts';
import type { ChestActivity, ClaimDetail, StockSnapshot } from '../src/lib/shapes.ts';
import { chestActivity, claimDetail, stockSnapshot, type Memo } from './bitjita.ts';
import type { LiveSource } from './live.ts';

interface Source {
  memo: Memo;
  live?: LiveSource;
}

export async function readClaim(host: Source): Promise<ClaimDetail> {
  return (await host.live?.claim()) ?? claimDetail(host.memo, CLAIM.id);
}

export async function readStock(host: Source, players: string[], fresh: boolean): Promise<StockSnapshot> {
  const live = await host.live?.stock(players);
  if (!live) return stockSnapshot(host.memo, CLAIM.id, players, fresh);

  const { claim, away } = live;
  let { locations, crafts } = live;
  const problems: string[] = [];
  if (away.length) {
    const gone = new Set(away.map((m) => m.id));
    try {
      // Everything of theirs comes from the one older read, so nothing is counted twice.
      const theirs = await stockSnapshot(host.memo, CLAIM.id, [...gone], fresh);
      locations = [...locations.filter((l) => !l.ownerId || !gone.has(l.ownerId)), ...theirs.locations.filter((l) => l.ownerId && gone.has(l.ownerId))];
      crafts = [...crafts.filter((c) => !gone.has(c.ownerId)), ...theirs.crafts.filter((c) => gone.has(c.ownerId))];
      problems.push(...theirs.problems);
    } catch (err) {
      const names = away.map((m) => m.name).join(', ');
      problems.push(`${names} ${away.length === 1 ? 'is' : 'are'} outside ${claim.region || 'the region'} right now, and what they carry could not be read (${(err as Error).message}).`);
    }
  }
  return { at: new Date().toISOString(), live: true, claim: { id: claim.id, name: claim.name, tier: claim.tier }, locations, crafts, problems };
}

export async function readActivity(host: Source, chest: string, owner?: string): Promise<ChestActivity | null> {
  const live = await host.live?.activity(chest, owner);
  return live !== undefined ? live : chestActivity(host.memo, CLAIM.id, chest, owner);
}
