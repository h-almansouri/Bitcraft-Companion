import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Feed, RELAYS, RelayDown, quoteLongNumbers, type RelayHost, type Tables, type Wire } from '../server/relay.ts';

/** A stand-in for the relay: it records every socket opened and everything said on each. */
class Line implements Wire {
  sent: any[] = [];
  closed = false;
  onopen: Wire['onopen'] = null;
  onmessage: Wire['onmessage'] = null;
  onclose: Wire['onclose'] = null;
  onerror: Wire['onerror'] = null;
  url: string;
  protocols: string[];
  constructor(url: string, protocols: string[]) {
    this.url = url;
    this.protocols = protocols;
  }
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
  open() {
    this.onopen?.();
  }
  say(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

/** Rows travel as text, the way the relay sends them: bare lists, ids as long numbers. */
const update = (tables: Record<string, { inserts?: string[]; deletes?: string[] }>) => ({
  tables: Object.entries(tables).map(([table_name, u]) => ({ table_name, updates: [{ inserts: u.inserts ?? [], deletes: u.deletes ?? [] }] })),
});
const firstAnswer = (tables: Record<string, { inserts?: string[] }>) => ({ InitialSubscription: { database_update: update(tables) } });
const setAnswer = (id: number, tables: Record<string, { inserts?: string[] }>) => ({ SubscribeMultiApplied: { query_id: { id }, update: update(tables) } });
const change = (tables: Record<string, { inserts?: string[]; deletes?: string[] }>) => ({ TransactionUpdate: { status: { Committed: update(tables) } } });

const CLAIM = '576460753011209206';
const CHEST = '576460753013682765';

/** One relay unless a test is about having two. */
function setup(plan: (tables: Tables) => string[] = () => ['Q1'], relays: RelayHost[] = [RELAYS[0]]) {
  const lines: Line[] = [];
  const said: string[] = [];
  const read = vi.fn(async (_url: string) => '{}');
  const feed = new Feed({
    region: 8,
    plan,
    relays,
    dial: (url, protocols) => {
      const line = new Line(url, protocols);
      lines.push(line);
      return line;
    },
    read,
    log: (text) => said.push(text),
  });
  return { feed, lines, said, read };
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-11-27T12:00:00Z') });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('reading long ids safely', () => {
  it('turns ids too long for a number into text, and nothing else', () => {
    const row = JSON.parse(quoteLongNumbers(`[${CLAIM},26949,0.0,[0,[18916,-14775,1]],1.0,-1795222565576075]`));
    expect(row).toEqual([CLAIM, 26949, 0, [0, [18916, -14775, 1]], 1, '-1795222565576075']);
    expect(JSON.parse(quoteLongNumbers('[1.2345678901234567e+30,0.12345678901234567890]'))[0]).toBe(1.2345678901234567e30);
  });

  it('leaves digits inside a nickname alone', () => {
    const raw = `[${CHEST},"box 12345678901234567890, \\"old\\" 1234567890123456"]`;
    expect(JSON.parse(quoteLongNumbers(raw))).toEqual([CHEST, 'box 12345678901234567890, "old" 1234567890123456']);
  });
});

describe('the one connection to the relay', () => {
  it('asks its questions on one socket, follows up on the same socket, and keeps the rows', async () => {
    // The plan wants the claim first, then (once it knows the claim) one of its chests.
    const { feed, lines } = setup((tables) => (tables.get('claim_state')?.size ? ['the claim', 'the chest'] : ['the claim']));
    const asking = feed.ready();
    expect(lines).toHaveLength(1);
    expect(lines[0].url).toBe('wss://relay.bitjita.com/v1/database/idc-8/subscribe?compression=None');
    expect(lines[0].protocols).toEqual(['v1.json.spacetimedb']);

    lines[0].open();
    expect(lines[0].sent).toEqual([{ Subscribe: { request_id: 1, query_strings: ['the claim'] } }]);

    lines[0].say({ IdentityToken: {} });
    lines[0].say(firstAnswer({ claim_state: { inserts: [`[${CLAIM},504403158637633563,576460753011209185,"Nowhere",false]`] } }));
    const followUp = lines[0].sent[1].SubscribeMulti;
    expect(followUp.query_strings).toEqual(['the chest']);

    lines[0].say(setAnswer(followUp.query_id.id, { building_nickname_state: { inserts: [`[${CHEST},"Mason"]`] } }));
    const tables = await asking;
    expect(tables.get('claim_state')!.get(CLAIM)).toEqual({ entity_id: CLAIM, owner_player_entity_id: '504403158637633563', owner_building_entity_id: '576460753011209185', name: 'Nowhere', neutral: false });
    expect(tables.get('building_nickname_state')!.get(CHEST)!.nickname).toBe('Mason');

    // Asking again is answered from memory: nothing more is sent, no second socket.
    await feed.ready();
    expect(lines).toHaveLength(1);
    expect(lines[0].sent).toHaveLength(2);
    expect(feed.status()).toMatchObject({ state: 'live', sockets: 1, questions: 2, rows: 2 });
  });

  it('serves any number of pages asking at once from that one socket', async () => {
    const { feed, lines } = setup();
    const pages = Array.from({ length: 25 }, () => feed.ready());
    lines[0].open();
    lines[0].say(firstAnswer({}));
    await Promise.all(pages);
    expect(lines).toHaveLength(1);
    expect(lines[0].sent).toHaveLength(1);
  });

  it('keeps its rows current as the game changes', async () => {
    const { feed, lines } = setup();
    const asking = feed.ready();
    lines[0].open();
    lines[0].say(firstAnswer({ building_nickname_state: { inserts: [`[${CHEST},"Mason"]`, '[576460753013681456,"Wood"]'] } }));
    const tables = await asking;

    // A renamed chest arrives as its old row to drop and its new row to keep; a removed one as a drop alone.
    lines[0].say(change({ building_nickname_state: { deletes: [`[${CHEST},"Mason"]`, '[576460753013681456,"Wood"]'], inserts: [`[${CHEST},"Masonry"]`] } }));
    expect([...tables.get('building_nickname_state')!.values()]).toEqual([{ entity_id: CHEST, nickname: 'Masonry' }]);
  });

  it('asks about new things a change brings, still on the same socket', async () => {
    const { feed, lines } = setup((tables) => ['base', ...[...(tables.get('deployable_state_v2')?.keys() ?? [])].map((cart) => `inside ${cart}`)]);
    const asking = feed.ready();
    lines[0].open();
    lines[0].say(firstAnswer({}));
    await asking;

    lines[0].say(change({ deployable_state_v2: { inserts: ['[576460752796069543,1008806316829587226,0,3,1596080513,"chels\'s Cart (II)",false,0]'] } }));
    await vi.advanceTimersByTimeAsync(200);
    expect(lines[0].sent.at(-1).SubscribeMulti.query_strings).toEqual(['inside 576460752796069543']);
    expect(lines).toHaveLength(1);
  });

  it('gives up on a relay that does not answer, and leaves it alone for a while', async () => {
    const { feed, lines } = setup();
    const asking = feed.ready();
    const failed = expect(asking).rejects.toBeInstanceOf(RelayDown);
    lines[0].open();
    await vi.advanceTimersByTimeAsync(10_000);
    await failed;
    expect(lines[0].closed).toBe(true);

    // For the next minute nobody dials: asks are turned away at once, so the caller reads the slower way.
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(feed.ready()).rejects.toBeInstanceOf(RelayDown);
    expect(lines).toHaveLength(1);

    // After that, the next ask tries again.
    await vi.advanceTimersByTimeAsync(31_000);
    const again = feed.ready();
    expect(lines).toHaveLength(2);
    lines[1].open();
    lines[1].say(firstAnswer({}));
    await again;
    expect(feed.status()).toMatchObject({ state: 'live', lastProblem: null });
  });

  it('waits longer each time the relay stays down, up to ten minutes', async () => {
    const { feed, lines } = setup();
    const waits: number[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      const failed = expect(feed.ready()).rejects.toBeInstanceOf(RelayDown);
      lines.at(-1)!.close();
      await failed;
      waits.push(feed.status().heldOffForSeconds);
      await vi.advanceTimersByTimeAsync(waits.at(-1)! * 1000 + 1);
    }
    expect(waits).toEqual([60, 120, 240, 480, 600, 600]);
  });

  it('hangs up once no page has asked for 20 minutes, and connects again when one does', async () => {
    const { feed, lines } = setup();
    const asking = feed.ready();
    lines[0].open();
    lines[0].say(firstAnswer({}));
    await asking;

    await vi.advanceTimersByTimeAsync(20 * 60_000 + 1);
    expect(lines[0].closed).toBe(true);
    expect(feed.status()).toMatchObject({ state: 'off', sockets: 0, rows: 0 });

    const later = feed.ready();
    expect(lines).toHaveLength(2);
    lines[1].open();
    lines[1].say(firstAnswer({}));
    await later;
  });

  it('checks a socket that has gone quiet before trusting what it holds', async () => {
    const { feed, lines } = setup();
    const asking = feed.ready();
    lines[0].open();
    lines[0].say(firstAnswer({}));
    await asking;

    // Quiet for a minute. The next ask sends one question that matches nothing; the answer proves the socket lives.
    await vi.advanceTimersByTimeAsync(60_000);
    const checked = feed.ready();
    const ping = lines[0].sent.at(-1).SubscribeMulti;
    expect(ping.query_strings).toEqual(['SELECT * FROM world_region_name_state WHERE id = 65535']);
    lines[0].say(setAnswer(ping.query_id.id, {}));
    await checked;
    expect(lines[0].sent.at(-1)).toEqual({ UnsubscribeMulti: { request_id: ping.query_id.id, query_id: { id: ping.query_id.id } } });
    expect(lines).toHaveLength(1);

    // Quiet again, and this time nothing comes back: the socket is dead, so a new one is opened.
    await vi.advanceTimersByTimeAsync(60_000);
    const recovered = feed.ready();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(lines).toHaveLength(2);
    expect(lines[0].closed).toBe(true);
    lines[1].open();
    lines[1].say(firstAnswer({}));
    await recovered;
  });

  it('connects again when the relay hangs up on a working connection', async () => {
    const { feed, lines } = setup();
    const asking = feed.ready();
    lines[0].open();
    lines[0].say(firstAnswer({ building_nickname_state: { inserts: [`[${CHEST},"Mason"]`] } }));
    await asking;

    lines[0].close();
    expect(feed.status()).toMatchObject({ state: 'off', rows: 0 });
    await vi.advanceTimersByTimeAsync(2_001);
    const again = feed.ready();
    expect(lines).toHaveLength(2);
    lines[1].open();
    lines[1].say(firstAnswer({}));
    await again;
  });

  it("reads the relay's table layout again when a game patch changes a table", async () => {
    const { feed, lines, read } = setup();
    read.mockResolvedValue(
      JSON.stringify({
        typespace: { types: [{ Product: { elements: [{ name: { some: 'entity_id' } }, { name: { some: 'nickname' } }, { name: { some: 'colour' } }] } }] },
        tables: [{ name: 'building_nickname_state', product_type_ref: 0 }],
      }),
    );
    const failed = expect(feed.ready()).rejects.toBeInstanceOf(RelayDown);
    lines[0].open();
    // A third column nobody here knows about: the row cannot be named, so nothing from this connection is trusted.
    lines[0].say(firstAnswer({ building_nickname_state: { inserts: [`[${CHEST},"Mason","red"]`] } }));
    await failed;
    expect(read).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_001);
    const again = feed.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledWith('https://relay.bitjita.com/v1/database/idc-8/schema?version=9');
    lines[1].open();
    lines[1].say(firstAnswer({ building_nickname_state: { inserts: [`[${CHEST},"Mason","red"]`] } }));
    const tables = await again;
    expect(tables.get('building_nickname_state')!.get(CHEST)).toEqual({ entity_id: CHEST, nickname: 'Mason', colour: 'red' });
  });

  it('ends the connection, and nothing else, when something that came back cannot be handled', async () => {
    // A plan that trips over what it is shown stands in for any surprise in the relay's data.
    const { feed, lines } = setup((tables) => {
      if (tables.get('building_nickname_state')?.size) throw new Error('unexpected row');
      return ['Q1'];
    });
    const failed = expect(feed.ready()).rejects.toBeInstanceOf(RelayDown);
    lines[0].open();
    expect(() => lines[0].say(firstAnswer({ building_nickname_state: { inserts: [`[${CHEST},"Mason"]`] } }))).not.toThrow();
    await failed;
    expect(lines[0].closed).toBe(true);
    expect(feed.status()).toMatchObject({ state: 'off', sockets: 0, heldOffForSeconds: 60 });
    expect(feed.status().lastProblem).toMatch(/could not be read \(unexpected row\)/);
  });

  it('asks again on the same socket when a page wants something more, such as a chest log', async () => {
    const wanted = ['base'];
    const { feed, lines } = setup(() => [...wanted]);
    const asking = feed.ready();
    lines[0].open();
    lines[0].say(firstAnswer({}));
    await asking;

    // Nothing new wanted: answered at once, nothing sent.
    await feed.extend();
    expect(lines[0].sent).toHaveLength(1);

    wanted.push('the log of one chest');
    const extended = feed.extend();
    await vi.advanceTimersByTimeAsync(0);
    const more = lines[0].sent.at(-1).SubscribeMulti;
    expect(more.query_strings).toEqual(['the log of one chest']);
    lines[0].say(setAnswer(more.query_id.id, { storage_log_state: { inserts: [`[508256,${CHEST},504403158637633563,"Velcruza",[0,[]],[2,[3050001,10,[0,[]],[1,[]]]],[1795222565576075],20778]`] } }));
    const tables = await extended;
    expect(tables.get('storage_log_state')!.get('508256')).toMatchObject({ object_entity_id: CHEST, subject_name: 'Velcruza', timestamp: ['1795222565576075'] });
    expect(lines).toHaveLength(1);
  });

  it("reads rows from the relay that names them itself, and its changes as bare lists", async () => {
    // BitCraftSync's relay sends its first answer as named rows, with empty choices written {} rather than [].
    const { feed, lines } = setup(undefined, [RELAYS[1]]);
    const asking = feed.ready();
    expect(lines[0].url).toBe('wss://relay.bitcraftsync.app:3008/v1/database/idc-8/subscribe?compression=None');
    lines[0].open();
    lines[0].say(
      firstAnswer({
        passive_craft_state: {
          inserts: ['{"entity_id":576460752778387933,"owner_entity_id":504403158640306614,"recipe_id":107011,"building_entity_id":576460752724785994,"timestamp":{"__timestamp_micros_since_unix_epoch__":1794605797219410},"status":[2,{}],"slot":[1,{}]}'],
        },
      }),
    );
    const tables = await asking;
    expect(tables.get('passive_craft_state')!.get('576460752778387933')).toEqual({
      entity_id: '576460752778387933',
      owner_entity_id: '504403158640306614',
      recipe_id: 107011,
      building_entity_id: '576460752724785994',
      timestamp: { __timestamp_micros_since_unix_epoch__: '1794605797219410' },
      status: [2, {}],
      slot: [1, {}],
    });
    lines[0].say(change({ passive_craft_state: { deletes: ['[576460752778387933,504403158640306614,107011,576460752724785994,[1794605797219410],[2,[]],[1,[]]]'] } }));
    expect(tables.get('passive_craft_state')!.size).toBe(0);
  });

  it('moves to the other relay when the first does not answer, with the pages still waiting', async () => {
    const { feed, lines, said } = setup(undefined, RELAYS);
    const asking = feed.ready();
    expect(lines[0].url).toContain('relay.bitjita.com');
    // The first choice never answers.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lines[0].closed).toBe(true);
    expect(lines).toHaveLength(2);
    expect(lines[1].url).toContain('relay.bitcraftsync.app');
    lines[1].open();
    lines[1].say(firstAnswer({}));
    await asking;
    expect(feed.status()).toMatchObject({ state: 'live', host: 'relay.bitcraftsync.app', sockets: 1 });
    expect(feed.status().relays).toMatchObject([{ host: 'relay.bitjita.com', heldOffForSeconds: 60 }, { host: 'relay.bitcraftsync.app', heldOffForSeconds: 0, lastProblem: null }]);
    expect(said.join('\n')).toMatch(/relay\.bitjita\.com: it did not answer in time\. Trying relay\.bitcraftsync\.app instead/);

    // It stays where it is while that works, rather than hopping back and forth…
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    lines[1].say(change({}));
    await feed.ready();
    expect(lines).toHaveLength(2);

    // …and goes back to the first choice the next time it has to connect anyway.
    await vi.advanceTimersByTimeAsync(20 * 60_000 + 1);
    expect(lines[1].closed).toBe(true);
    const later = feed.ready();
    expect(lines[2].url).toContain('relay.bitjita.com');
    lines[2].open();
    lines[2].say(firstAnswer({}));
    await later;
    expect(lines.filter((line) => !line.closed)).toHaveLength(1);
  });

  it('tells the pages to read the slower way only when neither relay can be had', async () => {
    const { feed, lines } = setup(undefined, RELAYS);
    const failed = expect(feed.ready()).rejects.toBeInstanceOf(RelayDown);
    lines[0].close();
    expect(lines).toHaveLength(2);
    lines[1].close();
    await failed;
    expect(feed.status()).toMatchObject({ state: 'off', sockets: 0, heldOffForSeconds: 60 });
    await expect(feed.ready()).rejects.toBeInstanceOf(RelayDown);
    expect(lines).toHaveLength(2);
  });

  it('never has more than one socket open, whatever happens', async () => {
    const { feed, lines } = setup();
    const open = () => lines.filter((line) => !line.closed).length;
    const first = feed.ready();
    lines[0].open();
    lines[0].say(firstAnswer({}));
    await first;
    for (let round = 0; round < 5; round++) {
      await vi.advanceTimersByTimeAsync(60_000);
      const asks = [feed.ready(), feed.ready(), feed.extend()];
      expect(open()).toBeLessThanOrEqual(1);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(open()).toBeLessThanOrEqual(1);
      const line = lines.at(-1)!;
      line.open();
      line.say(firstAnswer({}));
      await Promise.all(asks);
      expect(open()).toBe(1);
    }
  });
});
