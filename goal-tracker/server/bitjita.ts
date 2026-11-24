/**
 * Reads live game state from Bitjita's public API (https://bitjita.com/docs/api)
 * and reshapes it into one consistent "stock snapshot".
 *
 * Bitjita is a free community service. This tool is deliberately a light guest:
 *
 *  - Nothing is ever fetched in the background. Storage is read only when someone
 *    opens a page or presses refresh.
 *  - A finished snapshot is shared by everyone for 15 minutes. Pressing refresh
 *    can ask for a newer one, but never more often than every 5 minutes.
 *  - Things that rarely change (who is in the claim, which buildings stand, who
 *    owns a house) are remembered for hours. What is left is one request for the
 *    claim's chests and three per counted member (storage, crafts, passive crafts).
 *  - "Nothing there" answers are remembered too, instead of being asked again.
 *    With nine members that is 28 requests for a normal read, and about 40 for the
 *    first read of the day when the slow-changing facts have to be asked again.
 *  - At most two requests are in flight at once, and hard caps stop everything
 *    at 60 requests a minute or 240 an hour (Bitjita's own limit is 250 a minute).
 *    The minute cap is a safety net sized so one full read fits; the hour cap is
 *    what holds overall use down.
 *  - If a newer read comes back with gaps, the last complete one is shown instead.
 *
 * Nothing in here depends on where the server runs. The host passes in a `Memo`
 * (Cloudflare's cache as a Worker, a map in memory under Node) and this file
 * decides what goes in it and for how long.
 */
import type { CraftJob, StockLocation, StockSnapshot, ClaimDetail } from '../src/lib/shapes.ts';

const BASE = 'https://bitjita.com/api';
const APP = 'nowhere-craft-tracker (one claim, cached)';

/** Seconds each kind of answer is reused before asking Bitjita again. */
const TTL = {
  claim: 3600,
  members: 6 * 3600,
  buildings: 3600,
  houseList: 12 * 3600,
  /** Chest, bag and craft contents. Reused for as long as the snapshot they belong to. */
  storage: 900,
  /** The assembled snapshot everyone shares. */
  snapshot: 900,
};
/** Bump when what a snapshot contains changes, so copies saved in the old shape are not served. */
const SNAPSHOT_SHAPE = 2;
/** Pressing refresh gets a newer snapshot only if the current one is at least this old. */
const MIN_REFRESH_SECONDS = 300;

/** Never more than this many requests to Bitjita at the same moment. */
const MAX_IN_FLIGHT = 2;
/** Room for one whole read from cold (about 40 requests), and nothing like a second one. */
const BUDGET_PER_MINUTE = 60;
const BUDGET_PER_HOUR = 240;

export class UpstreamError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Where answers are remembered between requests. Keys are always full https addresses. */
export interface Memo {
  /** The remembered text, or null when there is none or it has run out. */
  get(key: string): Promise<string | null>;
  /** Remember `text` for `ttlSeconds`. Never throws; a failed save only means asking again later. */
  set(key: string, text: string, ttlSeconds: number): void;
}

// ---- politeness: one queue, hard budgets, no duplicate questions -----------------

let inFlight = 0;
const waiting: (() => void)[] = [];
/** When each request to Bitjita was made, for the last hour. */
const recentCalls: number[] = [];
const asking = new Map<string, Promise<string | null>>();
const counters = { asked: 0, reused: 0, refused: 0 };

async function slot<T>(work: () => Promise<T>): Promise<T> {
  // A finished request hands its place straight to the next one waiting, so the count never overshoots.
  if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((go) => waiting.push(go));
  else inFlight++;
  try {
    return await work();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else inFlight--;
  }
}

const since = (ms: number) => {
  const cutoff = Date.now() - ms;
  let n = 0;
  for (let i = recentCalls.length - 1; i >= 0 && recentCalls[i] > cutoff; i--) n++;
  return n;
};

function spend(path: string) {
  const now = Date.now();
  while (recentCalls.length && now - recentCalls[0] > 3_600_000) recentCalls.shift();
  if (since(60_000) >= BUDGET_PER_MINUTE || recentCalls.length >= BUDGET_PER_HOUR) {
    counters.refused++;
    throw new UpstreamError(429, `Holding off: ${since(60_000)} requests to Bitjita in the last minute, ${recentCalls.length} in the last hour (wanted ${path}).`);
  }
  recentCalls.push(now);
  counters.asked++;
}

/** What this server has asked of Bitjita lately, for the status page and the logs. */
export function usage() {
  return {
    askedInLastMinute: since(60_000),
    askedInLastHour: since(3_600_000),
    capPerMinute: BUDGET_PER_MINUTE,
    capPerHour: BUDGET_PER_HOUR,
    bitjitaLimitPerMinute: 250,
    snapshotReusedForMinutes: TTL.snapshot / 60,
    refreshAtMostEveryMinutes: MIN_REFRESH_SECONDS / 60,
    sinceStart: { ...counters },
  };
}

/**
 * GET a Bitjita path as JSON, reused for `ttl` seconds. `missing` is returned when
 * Bitjita has nothing there (and that answer is remembered as well). `force` skips
 * the remembered answer, for an explicit refresh.
 */
async function get<T>(memo: Memo, path: string, ttl: number, missing?: T, force = false): Promise<T> {
  const url = BASE + path;
  let body: string | null | undefined;

  if (!force) {
    const hit = await memo.get(url);
    if (hit !== null) {
      counters.reused++;
      body = hit === 'null' ? null : hit;
    }
  }

  if (body === undefined) {
    // Two parts of the same page asking the same thing share one request.
    let pending = asking.get(url);
    if (!pending) {
      pending = slot(async () => {
        spend(path);
        const res = await fetch(url, { headers: { 'user-agent': APP, 'x-app-identifier': APP, accept: 'application/json' } });
        if (res.status === 404) {
          memo.set(url, 'null', ttl);
          return null;
        }
        if (!res.ok) throw new UpstreamError(res.status === 429 ? 429 : 502, `Bitjita answered ${res.status} for ${path}`);
        const text = await res.text();
        memo.set(url, text, ttl);
        return text;
      }).finally(() => asking.delete(url));
      asking.set(url, pending);
    } else {
      counters.reused++;
    }
    body = await pending;
  }

  if (body === null) {
    if (missing !== undefined) return missing;
    throw new UpstreamError(502, `Bitjita has nothing at ${path}`);
  }
  return JSON.parse(body);
}

// ---- reshaping ------------------------------------------------------------------

const ref = (id: number | string, type: unknown) => (type === 1 || type === 'cargo' || type === 'Cargo' ? 'c.' : 'i.') + id;

/** Adds up a list of storage slots into [thing, quantity] pairs. */
function tally(slots: any[] | undefined): [string, number][] {
  const totals = new Map<string, number>();
  for (const slot of slots ?? []) {
    const c = slot?.contents;
    if (!c) continue;
    const id = ref(c.item_id ?? c.itemId, c.item_type ?? c.itemType);
    totals.set(id, (totals.get(id) ?? 0) + (Number(c.quantity) || 0));
  }
  return [...totals];
}

export async function claimDetail(memo: Memo, id: string): Promise<ClaimDetail> {
  const [claim, members] = await Promise.all([get<any>(memo, `/claims/${id}`, TTL.claim), get<any>(memo, `/claims/${id}/members`, TTL.members, { members: [] })]);
  const c = claim.claim;
  return {
    id: String(c.entityId),
    name: c.name,
    tier: c.tier ?? 0,
    region: c.regionName ?? '',
    owner: c.ownerPlayerUsername ?? '',
    supplies: Number(c.supplies) || 0,
    members: (members.members ?? []).map((m: any) => ({ id: String(m.playerEntityId), name: m.userName, lastSeen: m.lastLoginTimestamp ?? null })),
  };
}

/**
 * Everything the claim and the given members are holding, plus crafts on the go.
 * Only members of the claim are ever looked up, whatever ids are passed in.
 * `fresh` is someone pressing refresh: honoured only when the snapshot on hand is old enough.
 */
export async function stockSnapshot(memo: Memo, claimId: string, wantedPlayers: string[], fresh = false): Promise<StockSnapshot> {
  const detail = await claimDetail(memo, claimId);
  const members = new Map(detail.members.map((m) => [m.id, m.name]));
  const playerIds = [...new Set(wantedPlayers)].filter((id) => members.has(id)).sort();

  const whole = `https://snapshot.internal/v${SNAPSHOT_SHAPE}/${claimId}?players=${playerIds.join(',')}`;
  const ready = await memo.get(whole);
  let previous: StockSnapshot | null = null;
  if (ready) {
    const snapshot: StockSnapshot = JSON.parse(ready);
    const ageSeconds = (Date.now() - new Date(snapshot.at).getTime()) / 1000;
    if (!fresh || ageSeconds < MIN_REFRESH_SECONDS) return snapshot;
    previous = snapshot;
  }
  // From here on this is a new read. An explicit refresh re-asks for contents; the slow-changing facts stay remembered.
  const force = fresh;

  const locations: StockLocation[] = [];
  const problems: string[] = [];

  const claimPart = (async () => {
    const inv = await get<any>(memo, `/claims/${claimId}/inventories`, TTL.storage, undefined, force);
    for (const b of inv.buildings ?? []) {
      locations.push({
        id: 'b' + b.entityId,
        kind: 'claim',
        owner: detail.name,
        name: b.buildingNickname || b.buildingName,
        detail: b.buildingNickname ? b.buildingName : '',
        items: tally(b.inventory),
      });
    }
    // Buildings already standing count toward "build a T5 loom" style goals.
    const built = await get<any[]>(memo, `/claims/${claimId}/buildings`, TTL.buildings, []).catch(() => []);
    const counts = new Map<string, number>();
    for (const b of Array.isArray(built) ? built : []) counts.set('b.' + b.buildingDescriptionId, (counts.get('b.' + b.buildingDescriptionId) ?? 0) + 1);
    if (counts.size) locations.push({ id: 'built', kind: 'claim', owner: detail.name, name: 'Standing in the claim', detail: 'Buildings', items: [...counts] });
  })();

  // Crafts are read per member rather than per claim, so a job someone queued at
  // another base (fiber being spun at a friend's tailoring station) still counts.
  const crafts: CraftJob[] = [];
  const playerParts = playerIds.map(async (pid) => {
    const owner = members.get(pid) ?? 'Member';
    try {
      const [active, passive] = await Promise.all([
        get<any>(memo, `/players/${pid}/crafts?completed=all`, TTL.storage, { craftResults: [] }, force),
        get<any>(memo, `/players/${pid}/passive-crafts?status=all`, TTL.storage, { craftResults: [] }, force),
      ]);
      for (const c of active.craftResults ?? []) {
        const made = c.craftedItem?.[0];
        if (!made) continue;
        crafts.push({
          id: String(c.entityId),
          item: ref(made.item_id, made.item_type),
          qty: (Number(made.quantity) || 1) * (Number(c.craftCount) || 1),
          owner,
          ownerId: pid,
          station: c.buildingName ?? '',
          claim: c.claimName ?? '',
          passive: false,
          progress: Number(c.progress) || 0,
          total: Number(c.totalActionsRequired) || 0,
          done: !!c.completed,
          shared: !!c.isPublic,
        });
      }
      // A loom holds dozens of one-strip jobs; they are added up per station and state.
      const batches = new Map<string, CraftJob>();
      for (const c of passive.craftResults ?? []) {
        const made = c.craftedItem?.[0];
        if (!made) continue;
        const item = ref(made.item_id, made.item_type);
        const done = /complete/i.test(String(c.status ?? ''));
        const key = `${c.buildingEntityId}|${item}|${done}`;
        const batch = batches.get(key);
        if (batch) batch.qty += Number(made.quantity) || 1;
        else
          batches.set(key, {
            id: `passive:${pid}:${key}`,
            item,
            qty: Number(made.quantity) || 1,
            owner,
            ownerId: pid,
            station: c.buildingName ?? '',
            claim: c.claimName ?? '',
            passive: true,
            progress: 0,
            total: 0,
            done,
            shared: false,
          });
      }
      crafts.push(...batches.values());
    } catch (err) {
      problems.push(`Could not read ${owner}'s crafts (${(err as Error).message}).`);
    }
    try {
      const inv = await get<any>(memo, `/players/${pid}/inventories`, TTL.storage, undefined, force);
      for (const box of inv.inventories ?? []) {
        const items = tally(box.pockets);
        if (!items.length) continue;
        // Storage a player owns inside a town (bank stash) names the town; carried bags and mounts don't.
        const where = box.claimName ? `${box.inventoryName ?? box.buildingName} @ ${box.claimName}` : (box.inventoryName ?? box.buildingName ?? 'Storage');
        locations.push({ id: 'p' + pid + ':' + box.entityId, kind: 'player', owner, ownerId: pid, name: where, detail: '', items });
      }
    } catch (err) {
      problems.push(`Could not read ${owner}'s storage (${(err as Error).message}).`);
    }
    try {
      // Most members have no house; that answer is remembered for hours rather than asked every time.
      let houses = await get<any>(memo, `/players/${pid}/housing`, TTL.houseList, []);
      if (!Array.isArray(houses)) houses = [houses];
      for (const h of houses) {
        if (!h || h.isEmpty || !h.buildingEntityId) continue;
        const house = await get<any>(memo, `/players/${pid}/housing/${h.buildingEntityId}`, TTL.storage, { inventories: [] }, force);
        for (const box of house.inventories ?? []) {
          const items = tally(box.inventory);
          if (!items.length) continue;
          locations.push({ id: 'h' + pid + ':' + box.entityId, kind: 'player', owner, ownerId: pid, name: 'House: ' + (box.buildingNickname || box.buildingName || 'storage'), detail: '', items });
        }
      }
    } catch {
      // Housing is optional and often absent; a miss here is not worth a warning.
    }
  });

  try {
    await Promise.all([claimPart, ...playerParts]);
  } catch (err) {
    // The claim's own chests could not be read. With an older complete read on hand, show that rather than nothing.
    if (!previous) throw err;
    problems.push(`Could not read the claim's storage (${(err as Error).message}).`);
  }
  // A read with pieces missing would make things look short that are not. The last complete one is the better answer.
  if (problems.length && previous) return { ...previous, problems: [`Could not get a newer read, so this is still the one from earlier. ${problems[0]}`] };
  const snapshot: StockSnapshot = { at: new Date().toISOString(), claim: { id: detail.id, name: detail.name, tier: detail.tier }, locations, crafts, problems };

  // A snapshot with gaps is not worth keeping: the next ask should try again.
  if (!problems.length) memo.set(whole, JSON.stringify(snapshot), TTL.snapshot);
  return snapshot;
}
