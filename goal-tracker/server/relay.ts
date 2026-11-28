/**
 * One held connection to a relay: a live mirror of the game's own tables. The site's
 * numbers come over it instead of being fetched page by page from Bitjita's public API.
 *
 * Two relays mirror the same tables and either may be used: Bitjita's own
 * (relay.bitjita.com), which is the first choice, and BitCraftSync's
 * (relay.bitcraftsync.app), which stands in while the first cannot be reached.
 *
 * A relay speaks subscriptions: ask a set of questions once, get the rows that match, and
 * from then on be told about every change to them. So this file keeps ONE socket for the
 * claim's region and everything the site reads goes through it:
 *
 *  - The socket is opened because a page asked, never by itself, and it is closed again
 *    once no page has asked for 20 minutes. Nobody looking means no connection.
 *  - However many people or tabs are looking, there is still one socket: they all read
 *    the same rows kept here in memory. There is never one to each relay at the same time.
 *  - Questions are only ever added to the open socket (as named sets), never by opening a
 *    second one. Each is a lookup on a column the relay has an index for.
 *  - A relay that will not open or answer is given up on quickly and left alone for a
 *    while (a minute, growing to ten), so a relay having a bad day is not hammered. The
 *    other relay is tried; with neither to be had, the caller falls back to the older,
 *    slower way of reading (server/bitjita.ts).
 *
 * This file knows nothing about claims or storage: it is handed a `plan` that says which
 * questions to ask given the rows received so far (server/live.ts), and keeps the answers.
 */

/** One row of a game table, by column name. */
export type Row = Record<string, any>;
/** Everything received so far: table name, then the row's key, then the row. */
export type Tables = Map<string, Map<string, Row>>;

/** The part of a WebSocket this file uses, so the tests can stand in for one. */
export interface Wire {
  send(text: string): void;
  close(): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
}
export type Dial = (url: string, protocols: string[]) => Wire;

/** No relay is answering right now. The caller reads the slower way instead. */
export class RelayDown extends Error {}

/** A relay: where its socket for a region is, and where it publishes the layout of the tables it mirrors. */
export interface RelayHost {
  name: string;
  socket: (region: number) => string;
  layout: (region: number) => string;
}

/** The name the region databases share on both relays ("idc-8"): it says which game world is mirrored. */
const WORLD = 'idc';
const database = (region: number) => `${WORLD}-${region}`;

/** In order of preference. Bitjita's is one host for every region; BitCraftSync's has a port per region. */
export const RELAYS: RelayHost[] = [
  {
    name: 'relay.bitjita.com',
    socket: (region) => `wss://relay.bitjita.com/v1/database/${database(region)}/subscribe?compression=None`,
    layout: (region) => `https://relay.bitjita.com/v1/database/${database(region)}/schema?version=9`,
  },
  {
    name: 'relay.bitcraftsync.app',
    socket: (region) => `wss://relay.bitcraftsync.app:${3000 + region}/v1/database/${database(region)}/subscribe?compression=None`,
    layout: (region) => `https://relay.bitcraftsync.app:${3000 + region}/v1/database/${database(region)}/schema?version=9`,
  },
];

const PROTOCOL = 'v1.json.spacetimedb';

/** How long opening the socket plus its first answer may take. */
const CONNECT_MS = 10_000;
/** How long any later set of questions may take to be answered. */
const STEP_MS = 8_000;
/** After this long with no page asking, the socket is closed. Pages on screen ask every 15 minutes. */
const IDLE_MS = 20 * 60_000;
/** A socket that has said nothing for this long is checked before its rows are trusted. */
const QUIET_MS = 45_000;
const PING_MS = 4_000;
/** After a failed connection a relay is left alone this long, doubling each time up to the limit. */
const HOLD_OFF_MS = 60_000;
const MAX_HOLD_OFF_MS = 10 * 60_000;
/** A cap on questions per connection, so a surprise in the data can never turn into a flood. */
const MAX_QUERIES = 500;
/** How many rounds of follow-up questions one settling may take before it is called complete. */
const MAX_ROUNDS = 8;
/** A relay's own table layout is re-read at most this often. */
const LAYOUT_EVERY_MS = 10 * 60_000;

/**
 * Column names, in order, of the tables the site reads. Rows arrive as bare lists (always
 * from Bitjita's relay, and for changes from BitCraftSync's), so these are what name them.
 * Taken from the layout the relays publish (/schema, 2026-11-27); if a game patch changes
 * a table, the published layout is read again (see `learnLayout`).
 */
const COLUMNS: Record<string, string[]> = {
  claim_state: ['entity_id', 'owner_player_entity_id', 'owner_building_entity_id', 'name', 'neutral'],
  claim_local_state: ['entity_id', 'supplies', 'building_maintenance', 'num_tiles', 'num_tile_neighbors', 'location', 'treasury', 'xp_gained_since_last_coin_minting', 'supplies_purchase_threshold', 'supplies_purchase_price', 'building_description_id'],
  claim_tech_state: ['entity_id', 'learned', 'researching', 'start_timestamp', 'scheduled_id'],
  claim_member_state: ['entity_id', 'claim_entity_id', 'player_entity_id', 'user_name', 'inventory_permission', 'build_permission', 'officer_permission', 'co_owner_permission'],
  building_state: ['entity_id', 'claim_entity_id', 'direction_index', 'building_description_id', 'constructed_by_player_entity_id'],
  building_nickname_state: ['entity_id', 'nickname'],
  inventory_state: ['entity_id', 'pockets', 'inventory_index', 'cargo_index', 'owner_entity_id', 'player_owner_entity_id'],
  deployable_state_v2: ['entity_id', 'owner_id', 'claim_entity_id', 'direction', 'deployable_description_id', 'nickname', 'hidden', 'appearance_override_id'],
  player_housing_state: ['entity_id', 'entrance_building_entity_id', 'network_entity_id', 'exit_portal_entity_id', 'rank', 'locked_until', 'is_empty', 'region_index'],
  dimension_description_state: ['entity_id', 'dimension_network_entity_id', 'collapse_timestamp', 'interior_instance_id', 'dimension_position_large_x', 'dimension_position_large_z', 'dimension_size_large_x', 'dimension_size_large_z', 'dimension_id', 'dimension_type'],
  location_state: ['entity_id', 'chunk_index', 'x', 'z', 'dimension'],
  progressive_action_state: ['entity_id', 'building_entity_id', 'function_type', 'progress', 'recipe_id', 'craft_count', 'last_crit_outcome', 'owner_entity_id', 'lock_expiration', 'preparation'],
  public_progressive_action_state: ['entity_id', 'building_entity_id', 'owner_entity_id'],
  passive_craft_state: ['entity_id', 'owner_entity_id', 'recipe_id', 'building_entity_id', 'timestamp', 'status', 'slot'],
  storage_log_state: ['id', 'object_entity_id', 'subject_entity_id', 'subject_name', 'subject_type', 'data', 'timestamp', 'days_since_epoch'],
  world_region_name_state: ['id', 'player_facing_name', 'module_name_prefix'],
};

/**
 * Game ids are 64-bit numbers, bigger than JavaScript can hold exactly, so every whole number
 * of 16 or more digits is turned into text before the row is parsed. Text inside quotes is
 * left alone (a chest nicknamed "1234567890123456" stays what it was).
 */
export function quoteLongNumbers(raw: string): string {
  let out = '';
  let kept = 0;
  let i = 0;
  const n = raw.length;
  while (i < n) {
    const ch = raw.charCodeAt(i);
    if (ch === 34) {
      // A string: skip to its closing quote, minding escapes.
      i++;
      while (i < n && raw.charCodeAt(i) !== 34) i += raw.charCodeAt(i) === 92 ? 2 : 1;
      i++;
    } else if (ch === 45 || (ch >= 48 && ch <= 57)) {
      let j = ch === 45 ? i + 1 : i;
      const from = j;
      while (j < n && raw.charCodeAt(j) >= 48 && raw.charCodeAt(j) <= 57) j++;
      const next = raw.charCodeAt(j);
      const whole = next !== 46 && next !== 69 && next !== 101;
      if (whole && j - from >= 16) {
        out += raw.slice(kept, i) + '"' + raw.slice(i, j) + '"';
        kept = j;
      }
      // The rest of a decimal or exponent belongs to the same number.
      while (j < n && '0123456789.eE+-'.includes(raw[j])) j++;
      i = j;
    } else i++;
  }
  return kept === 0 ? raw : out + raw.slice(kept);
}

const keyOf = (row: Row) => String(row.entity_id ?? row.id);

export interface FeedOptions {
  /** The game region whose database is read (the claim's own). */
  region: number;
  /**
   * The questions to have open, given everything received so far. Asked again after every
   * answer and every change; a question, once asked, stays for the life of the connection.
   */
  plan: (tables: Tables) => string[];
  /** The relays to use, first choice first. Left out, both real ones. */
  relays?: RelayHost[];
  /** Opens a socket. Left out, the real thing is used. */
  dial?: Dial;
  /** Reads a web address as text: a relay's published table layout, when a row cannot be named. */
  read?: (url: string) => Promise<string>;
  /** Called each time a new connection is about to be made, before its first questions are planned. */
  onConnect?: () => void;
  idleMs?: number;
  log?: (line: string) => void;
}

type State = 'off' | 'opening' | 'settling' | 'live';

/** A relay and how it has been behaving. */
interface Standing {
  relay: RelayHost;
  /** Not to be tried again before this time. */
  retryAt: number;
  /** Failed connections in a row. */
  failures: number;
  lastError: string;
}

export class Feed {
  private readonly region: number;
  private readonly plan: (tables: Tables) => string[];
  private readonly dial: Dial;
  private readonly read: (url: string) => Promise<string>;
  private readonly onConnect: () => void;
  private readonly idleMs: number;
  private readonly log: (line: string) => void;

  private readonly hosts: Standing[];
  /** The relay the socket is on (or was last on). */
  private host: Standing | null = null;
  private wire: Wire | null = null;
  private state: State = 'off';
  private tables: Tables = new Map();
  /** Every question asked on the current connection. */
  private sent = new Set<string>();
  /** Sets of questions sent and not answered yet. */
  private awaiting = 0;
  private rounds = 0;
  private nextSet = 10;
  private waiters: { resolve: (tables: Tables) => void; reject: (err: Error) => void }[] = [];

  private columns: Record<string, string[]> = { ...COLUMNS };
  /** A row came in that the column lists could not name: the table it was in. */
  private misfit: string | null = null;
  private needLayout = false;
  private layoutAt = 0;

  private lastFrame = 0;
  private lastAsk = 0;
  private liveSince = 0;
  private lastError = '';
  private stepTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private soonTimer: ReturnType<typeof setTimeout> | null = null;
  private pinging: Promise<boolean> | null = null;
  private pings = new Map<number, () => void>();
  private pingSeq = 1_000_000;
  private readonly counts = { connections: 0, failed: 0, frames: 0 };

  constructor(options: FeedOptions) {
    this.region = options.region;
    this.plan = options.plan;
    this.hosts = (options.relays ?? RELAYS).map((relay) => ({ relay, retryAt: 0, failures: 0, lastError: '' }));
    this.dial = options.dial ?? ((url, protocols) => new WebSocket(url, protocols) as unknown as Wire);
    this.read = options.read ?? (async (url) => (await fetch(url)).text());
    this.onConnect = options.onConnect ?? (() => {});
    this.idleMs = options.idleMs ?? IDLE_MS;
    this.log = options.log ?? ((line) => console.log(line));
  }

  /**
   * The rows as they stand right now, connecting first if need be. Throws RelayDown when no
   * relay can be had at the moment. Every call counts as "someone is looking".
   */
  async ready(): Promise<Tables> {
    this.lastAsk = Date.now();
    this.armIdle();

    if (this.state === 'live') {
      // A socket that has been silent a while may have died without saying so. One tiny question settles it.
      if (Date.now() - this.lastFrame < QUIET_MS || (await this.ping())) {
        if (this.state === 'live') return this.tables;
      } else if (this.state === 'live') {
        this.log('Relay: the connection had gone quiet and did not answer. Connecting again.');
        this.shut();
      }
    }
    if (this.state === 'off') {
      if (!this.nextHost()) throw new RelayDown(`Leaving the relay alone for another ${this.heldOffSeconds()} s (${this.lastError}).`);
      void this.connect();
    }
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  /** Have the plan looked at again now, because what it wants has changed (someone opened a chest's log). */
  async extend(): Promise<Tables> {
    const tables = await this.ready();
    this.rounds = 0;
    const waiting = new Promise<Tables>((resolve, reject) => this.waiters.push({ resolve, reject }));
    // With nothing new to ask this settles at once; otherwise when the new questions are answered.
    this.guarded(() => this.step());
    return this.state === 'live' && !this.waiters.length ? tables : waiting;
  }

  /** For the status page. */
  status() {
    const now = Date.now();
    let rows = 0;
    for (const table of this.tables.values()) rows += table.size;
    return {
      host: this.wire ? (this.host?.relay.name ?? null) : null,
      database: database(this.region),
      state: this.state,
      sockets: this.wire ? 1 : 0,
      questions: this.sent.size,
      rows,
      liveForSeconds: this.state === 'live' ? Math.round((now - this.liveSince) / 1000) : 0,
      lastChangeSecondsAgo: this.lastFrame ? Math.round((now - this.lastFrame) / 1000) : null,
      lastAskedSecondsAgo: this.lastAsk ? Math.round((now - this.lastAsk) / 1000) : null,
      closesAfterIdleMinutes: this.idleMs / 60_000,
      heldOffForSeconds: this.state === 'off' ? this.heldOffSeconds() : 0,
      lastProblem: this.lastError || null,
      relays: this.hosts.map((h) => ({ host: h.relay.name, heldOffForSeconds: Math.max(0, Math.ceil((h.retryAt - now) / 1000)), lastProblem: h.lastError || null })),
      sinceStart: { ...this.counts },
    };
  }

  /** Hang up and forget everything. */
  close() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.shut(new RelayDown('The relay connection was closed.'));
  }

  // ---- connecting -----------------------------------------------------------------

  /** The first relay, in order of preference, that is not being left alone right now. */
  private nextHost(): Standing | undefined {
    const now = Date.now();
    return this.hosts.find((h) => h.retryAt <= now);
  }

  /** How long until some relay may be tried again. */
  private heldOffSeconds() {
    return Math.max(0, Math.ceil((Math.min(...this.hosts.map((h) => h.retryAt)) - Date.now()) / 1000));
  }

  private async connect() {
    const host = this.nextHost();
    if (!host) return this.shut(new RelayDown('No relay is answering.'));
    this.host = host;
    this.state = 'opening';
    this.counts.connections++;
    this.clear();
    this.arm(CONNECT_MS, 'it did not answer in time');

    if (this.needLayout) await this.learnLayout(host);
    if (this.state !== 'opening' || this.host !== host) return;

    let wire: Wire;
    try {
      this.onConnect();
      wire = this.dial(host.relay.socket(this.region), [PROTOCOL]);
    } catch (err) {
      return this.fail(`a socket could not be opened (${(err as Error).message})`);
    }
    this.wire = wire;
    wire.onopen = () => {
      if (this.wire !== wire) return;
      this.guarded(() => {
        const first = this.plan(this.tables).slice(0, MAX_QUERIES);
        for (const sql of first) this.sent.add(sql);
        this.state = 'settling';
        this.awaiting = 1;
        this.send({ Subscribe: { request_id: 1, query_strings: first } });
      });
    };
    wire.onmessage = (ev) => {
      const { data } = ev;
      if (this.wire === wire && typeof data === 'string') this.guarded(() => this.frame(data));
    };
    wire.onerror = () => {
      try {
        wire.close();
      } catch {
        /* already gone */
      }
    };
    wire.onclose = () => {
      if (this.wire !== wire) return;
      this.wire = null;
      if (this.state === 'live') {
        // It was working and the other end hung up. Nothing to hold against it: the next ask connects again.
        this.log(`Relay: ${host.relay.name} closed the connection. The next page that asks connects again.`);
        host.retryAt = Date.now() + 2_000;
        this.shut();
      } else this.fail('the connection closed before it had answered');
    };
  }

  private send(message: unknown) {
    try {
      this.wire?.send(JSON.stringify(message));
    } catch {
      /* a socket that cannot be written to closes, and that is handled there */
    }
  }

  /**
   * Everything that runs because the socket said something goes through here. A surprise in
   * what came back ends this connection and nothing more: it never reaches the rest of the server.
   */
  private guarded(work: () => void) {
    try {
      work();
    } catch (err) {
      this.fail(`something it sent could not be read (${(err as Error).message})`);
    }
  }

  // ---- what comes back ------------------------------------------------------------

  private frame(text: string) {
    let message: any;
    try {
      // Rows are text inside the frame, so the frame itself parses safely; each row is parsed in `named`.
      message = JSON.parse(text);
    } catch {
      return;
    }
    this.lastFrame = Date.now();
    this.counts.frames++;

    if (message.InitialSubscription) {
      this.apply(message.InitialSubscription.database_update);
      this.answered();
    } else if (message.SubscribeMultiApplied) {
      const pong = this.pings.get(Number(message.SubscribeMultiApplied.query_id?.id));
      if (pong) return pong();
      this.apply(message.SubscribeMultiApplied.update);
      this.answered();
    } else if (message.TransactionUpdate) {
      const committed = message.TransactionUpdate.status?.Committed;
      if (!committed) return;
      this.apply(committed);
      if (this.misfit) return this.fail(`its "${this.misfit}" table has changed shape`);
      // A change can bring something new to ask about (someone parked a new cart): look once the burst is over.
      if (this.state === 'live' && !this.soonTimer) {
        this.soonTimer = setTimeout(() => {
          this.soonTimer = null;
          if (this.state !== 'live') return;
          this.rounds = 0;
          this.guarded(() => this.step());
        }, 150);
        this.soonTimer.unref?.();
      }
    } else if (message.SubscriptionError) {
      this.fail(`it refused a question (${String(message.SubscriptionError.error ?? '').slice(0, 160)})`);
    }
    // IdentityToken, UnsubscribeMultiApplied and anything unrecognised need no action.
  }

  /** A set of questions has been answered. */
  private answered() {
    this.awaiting = Math.max(0, this.awaiting - 1);
    if (this.misfit) return this.fail(`its "${this.misfit}" table has changed shape`);
    this.step();
  }

  /** Ask whatever the plan now wants that has not been asked; with nothing left to ask, the picture is complete. */
  private step() {
    if (!this.wire || this.awaiting > 0) return;
    const more = this.rounds < MAX_ROUNDS ? this.plan(this.tables).filter((sql) => !this.sent.has(sql)).slice(0, MAX_QUERIES - this.sent.size) : [];
    if (more.length) {
      this.rounds++;
      this.awaiting++;
      this.state = 'settling';
      for (const sql of more) this.sent.add(sql);
      const id = this.nextSet++;
      this.arm(STEP_MS, 'it stopped answering');
      this.send({ SubscribeMulti: { request_id: id, query_id: { id }, query_strings: more } });
      return;
    }
    this.disarm();
    this.state = 'live';
    this.lastError = '';
    if (this.host) {
      this.host.failures = 0;
      this.host.lastError = '';
    }
    if (!this.liveSince) {
      // The first complete picture on this connection.
      this.liveSince = Date.now();
      let rows = 0;
      for (const table of this.tables.values()) rows += table.size;
      this.log(`Relay: live on ${this.host?.relay.name} (${database(this.region)}) with ${this.sent.size} questions open and ${rows} rows.`);
    }
    for (const waiter of this.waiters.splice(0)) waiter.resolve(this.tables);
  }

  private apply(update: any) {
    for (const part of update?.tables ?? []) {
      const name = String(part.table_name);
      let table = this.tables.get(name);
      if (!table) this.tables.set(name, (table = new Map()));
      for (const u of part.updates ?? []) {
        // A changed row arrives as its old copy to drop and its new copy to keep, so drops go first.
        for (const raw of u.deletes ?? []) {
          const row = this.named(name, raw);
          if (row) table.delete(keyOf(row));
        }
        for (const raw of u.inserts ?? []) {
          const row = this.named(name, raw);
          if (row) table.set(keyOf(row), row);
        }
      }
    }
  }

  /** One row as text → a row by column name. BitCraftSync's relay names its first answers itself; bare lists are named here. */
  private named(table: string, raw: unknown): Row | null {
    let value: unknown;
    try {
      value = typeof raw === 'string' ? JSON.parse(quoteLongNumbers(raw)) : raw;
    } catch {
      return null;
    }
    if (Array.isArray(value)) {
      const columns = this.columns[table];
      if (!columns || columns.length !== value.length) {
        this.misfit = table;
        this.needLayout = true;
        return null;
      }
      const row: Row = {};
      for (let i = 0; i < columns.length; i++) row[columns[i]] = value[i];
      return row;
    }
    return value && typeof value === 'object' ? (value as Row) : null;
  }

  /**
   * A game patch can add a column to a table, and then its rows no longer fit the lists at
   * the top of this file. The relays publish the layout they mirror, so that is read (one
   * request, at most every ten minutes) and the column names taken from it.
   */
  private async learnLayout(host: Standing) {
    if (Date.now() - this.layoutAt < LAYOUT_EVERY_MS) return;
    this.layoutAt = Date.now();
    try {
      const layout = JSON.parse(await this.read(host.relay.layout(this.region)));
      const types = layout?.typespace?.types ?? [];
      for (const table of layout?.tables ?? []) {
        const elements = types[table.product_type_ref]?.Product?.elements;
        if (!elements || !(table.name in COLUMNS)) continue;
        this.columns[table.name] = elements.map((e: any) => String(e?.name?.some ?? ''));
      }
      this.needLayout = false;
      this.log(`Relay: read ${host.relay.name}'s table layout again, because a row no longer fitted.`);
    } catch (err) {
      this.log(`Relay: could not read ${host.relay.name}'s table layout (${(err as Error).message}).`);
    }
  }

  // ---- checking a quiet socket ----------------------------------------------------

  /**
   * Asks one question that matches nothing and waits for the (empty) answer. The answer
   * coming back at all is the point: this socket is still alive.
   */
  private ping(): Promise<boolean> {
    if (this.pinging) return this.pinging;
    const wire = this.wire;
    if (!wire) return Promise.resolve(false);
    const id = this.pingSeq++;
    const check = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pings.delete(id);
        resolve(false);
      }, PING_MS);
      timer.unref?.();
      this.pings.set(id, () => {
        clearTimeout(timer);
        this.pings.delete(id);
        if (this.wire === wire) this.send({ UnsubscribeMulti: { request_id: id, query_id: { id } } });
        resolve(this.wire === wire);
      });
      this.send({ SubscribeMulti: { request_id: id, query_id: { id }, query_strings: ['SELECT * FROM world_region_name_state WHERE id = 65535'] } });
    }).finally(() => {
      this.pinging = null;
    });
    this.pinging = check;
    return check;
  }

  // ---- giving up, and going quiet -------------------------------------------------

  private arm(ms: number, what: string) {
    this.disarm();
    this.stepTimer = setTimeout(() => this.fail(what), ms);
    this.stepTimer.unref?.();
  }

  private disarm() {
    if (this.stepTimer) clearTimeout(this.stepTimer);
    this.stepTimer = null;
  }

  private armIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.state === 'off') return;
      this.log(`Relay: no page has asked for ${Math.round(this.idleMs / 60_000)} minutes. Closing the connection.`);
      this.shut(new RelayDown('The relay connection was closed for lack of use.'));
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  /**
   * This connection did not work out. That relay is left alone for a while. If pages are
   * waiting and the other relay may be tried, it is, at once; otherwise they are told to
   * read the slower way.
   */
  private fail(reason: string) {
    const host = this.host;
    this.counts.failed++;
    this.lastError = host ? `${host.relay.name}: ${reason}` : reason;
    if (host) {
      host.failures++;
      host.lastError = reason;
      host.retryAt = Date.now() + Math.min(HOLD_OFF_MS * 2 ** (host.failures - 1), MAX_HOLD_OFF_MS);
    }
    const other = this.nextHost();
    if (other && this.waiters.length) {
      this.log(`Relay: ${this.lastError}. Trying ${other.relay.name} instead.`);
      this.hangUp();
      void this.connect();
      return;
    }
    this.log(`Relay: ${this.lastError}. ${other ? `${other.relay.name} is tried next.` : `Reading the slower way for the next ${this.heldOffSeconds()} s.`}`);
    this.shut(new RelayDown(`The relay is not answering (${this.lastError}).`));
  }

  /** Forget this connection's rows and questions. */
  private clear() {
    this.disarm();
    if (this.soonTimer) clearTimeout(this.soonTimer);
    this.soonTimer = null;
    this.tables = new Map();
    this.sent = new Set();
    this.awaiting = 0;
    this.rounds = 0;
    this.misfit = null;
    this.liveSince = 0;
  }

  /** Close the socket and forget what it held. Pages waiting are left waiting. */
  private hangUp() {
    const wire = this.wire;
    this.wire = null;
    this.state = 'off';
    this.clear();
    for (const pong of [...this.pings.values()]) pong();
    try {
      wire?.close();
    } catch {
      /* already gone */
    }
  }

  private shut(why: Error = new RelayDown('The relay connection is being made again.')) {
    this.hangUp();
    for (const waiter of this.waiters.splice(0)) waiter.reject(why);
  }
}
