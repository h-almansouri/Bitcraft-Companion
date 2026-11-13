#!/usr/bin/env node
'use strict';
/*
 * BitCraft old-world token test — READ ONLY
 * ------------------------------------------------------------------------------------------------
 * Checks what a player's own login token can read straight from the game server for the old
 * (Early Access) world, now that the community relays have moved on to the 1.0 world.
 *
 *   node tools/oldworld-token-test.js            run the test (logs in first if no token is saved)
 *   node tools/oldworld-token-test.js watch      stay connected and print live changes (--minutes N, default 15)
 *   node tools/oldworld-token-test.js login      throw away the saved token, log in again, run the test
 *   node tools/oldworld-token-test.js code       log in with a code that already arrived (requests no new one)
 *   node tools/oldworld-token-test.js forget     delete the saved token from this PC
 *
 * Options:  --friend <name or character id>   skip the "friend" question
 *           --no-friend                       don't look anyone else up
 *           --yes                             skip the "this may kick you" confirmation
 *
 * What it does: connects with YOUR token, runs a few small indexed queries (your character, your
 * inventories and crafts, optionally one other player's), prints a summary, disconnects. It never
 * calls a reducer (a game action) — third-party tools must not.
 *
 * watch does the same reads but keeps the one connection open: it prints each change as the server
 * pushes it, adds and drops a query while running, and never reconnects by itself (a reconnect is
 * what kicks the player out of the game).
 *
 * The token is your full game login. It is kept in your user folder, OUTSIDE this project, so it
 * can never be committed:   ~/.bitcraft-companion/oldworld-token.txt
 * It is sent only to BitCraft's own servers, and is never printed or written to the log.
 *
 * Server rules this test is checking (BitCraftPublic, packages/game/src/lib.rs identity_connected):
 *   - a player login is only admitted to the region its character is standing in
 *   - it needs a game-client login within the last 24 hours
 *   - the newest connection wins: connecting while playing takes the game session over, and the
 *     server signs the character out when that connection closes
 *
 * Developer checks that need no login (not part of the normal flow):
 *   --selftest <player name> [--regions 8]   the same read code against the public 1.0 relay
 *   BC_ANON=1                                real server, no token (exercises the refusal path)
 *   BC_TOKEN_FILE / BC_LOG_FILE              use a different token / log file
 *   BC_SELFTEST_EXTRA="<sql>;<sql>"          watch self-test: one more live query, for real traffic
 *   BC_REPLAY=<file.json>                    watch self-test: push hand-made live updates through
 */
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const GAME_HOST = 'bitcraft-early-access.spacetimedb.com';
const LOGIN_API = 'https://api.bitcraftonline.com/authentication';
const OLD_WORLD_REGIONS = [3, 7, 8, 9, 11, 12, 13, 14, 15, 17, 18, 19, 23];
const TOKEN_FILE = process.env.BC_TOKEN_FILE || path.join(os.homedir(), '.bitcraft-companion', 'oldworld-token.txt');
const LOG_FILE = process.env.BC_LOG_FILE || path.join(__dirname, 'oldworld-test-log.txt');
const SCRIPT = 'node tools/oldworld-token-test.js';
const PERSONAL = { 0: 'Inventory', 1: 'Toolbelt', 2: 'Wallet' };
// Column order per table (old-world schema, 2026-11-12). Only used if a row arrives as a bare array;
// snapshot rows normally arrive as named objects.
const COLS = {
  user_state: ['identity', 'entity_id', 'can_sign_in'],
  player_username_state: ['entity_id', 'username'],
  player_lowercase_username_state: ['entity_id', 'username_lowercase'],
  signed_in_player_state: ['entity_id'],
  inventory_state: ['entity_id', 'pockets', 'inventory_index', 'cargo_index', 'owner_entity_id', 'player_owner_entity_id'],
  progressive_action_state: ['entity_id', 'building_entity_id', 'function_type', 'progress', 'recipe_id', 'craft_count', 'last_crit_outcome', 'owner_entity_id', 'lock_expiration', 'preparation'],
  passive_craft_state: ['entity_id', 'owner_entity_id', 'recipe_id', 'building_entity_id', 'timestamp', 'status', 'slot'],
  item_desc: ['id', 'name'],
  cargo_desc: ['id', 'name'],
  world_region_name_state: ['id', 'player_facing_name', 'module_name_prefix'],
  mobile_entity_state: ['entity_id', 'chunk_index', 'timestamp', 'location_x', 'location_z', 'destination_x', 'destination_z', 'dimension', 'is_walking', '_pad1', '_pad2', '_pad3'],
};
const seenCols = {};   // table -> column order captured from the first named row; beats COLS for bare-array rows (live updates can arrive that way)

// ───────────────────────────── arguments ─────────────────────────────
const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0].toLowerCase() : 'test';
const flag = name => argv.includes('--' + name);
const opt = name => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] != null && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; };
const SELFTEST = flag('selftest');
const SELF_NAME = opt('selftest') || '';
const ANON = process.env.BC_ANON === '1';
const REGIONS = (opt('regions') || '').split(',').map(Number).filter(n => n > 0 && n < 100);

// ───────────────────────────── output + log ─────────────────────────────
let SECRET = null;                       // the token, once known: scrubbed from anything printed or logged
const logLines = [];
const samples = {};                      // table -> start of its first raw row (so odd shapes can be diagnosed later)
const scrub = s => {
  s = String(s == null ? '' : s);
  if (SECRET) s = s.split(SECRET).join('<token>');
  return s.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '<token>');
};
const clean = s => scrub(s).replace(/[^\s"'<>=&?]+@[^\s"'<>&]+/g, '<email>').replace(/\s+/g, ' ').trim();
function say(s = '') { s = scrub(s); console.log(s); logLines.push(s); }
const fmt = n => Number(n).toLocaleString('en-US');
const sleep = ms => new Promise(r => setTimeout(r, ms));
function flushLog() {
  try {
    const extra = Object.keys(samples).length
      ? ['', '--- first row of each table as it arrived (for diagnosing odd shapes) ---'].concat(Object.keys(samples).map(t => `${t}: ${scrub(samples[t])}`))
      : [];
    fs.appendFileSync(LOG_FILE, ['', '='.repeat(100)].concat(logLines, extra, ['']).join('\n'));
  } catch (e) { /* a missing log is not worth failing over */ }
}

// ───────────────────────────── keyboard input ─────────────────────────────
// One shared line reader, so answers typed (or piped) ahead are never lost between questions.
let rl = null, lineWaiter = null, inputClosed = false;
const pendingLines = [];
function ask(question) {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin });
    rl.on('line', l => { if (lineWaiter) { const w = lineWaiter; lineWaiter = null; w(l); } else pendingLines.push(l); });
    rl.on('close', () => { inputClosed = true; if (lineWaiter) { const w = lineWaiter; lineWaiter = null; w(null); } });
  }
  process.stdout.write(question);
  return new Promise(resolve => {
    const got = l => { if (l == null) process.stdout.write('\n'); resolve(l == null ? null : String(l).trim()); };
    if (pendingLines.length) return got(pendingLines.shift());
    if (inputClosed) return got(null);
    lineWaiter = got;
  });
}
function closeInput() { if (rl) { try { rl.close(); } catch (e) {} } }

// ───────────────────────────── the saved token ─────────────────────────────
const JWT = /^[A-Za-z0-9_\-+/=]{4,}\.[A-Za-z0-9_\-+/=]{4,}\.[A-Za-z0-9_\-+/=]{4,}$/;
function loadToken() {
  try { const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); return JWT.test(t) ? t : null; } catch (e) { return null; }
}
function saveToken(token) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 });
}
function forgetToken() {
  try { fs.unlinkSync(STATE_FILE); } catch (e) { /* nothing remembered */ }
  try { fs.unlinkSync(TOKEN_FILE); return true; } catch (e) { return false; }
}
// Small notes kept beside the token (never in the project): the region that last let this login in, so
// watch mode can go straight there instead of knocking on all 13 doors.
const STATE_FILE = path.join(path.dirname(TOKEN_FILE), 'oldworld-state.json');
function loadState() {
  try { const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); return s && typeof s === 'object' ? s : {}; } catch (e) { return {}; }
}
function saveState(patch) {
  try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(Object.assign(loadState(), patch))); }
  catch (e) { /* only a convenience */ }
}
function tokenFacts(token) {            // dates only — nothing identifying
  try {
    const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    const day = s => new Date(Number(s) * 1000).toISOString().slice(0, 10);
    return (p.iat ? `issued ${day(p.iat)}` : 'issue date not listed') + ', ' + (p.exp ? `expires ${day(p.exp)}` : 'no expiry date listed');
  } catch (e) { return 'dates not readable'; }
}
function extractToken(body) {           // the login service answers with the token as a JSON string
  let v = String(body || '').trim();
  try {
    const j = JSON.parse(v);
    if (typeof j === 'string') v = j;
    else if (j && typeof j === 'object') { const f = Object.values(j).find(x => typeof x === 'string' && JWT.test(x)); if (f) v = f; }
  } catch (e) { /* not JSON: use the text as it is */ }
  v = v.replace(/^"+|"+$/g, '').trim();
  return JWT.test(v) ? v : null;
}

// ───────────────────────────── logging in (email code → token) ─────────────────────────────
async function httpPost(url) {
  const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(20000) });
  return { status: res.status, body: await res.text() };
}
// haveCode = the email already arrived from an earlier request, so do not ask for another one (a new
// request would most likely cancel the code the user is holding).
async function login(haveCode) {
  say('');
  say('Logging in to get your token');
  if (haveCode) {
    say('  Using a code BitCraft already emailed you. No new code is requested.');
  } else {
    say('  BitCraft emails a one-time code to the address linked to your game account.');
    say('  (If you start the game with "Continue without email", no address is linked and this');
    say('  cannot work until you link one in the game: login screen, Link Account.)');
  }
  const email = await ask('  Your BitCraft account email: ');
  if (!email) { say('  No email entered. Stopped.'); return null; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { say('  That does not look like an email address. Stopped.'); return null; }
  if (!haveCode) {
    let r;
    try { r = await httpPost(`${LOGIN_API}/request-access-code?email=${encodeURIComponent(email)}`); }
    catch (e) { say('  Could not reach the BitCraft login service: ' + clean(e.message)); return null; }
    if (r.status < 200 || r.status >= 300) { say(`  The login service refused the request (HTTP ${r.status}): ${clean(r.body).slice(0, 160)}`); return null; }
    say(`  Code requested (the login service answered HTTP ${r.status}).`);
    say('  Look for an email with the subject "BitCraft Access Code". Check Junk too, and the "Other"');
    say('  tab if your inbox is split. Outlook, Hotmail, Live and Yahoo addresses often junk or delay it.');
    say('  No rush: leave this waiting, or press Enter to stop and use the code later with:');
    say(`    ${SCRIPT} code`);
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    const code = await ask('  Code from the email: ');
    if (!code) { say(`  No code entered. Stopped. When the email arrives, run:  ${SCRIPT} code`); return null; }
    let a;
    try { a = await httpPost(`${LOGIN_API}/authenticate?email=${encodeURIComponent(email)}&accessCode=${encodeURIComponent(code)}`); }
    catch (e) { say('  Could not reach the BitCraft login service: ' + clean(e.message)); return null; }
    if (a.status >= 200 && a.status < 300) {
      const token = extractToken(a.body);
      if (token) {
        SECRET = token;
        saveToken(token);
        say('  Logged in. The token is saved on this PC only:');
        say('    ' + TOKEN_FILE);
        return token;
      }
      // Never print the reply itself — it may hold the token in a form this script did not expect.
      // Its outline (every letter and digit blanked) is enough to fix the parser.
      say('  The login service accepted the code, but its reply was not a token this script recognises. Stopped.');
      say(`  (reply outline: ${String(a.body).length} chars, ${String(a.body).slice(0, 60).replace(/[A-Za-z0-9]/g, 'x')})`);
      return null;
    }
    say(`  That code was not accepted (HTTP ${a.status}).` + (attempt < 3 ? ' Try again.' : ` Stopped. It may have expired; ask for a new one with:  ${SCRIPT} login`));
  }
  return null;
}

// ───────────────────────────── a minimal WebSocket client ─────────────────────────────
// Hand-rolled because the token must go in an Authorization header (the built-in WebSocket cannot
// set one) and because a refused upgrade's real HTTP status is only visible this way.
function wsFrame(opcode, payload) {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = crypto.randomBytes(4);
  let head;
  if (p.length < 126) head = Buffer.from([0x80 | opcode, 0x80 | p.length]);
  else if (p.length < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 0x80 | 126; head.writeUInt16BE(p.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(p.length), 2); }
  const body = Buffer.alloc(p.length);
  for (let i = 0; i < p.length; i++) body[i] = p[i] ^ mask[i & 3];
  return Buffer.concat([head, mask, body]);
}
function makeConn(sock, head) {
  const c = { closed: false, closeCode: null, closeReason: '', closedByUs: false, inbox: [], waiters: [], onUpdate: null };
  let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  let parts = [];
  let announceClosed;
  c.whenClosed = new Promise(resolve => { announceClosed = resolve; });
  const settleClose = () => {
    if (c.closed) return;
    c.closed = true;
    c.waiters.splice(0).forEach(w => { clearTimeout(w.timer); w.reject(new Error('closed')); });
    announceClosed();
  };
  const deliver = text => {
    let m;
    try { m = JSON.parse(text); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.TransactionUpdate || m.TransactionUpdateLight) {            // live changes: only watch mode listens
      if (c.onUpdate) {
        const light = m.TransactionUpdateLight, full = m.TransactionUpdate;
        const tables = light ? (light.update && light.update.tables) : (full.status && full.status.Committed && full.status.Committed.tables);
        if (tables && tables.length) { try { c.onUpdate(tables); } catch (e) { /* one bad update must not end the watch */ } }
      }
      return;
    }
    const i = c.waiters.findIndex(w => w.match(m));
    if (i >= 0) { const w = c.waiters.splice(i, 1)[0]; clearTimeout(w.timer); w.resolve(m); }
    else c.inbox.push(m);
  };
  const pump = () => {
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0, op = buf[0] & 0x0f;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) return;
      const payload = buf.subarray(off, off + len);
      buf = buf.subarray(off + len);
      if (op === 9) { try { sock.write(wsFrame(10, payload)); } catch (e) {} continue; }   // ping → pong, or the server goes quiet
      if (op === 10) continue;
      if (op === 8) {
        c.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : null;
        c.closeReason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        settleClose();
        try { sock.end(); } catch (e) {}
        return;
      }
      if (op === 0 || op === 1 || op === 2) {
        parts.push(payload);
        if (!fin) continue;
        const whole = parts.length === 1 ? parts[0] : Buffer.concat(parts);
        parts = [];
        deliver(whole.toString('utf8'));
      }
    }
  };
  sock.on('data', d => { buf = buf.length ? Buffer.concat([buf, d]) : d; pump(); });
  sock.on('close', settleClose);
  sock.on('end', settleClose);
  sock.on('error', settleClose);
  c.next = (match, ms) => new Promise((resolve, reject) => {
    const i = c.inbox.findIndex(match);
    if (i >= 0) return resolve(c.inbox.splice(i, 1)[0]);
    if (c.closed) return reject(new Error('closed'));
    const w = { match, resolve, reject };
    w.timer = setTimeout(() => { const k = c.waiters.indexOf(w); if (k >= 0) c.waiters.splice(k, 1); reject(new Error('timeout')); }, ms);
    c.waiters.push(w);
  });
  c.send = obj => { if (!c.closed) { try { sock.write(wsFrame(1, JSON.stringify(obj))); } catch (e) {} } };
  c.close = () => {
    if (!c.closed) { c.closedByUs = true; try { sock.write(wsFrame(8, Buffer.from([0x03, 0xe8]))); } catch (e) {} }
    try { sock.end(); } catch (e) {}
    const t = setTimeout(() => { try { sock.destroy(); } catch (e) {} }, 500);
    if (t.unref) t.unref();
    settleClose();
  };
  pump();
  return c;
}
// light = ask for the slim form of live updates (row changes only, without who-called-what details).
function openConn({ host, port, db, token, tls, light }) {
  return new Promise(resolve => {
    const headers = {
      Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
      'Sec-WebSocket-Protocol': 'v1.json.spacetimedb',
    };
    if (token) headers.Authorization = 'Bearer ' + token;
    let settled = false, timer = null;
    const finish = v => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); };
    let req;
    try {
      req = https.request(Object.assign({ host, port: port || 443, method: 'GET', path: `/v1/database/${db}/subscribe?compression=None${light ? '&light=true' : ''}`, headers, agent: false }, tls || {}));
    } catch (e) { return finish({ kind: 'network', message: e.message }); }
    timer = setTimeout(() => { try { req.destroy(); } catch (e) {} finish({ kind: 'timeout' }); }, 12000);
    req.on('error', e => finish({ kind: 'network', message: e.message }));
    req.on('response', res => {
      let b = '';
      res.on('data', d => { if (b.length < 2000) b += d; });
      res.on('end', () => finish({ kind: 'http', status: res.statusCode, body: b }));
      res.on('error', () => finish({ kind: 'http', status: res.statusCode, body: b }));
    });
    req.on('upgrade', (res, sock, head) => finish({ kind: 'open', conn: makeConn(sock, head) }));
    req.end();
  });
}
// Upgrade, then wait for the server's hello. A login the game refuses gets the upgrade (101) and then
// an immediate hang-up with no message at all — that is the only "refused" signal there is.
async function dial(target) {
  const r = await openConn(target);
  if (r.kind !== 'open') return r;
  try {
    const m = await r.conn.next(x => !!x.IdentityToken, 7000);
    const id = m.IdentityToken.identity;
    const hex = typeof id === 'string' ? id : (id && typeof id === 'object' ? (id.__identity__ || Object.values(id)[0]) : '');
    return { kind: 'open', conn: r.conn, identity: String(hex || '') };
  } catch (e) {
    const out = e.message === 'closed'
      ? { kind: 'refused', closeCode: r.conn.closeCode, closeReason: r.conn.closeReason }
      : { kind: 'timeout' };
    r.conn.close();
    return out;
  }
}
function target(region, token, light) {
  if (SELFTEST) {
    return {
      host: 'relay.bitcraftsync.app', port: 3000 + region, db: `idc-${region}`, token: null, light,   // the relay needs these two flags from Node
      tls: { secureOptions: crypto.constants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION | crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT },
    };
  }
  return { host: GAME_HOST, port: 443, db: `bitcraft-live-${region}`, token, light };
}

// ───────────────────────────── reading rows ─────────────────────────────
// 64-bit ids do not survive JSON.parse as numbers, so quote long integers first — skipping string
// literals, where digits must be left alone.
function quoteBigInts(s) {
  let out = '', i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < n) { if (s[j] === '\\') j += 2; else if (s[j] === '"') { j++; break; } else j++; }
      out += s.slice(i, j); i = j; continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i + 1;
      while (j < n && /[0-9.eE+\-]/.test(s[j])) j++;
      const tok = s.slice(i, j);
      out += /^-?\d{16,}$/.test(tok) ? '"' + tok + '"' : tok;
      i = j; continue;
    }
    out += ch; i++;
  }
  return out;
}
function decodeRow(table, raw) {
  let v = raw;
  if (typeof raw === 'string') {
    try { v = JSON.parse(quoteBigInts(raw)); }
    catch (e) { try { v = JSON.parse(raw); } catch (e2) { return null; } }
  }
  if (Array.isArray(v)) {
    const cols = seenCols[table] || COLS[table];
    if (!cols || v.length < cols.length) return null;
    const o = {};
    cols.forEach((col, i) => { o[col] = v[i]; });
    return o;
  }
  if (!v || typeof v !== 'object') return null;
  if (!seenCols[table]) seenCols[table] = Object.keys(v);
  return v;
}
// An optional value in any of the shapes it can arrive in: [0, x] / [1, []], {"some": x} / {"none": []},
// {"0": x} / {"1": []}, or already the bare value.
function optPayload(v) {
  if (v == null) return null;
  if (Array.isArray(v)) {
    if (v.length === 2 && (v[0] === 0 || v[0] === 1) && v[1] !== null && typeof v[1] === 'object') return v[0] === 0 ? v[1] : null;
    return v.length ? v : null;
  }
  if (typeof v === 'object') {
    if ('some' in v) return v.some;
    if ('none' in v) return null;
    if ('0' in v) return v['0'];
    if ('1' in v) return null;
    return Object.keys(v).length ? v : null;
  }
  return v;
}
function variantIndex(v, names) {
  if (v == null) return -1;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return names.indexOf(v);
  if (Array.isArray(v)) return Number(v[0]);
  if (typeof v === 'object') { const k = Object.keys(v)[0]; const i = names.indexOf(k); return i >= 0 ? i : Number(k); }
  return -1;
}
// One inventory slot → { itemId, qty, cargo } or null when empty. Slot = (volume, contents?, locked);
// contents = (item_id, quantity, item_type Item|Cargo, durability?). Item and cargo ids overlap, so the
// type always travels with the id.
function stackOf(pocket) {
  const contents = Array.isArray(pocket) ? pocket[1] : (pocket && typeof pocket === 'object' ? pocket.contents : null);
  const p = optPayload(contents);
  if (!p || typeof p !== 'object') return null;
  const itemId = Array.isArray(p) ? p[0] : p.item_id;
  const qty = Array.isArray(p) ? p[1] : p.quantity;
  const type = Array.isArray(p) ? p[2] : p.item_type;
  if (itemId == null || !isFinite(Number(itemId))) return null;
  return { itemId: Number(itemId), qty: Number(qty) || 0, cargo: variantIndex(type, ['Item', 'Cargo']) === 1 };
}
// One query round: send the set, wait for its snapshot. Each round uses queries no earlier round used,
// so it reads the same whether the server adds to or replaces the previous set.
let requestSeq = 0;
async function query(conn, sqls, ms = 20000) {
  conn.send({ Subscribe: { query_strings: sqls, request_id: ++requestSeq } });
  const m = await conn.next(x => !!(x.InitialSubscription || x.SubscriptionError), ms);
  if (m.SubscriptionError) throw new Error('query refused: ' + clean(m.SubscriptionError.error || 'no reason given').slice(0, 300));
  return readTables(m.InitialSubscription.database_update);
}
// The rows of a snapshot, by table: { table_name: [row, ...] }.
function readTables(update) {
  const out = {};
  ((update && update.tables) || []).forEach(tb => {
    const list = out[tb.table_name] || (out[tb.table_name] = []);
    (tb.updates || []).forEach(u => (u.inserts || []).forEach(raw => {
      if (!(tb.table_name in samples)) samples[tb.table_name] = (typeof raw === 'string' ? raw : JSON.stringify(raw)).slice(0, 500);
      const row = decodeRow(tb.table_name, raw);
      if (row) list.push(row); else out.__unreadable = (out.__unreadable || 0) + 1;
    }));
  });
  return out;
}
// Named query sets — the add-onto-it form. Each set gets its own id on the open connection: adding one
// leaves the others running, and it can be dropped again by that id. This is what a live tracker uses.
let setSeq = 100;
const setIdOf = q => Number(q && typeof q === 'object' ? q.id : q);
const aboutSet = (e, id) => { const q = optPayload(e.query_id), r = optPayload(e.request_id); return (q == null && r == null) || Number(q) === id || Number(r) === id; };
async function addSet(conn, sqls, ms = 20000) {
  const id = ++setSeq;
  const t0 = Date.now();
  conn.send({ SubscribeMulti: { query_strings: sqls, request_id: id, query_id: { id } } });
  const m = await conn.next(x => (x.SubscribeMultiApplied && setIdOf(x.SubscribeMultiApplied.query_id) === id) || (x.SubscriptionError && aboutSet(x.SubscriptionError, id)), ms);
  if (m.SubscriptionError) throw new Error('query refused: ' + clean(m.SubscriptionError.error || 'no reason given').slice(0, 300));
  return { id, ms: Date.now() - t0, tables: readTables(m.SubscribeMultiApplied.update) };
}
async function dropSet(conn, id, ms = 20000) {
  conn.send({ UnsubscribeMulti: { request_id: id, query_id: { id } } });
  const m = await conn.next(x => (x.UnsubscribeMultiApplied && setIdOf(x.UnsubscribeMultiApplied.query_id) === id) || (x.SubscriptionError && aboutSet(x.SubscriptionError, id)), ms);
  if (m.SubscriptionError) throw new Error('drop refused: ' + clean(m.SubscriptionError.error || 'no reason given').slice(0, 300));
}
const sqlStr = s => "'" + String(s).replace(/'/g, "''") + "'";
function playerQueries(id) {             // every filter column here is indexed on the server
  return [
    `SELECT * FROM player_username_state WHERE entity_id = ${id}`,
    `SELECT * FROM signed_in_player_state WHERE entity_id = ${id}`,
    `SELECT * FROM inventory_state WHERE owner_entity_id = ${id}`,
    `SELECT * FROM inventory_state WHERE player_owner_entity_id = ${id}`,
    `SELECT * FROM progressive_action_state WHERE owner_entity_id = ${id}`,
    `SELECT * FROM passive_craft_state WHERE owner_entity_id = ${id}`,
  ];
}
function summarize(id, t) {
  const s = { id, name: '', signedIn: false, carried: { n: 0, stacks: 0, parts: [] }, recovery: { n: 0, stacks: 0 }, stored: { n: 0, stacks: 0 }, active: 0, passive: 0, top: [], unread: t.__unreadable || 0 };
  const un = (t.player_username_state || []).find(x => String(x.entity_id) === id);
  if (un) s.name = String(un.username || '');
  s.signedIn = (t.signed_in_player_state || []).some(x => String(x.entity_id) === id);
  const invs = new Map();                // the two inventory queries can return the same row
  (t.inventory_state || []).forEach(x => { if (x.entity_id != null) invs.set(String(x.entity_id), x); });
  const totals = new Map();
  [...invs.values()].sort((a, b) => Number(a.inventory_index) - Number(b.inventory_index)).forEach(x => {
    const onPlayer = String(x.owner_entity_id) === id;
    if (!Array.isArray(x.pockets)) s.unread++;
    let n = 0;
    (Array.isArray(x.pockets) ? x.pockets : []).forEach(p => {
      const st = stackOf(p);
      if (!st) return;
      n++;
      const key = (st.cargo ? 'c:' : 'i:') + st.itemId;
      totals.set(key, (totals.get(key) || 0) + st.qty);
    });
    // Index -1 on the player is the lost-items inventory (the recovery chest), not something carried:
    // 48 slots the server parks dropped items in (BitCraftPublic lost_items_state.rs).
    const lost = onPlayer && Number(x.inventory_index) === -1;
    const group = lost ? s.recovery : (onPlayer ? s.carried : s.stored);
    group.n++; group.stacks += n;
    if (onPlayer && !lost) s.carried.parts.push(`${PERSONAL[x.inventory_index] || 'bag ' + x.inventory_index} ${n}`);
  });
  s.active = (t.progressive_action_state || []).filter(x => String(x.owner_entity_id) === id).length;
  s.passive = (t.passive_craft_state || []).filter(x => String(x.owner_entity_id) === id).length;
  s.top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([key, qty]) => ({ key, qty }));
  return s;
}

// ───────────────────────────── one region ─────────────────────────────
async function tryRegion(region, token, friend) {
  const d = await dial(target(region, token));
  if (d.kind !== 'open') return Object.assign({ region }, d);
  const conn = d.conn;
  const out = { region, kind: 'connected', at: new Date(), regionName: '', me: null, meNote: '', friend: null, names: {}, namesNote: '', ms: 0 };
  const t0 = Date.now();
  try {
    // Round 1 — which character is this login, and what is this region called. It doubles as the real
    // acceptance check: a refused login can only show up as the socket closing.
    const idOk = /^0x[0-9a-fA-F]{64}$/.test(d.identity);
    const whoSql = SELFTEST
      ? `SELECT * FROM player_lowercase_username_state WHERE username_lowercase = ${sqlStr(SELF_NAME.toLowerCase())}`
      : (idOk ? `SELECT * FROM user_state WHERE identity = ${d.identity}` : null);
    let first;
    try {
      first = await query(conn, (whoSql ? [whoSql] : []).concat(['SELECT * FROM world_region_name_state']));
    } catch (e) {
      if (e.message === 'closed') return { region, kind: 'refused', closeCode: conn.closeCode, closeReason: conn.closeReason };
      if (!/^query refused/.test(e.message)) throw e;
      out.meNote = 'the "which character is this login" lookup was refused (' + e.message + ')';
      first = await query(conn, ['SELECT * FROM world_region_name_state']);
    }
    const rn = (first.world_region_name_state || [])[0];
    out.regionName = rn ? String(rn.player_facing_name || '') : '';
    const who = (first.user_state || first.player_lowercase_username_state || [])[0];
    const meId = who && who.entity_id != null && /^\d+$/.test(String(who.entity_id)) ? String(who.entity_id) : null;
    if (!meId && !out.meNote) {
      out.meNote = SELFTEST ? `no player named "${SELF_NAME}" in this region`
        : (idOk ? 'connected, but this region holds no character for this login' : 'the server did not say which login this is');
    }

    // Round 2 — my own data, plus finding the friend by name.
    const fr = friend ? { asked: friend, id: null, sum: null, note: '' } : null;
    const sqls = meId ? playerQueries(meId) : [];
    const friendById = fr && /^\d{6,}$/.test(friend);
    if (fr && !friendById) sqls.push(`SELECT * FROM player_lowercase_username_state WHERE username_lowercase = ${sqlStr(friend.toLowerCase())}`);
    const second = sqls.length ? await query(conn, sqls) : {};
    if (meId) out.me = summarize(meId, second);
    if (fr) {
      if (friendById) fr.id = friend;
      else {
        const hit = (second.player_lowercase_username_state || []).find(x => String(x.username_lowercase || '').toLowerCase() === friend.toLowerCase());
        if (hit && /^\d+$/.test(String(hit.entity_id))) fr.id = String(hit.entity_id);
        else fr.note = 'no character with that name is in this region right now';
      }
    }

    // Round 3 — the friend's data.
    if (fr && fr.id) {
      if (fr.id === meId) fr.note = 'that is your own character';
      else fr.sum = summarize(fr.id, await query(conn, playerQueries(fr.id)));
    }
    out.friend = fr;

    // Round 4 — names for the biggest piles, so the numbers can be checked against the game.
    const want = new Set();
    [out.me, fr && fr.sum].forEach(s => { if (s) s.top.forEach(t => want.add(t.key)); });
    if (want.size) {
      try {
        const nt = await query(conn, [...want].map(k => `SELECT * FROM ${k[0] === 'c' ? 'cargo_desc' : 'item_desc'} WHERE id = ${k.slice(2)}`));
        (nt.item_desc || []).forEach(x => { out.names['i:' + x.id] = String(x.name || ''); });
        (nt.cargo_desc || []).forEach(x => { out.names['c:' + x.id] = String(x.name || ''); });
      } catch (e) { out.namesNote = e.message; }
    }
    out.ms = Date.now() - t0;
    return out;
  } catch (e) {
    return { region, kind: 'read-failed', error: clean(e.message), partial: out };
  } finally {
    conn.close();
  }
}
function regionLabel(res) {
  switch (res.kind) {
    case 'connected': return 'CONNECTED';
    case 'refused': return 'refused' + (res.closeCode ? ` (close code ${res.closeCode}${res.closeReason ? ', ' + clean(res.closeReason).slice(0, 80) : ''})` : '');
    case 'timeout': return 'no answer (timed out)';
    case 'network': return 'network error: ' + clean(res.message);
    case 'http': return res.status === 401 ? 'token not accepted (HTTP 401)' : `HTTP ${res.status} ${clean(res.body).slice(0, 80)}`;
    case 'read-failed': return 'connected, but reading failed: ' + res.error;
    default: return String(res.kind);
  }
}
const clock = d => d.toLocaleTimeString('en-US', { hour12: false });
const nothingFor = s => !s.name && !s.carried.n && !s.recovery.n && !s.stored.n && !s.active && !s.passive;
function printPlayer(label, s, names) {
  const pile = t => `${fmt(t.qty)} ${names[t.key] || (t.key[0] === 'c' ? 'cargo #' : 'item #') + t.key.slice(2)}`;
  say(`  ${label}: ${s.name || '(name not listed in this region)'}   character id ${s.id}`);
  say(`    in the game right now   ${s.signedIn ? 'YES' : 'no'}`);
  say(`    carried                 ${s.carried.n} bags, ${fmt(s.carried.stacks)} item stacks` + (s.carried.parts.length ? `  (${s.carried.parts.join(', ')})` : ''));
  if (s.recovery.n) say(`    in the recovery chest   ${fmt(s.recovery.stacks)} item stacks`);
  say(`    stored in this region   ${s.stored.n} storages, ${fmt(s.stored.stacks)} item stacks`);
  say(`    crafts                  ${s.active} in progress, ${fmt(s.passive)} passive`);
  if (s.top.length) say(`    biggest piles           ${s.top.map(pile).join(' | ')}`);
  if (s.unread) say(`    note: ${s.unread} rows arrived in a shape this script could not read (details are in the log)`);
}

// Why nothing connected, in plain words. results = one entry per region tried.
function explainNoConnection(results, token) {
  const refused = results.filter(r => r.kind === 'refused');
  const trouble = results.filter(r => r.kind !== 'refused' && !(r.kind === 'http' && r.status === 401));
  if (results.some(r => r.kind === 'http' && r.status === 401)) {
    say('  The server did not accept the token itself (it is malformed, revoked, or not a BitCraft token).');
    say(`  Get a fresh one with:  ${SCRIPT} login`);
    return;
  }
  if (refused.length && refused.length === results.length) {
    say(`  All ${results.length} regions answered, then refused the login.`);
    if (token) {
      say('  The token itself is fine. The usual reason is the 24-hour rule: the server only admits a');
      say('  login whose owner has opened the game in the last day. Start the old-world game, get into');
      say('  the world, then run this again (log out of the game first if you do not want to be kicked).');
    } else {
      say('  That is the expected result without a token: the old world cannot be read anonymously.');
    }
    return;
  }
  say('  Nothing usable connected, and not because the login was refused:');
  trouble.forEach(r => say(`    Region ${r.region}: ${regionLabel(r)}`));
  say('  If it is a network error, check your internet connection and try again.');
}

// ───────────────────────────── the test ─────────────────────────────
async function runTest(token) {
  say('');
  say('This test only READS. It never performs a game action.');
  if (!flag('yes')) {
    say('Heads-up: if your OLD-WORLD game is open right now, this will most likely kick you');
    say('out of it. You can log straight back in; just do not run it mid-fight or mid-trip.');
    const a = await ask('Continue? (y/n): ');
    if (a == null || !/^y/i.test(a)) { say('Stopped. Nothing was contacted.'); return; }
  }
  let friend = opt('friend');
  if (friend == null && !flag('no-friend')) {
    const a = await ask("Friend's character name to look up (or just press Enter to skip): ");
    friend = a || null;
  }
  if (friend != null) {
    friend = String(friend).trim();
    if (!friend || friend.length > 40) friend = null;
  }

  const regions = REGIONS.length ? REGIONS : (SELFTEST ? [8] : OLD_WORLD_REGIONS);
  say('');
  say(`Step 1 - trying ${regions.length === 1 ? 'region ' + regions[0] : 'each of the ' + regions.length + ' old-world regions'} with ${token ? 'your token' : 'no token'}`);
  const results = [];
  for (const r of regions) {
    const res = await tryRegion(r, token, friend);
    results.push(res);
    say(`  Region ${String(r).padStart(2)}   ${regionLabel(res)}`);
    if (res.kind === 'http' && res.status === 401) break;        // the token itself is bad: asking 12 more times proves nothing
    await sleep(150);
  }

  const connected = results.filter(r => r.kind === 'connected');
  const halfRead = results.filter(r => r.kind === 'read-failed');
  const refused = results.filter(r => r.kind === 'refused');
  const badToken = results.some(r => r.kind === 'http' && r.status === 401);
  const trouble = results.filter(r => r.kind === 'timeout' || r.kind === 'network' || (r.kind === 'http' && r.status !== 401));

  connected.forEach(res => {
    say('');
    say(`Step 2 - what the token could read in Region ${res.region}${res.regionName ? ' (' + res.regionName + ')' : ''}   [connected ${clock(res.at)}, read took ${res.ms} ms]`);
    if (res.me) printPlayer('You', res.me, res.names);
    else say('  You: ' + (res.meNote || 'not identified'));
    if (res.friend) {
      const fs_ = res.friend.sum;
      const blank = fs_ && nothingFor(fs_);
      if (fs_ && !blank) printPlayer(`Friend "${res.friend.asked}"`, fs_, res.names);
      else say(`  Friend "${res.friend.asked}": ${blank ? 'nothing belonging to that character is in this region' : (res.friend.note || 'not found')}`);
    }
    if (res.namesNote) say('  note: item names could not be looked up (' + clean(res.namesNote) + ')');
  });

  say('');
  say('Step 3 - what this run shows');
  if (badToken || (!connected.length && !halfRead.length)) { explainNoConnection(results, token); return; }
  const accepted = connected.concat(halfRead);
  if (token && !SELFTEST) saveState({ region: (connected.find(r => r.me) || accepted[0]).region });
  const home = connected.find(r => r.me) || accepted[0];       // the region that knows this login's character
  say(`  A token can read the old world          YES - Region ${home.region}`);
  const others = results.length - accepted.length;
  if (accepted.length > 1) {
    say(`  Only your own region lets you in        NO - ${accepted.length} regions accepted the token (${accepted.map(r => r.region).join(', ')})`);
  } else if (others > 0) {
    say(`  Only your own region lets you in        ${refused.length === others ? 'YES' : 'MOSTLY'} - ${refused.length} of ${others} other regions refused`);
  }
  if (home.kind === 'connected') {
    const me = home.me, fr = home.friend;
    if (fr && fr.sum && nothingFor(fr.sum)) { fr.sum = null; fr.note = 'nothing belonging to that character is in this region'; }
    say(`  Your own data came back                 ${me ? 'YES' : 'NO - ' + (home.meNote || 'unknown reason')}`);
    if (fr) say(`  Your friend's data came back            ${fr.sum ? 'YES' : 'NO - ' + (fr.note || 'not found')}`);
    if (fr && !fr.sum && !/own character/.test(fr.note || '')) {
      say('    A token only sees the region its owner stands in. If your friend is in another region, his');
      say('    name is not listed here. His character id still works: pass it with --friend <id>.');
    }
    if (me && me.signedIn) {
      say(`  You were IN THE GAME when the test connected at ${clock(home.at)}. Look at the game now: were`);
      say('  you kicked, frozen, or did nothing happen? This script cannot see that for itself.');
    } else if (me) {
      say('  You were not in the game during this test, so the "does it kick you" question is still open.');
    }
  }
  halfRead.forEach(r => say(`  Region ${r.region} connected but the read stopped early: ${r.error}`));
  if (trouble.length) say(`  ${trouble.length} region(s) could not be reached at all (network or timeout), so they prove nothing either way.`);
}

// ───────────────────────────── watch mode ─────────────────────────────
// Holds ONE connection open and prints what changes, to answer what the one-shot test cannot:
// does the stream flow, can queries be added and dropped on a running connection, and can the game be
// played on the same character while this stays connected. It never reconnects by itself — a reconnect
// is exactly what kicks the player.
function playerLiveQueries(id) {         // every filter column is indexed on the server
  return [
    `SELECT * FROM signed_in_player_state WHERE entity_id = ${id}`,
    `SELECT * FROM mobile_entity_state WHERE entity_id = ${id}`,
    `SELECT * FROM inventory_state WHERE owner_entity_id = ${id}`,
    `SELECT * FROM inventory_state WHERE player_owner_entity_id = ${id}`,
    `SELECT * FROM progressive_action_state WHERE owner_entity_id = ${id}`,
    `SELECT * FROM passive_craft_state WHERE owner_entity_id = ${id}`,
  ];
}
const WATCHED_TABLES = ['signed_in_player_state', 'mobile_entity_state', 'inventory_state', 'progressive_action_state', 'passive_craft_state', 'player_username_state'];
// Ask once and let go: add a set, take its rows, drop it. For lookups that never change (names).
async function oneShot(conn, sqls) {
  const s = await addSet(conn, sqls);
  try { await dropSet(conn, s.id); } catch (e) { /* the rows are already in hand */ }
  return s.tables;
}
const rowCount = t => Object.keys(t).reduce((n, k) => n + (Array.isArray(t[k]) ? t[k].length : 0), 0);
const span = ms => { const s = Math.round(ms / 1000); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`; };
async function connectHome(token) {
  const saved = Number(loadState().region);
  const base = REGIONS.length ? REGIONS : (SELFTEST ? [8] : OLD_WORLD_REGIONS);
  const order = base.includes(saved) ? [saved].concat(base.filter(r => r !== saved)) : base;
  const tried = [];
  for (const r of order) {
    const d = await dial(target(r, token, true));
    let res;
    if (d.kind === 'open') {
      const idOk = /^0x[0-9a-fA-F]{64}$/.test(d.identity);
      const whoSql = SELFTEST
        ? `SELECT * FROM player_lowercase_username_state WHERE username_lowercase = ${sqlStr(SELF_NAME.toLowerCase())}`
        : (idOk ? `SELECT * FROM user_state WHERE identity = ${d.identity}` : null);
      try {
        // The first read doubles as the acceptance check: a refused login can only close the socket.
        const first = await oneShot(d.conn, (whoSql ? [whoSql] : []).concat(['SELECT * FROM world_region_name_state']));
        say(`  Region ${String(r).padStart(2)}   CONNECTED at ${clock(new Date())}`);
        return { conn: d.conn, region: r, first, tried };
      } catch (e) {
        d.conn.close();
        res = e.message === 'closed' ? { region: r, kind: 'refused' } : { region: r, kind: 'read-failed', error: clean(e.message) };
      }
    } else {
      res = Object.assign({ region: r }, d);
    }
    tried.push(res);
    say(`  Region ${String(r).padStart(2)}   ${regionLabel(res)}`);
    // A bad token, or a door that opened but would not answer, is not fixed by trying 12 more regions.
    if (res.kind === 'read-failed' || (res.kind === 'http' && res.status === 401)) break;
    await sleep(150);
  }
  return { conn: null, tried };
}
async function runWatch(token) {
  const minutes = Math.min(120, Math.max(0.2, Number(opt('minutes')) || 15));
  const durationMs = minutes * 60000;
  say('');
  say('WATCH: stays connected and prints what changes, as it happens. It only READS.');
  if (!flag('yes')) {
    say('Heads-up: if this character is in the OLD-WORLD game right now, connecting kicks it out once.');
    say('Log back in while this keeps running: whether both then work side by side is the test.');
    const a = await ask('Continue? (y/n): ');
    if (a == null || !/^y/i.test(a)) { say('Stopped. Nothing was contacted.'); return; }
  }
  let friend = opt('friend');
  if (friend == null && !flag('no-friend')) {
    const a = await ask("Friend's character name to watch too (or just press Enter to skip): ");
    friend = a || null;
  }
  if (friend != null) {
    friend = String(friend).trim();
    if (!friend || friend.length > 40) friend = null;
  }

  say('');
  say('Step 1 - connecting (the region that worked last time first)');
  const home = await connectHome(token);
  if (!home.conn) {
    say('');
    say('Step 2 - nothing to watch');
    explainNoConnection(home.tried, token);
    return;
  }
  const conn = home.conn, region = home.region, startAt = new Date();
  if (token && !SELFTEST) saveState({ region });
  const regionRow = (home.first.world_region_name_state || [])[0];
  const regionName = regionRow ? String(regionRow.player_facing_name || '') : '';
  const who = (home.first.user_state || home.first.player_lowercase_username_state || [])[0];
  const meId = who && who.entity_id != null && /^\d+$/.test(String(who.entity_id)) ? String(who.entity_id) : null;
  if (!meId) {
    say('  Connected, but could not tell which character this login is, so there is nothing to watch.');
    conn.close();
    return;
  }

  // ── live state ──
  const people = new Map();              // character id -> name, for the characters being watched
  const usernames = new Map();           // character id -> name, from the who-is-online query
  const names = {}, nameTried = new Set();
  const stats = { messages: 0, rows: 0, byTable: {} };
  const moves = new Map(), craftTicks = new Map(), otherChanges = new Map();
  const adds = [], drops = [], problems = [];
  let lastLine = Date.now(), onlineSet = null;
  const line = s => { say(`  ${clock(new Date())}  ${s}`); lastLine = Date.now(); };
  let work = Promise.resolve();          // one update at a time, in arrival order
  const enqueue = fn => { work = work.then(fn).catch(e => { if (!conn.closed) line('(an update could not be processed: ' + clean(e.message) + ')'); }); return work; };
  const whoIs = id => (id === meId ? 'You' : (people.get(id) || usernames.get(id) || 'someone'));
  const whose = id => (id === meId ? 'Your' : `${whoIs(id)}'s`);
  const itemName = k => names[k] || (k[0] === 'c' ? 'cargo #' : 'item #') + k.slice(2);
  const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;
  async function resolveItemNames(keys) {
    const need = [...new Set(keys)].filter(k => !(k in names) && !nameTried.has(k));
    if (!need.length || conn.closed) return;
    need.forEach(k => nameTried.add(k));
    try {
      const t = await oneShot(conn, need.map(k => `SELECT * FROM ${k[0] === 'c' ? 'cargo_desc' : 'item_desc'} WHERE id = ${k.slice(2)}`));
      (t.item_desc || []).forEach(x => { names['i:' + x.id] = String(x.name || ''); });
      (t.cargo_desc || []).forEach(x => { names['c:' + x.id] = String(x.name || ''); });
    } catch (e) { /* the numbers still print, just without names */ }
  }
  async function lookupName(id) {
    try { const t = await oneShot(conn, [`SELECT * FROM player_username_state WHERE entity_id = ${id}`]); return String(((t.player_username_state || [])[0] || {}).username || ''); }
    catch (e) { return ''; }
  }
  const totalsOf = row => {
    const m = new Map();
    (Array.isArray(row && row.pockets) ? row.pockets : []).forEach(p => {
      const st = stackOf(p);
      if (st) { const k = (st.cargo ? 'c:' : 'i:') + st.itemId; m.set(k, (m.get(k) || 0) + st.qty); }
    });
    return m;
  };
  const bagLabel = row => {                 // "Your Inventory", "One of Heretic721's storages"
    const owner = String(row.owner_entity_id), keeper = String(row.player_owner_entity_id);
    if (people.has(owner)) return `${whose(owner)} ${Number(row.inventory_index) === -1 ? 'recovery chest' : (PERSONAL[row.inventory_index] || 'bag ' + row.inventory_index)}`;
    return `One of ${people.has(keeper) ? whose(keeper).replace(/^Your$/, 'your') : "someone's"} storages`;
  };
  async function inventoryLine(oldRow, row) {
    const label = bagLabel(row);
    if (!oldRow) { line(`${label} appeared`); return; }
    const a = totalsOf(oldRow), b = totalsOf(row), diff = [];
    new Set([...a.keys(), ...b.keys()]).forEach(k => { const d = (b.get(k) || 0) - (a.get(k) || 0); if (d) diff.push([k, d]); });
    if (!diff.length) { line(`${label} changed (items moved between slots, totals the same)`); return; }
    await resolveItemNames(diff.map(d => d[0]));
    diff.sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]));
    line(`${label} changed: ${diff.slice(0, 5).map(([k, d]) => `${d > 0 ? '+' : ''}${fmt(d)} ${itemName(k)}`).join(', ')}${diff.length > 5 ? `, and ${diff.length - 5} more` : ''}`);
  }
  async function handleTables(tables) {
    for (const tb of tables) {
      const name = tb.table_name, dels = [], ins = [];
      const known = WATCHED_TABLES.includes(name);
      let n = 0;
      (tb.updates || []).forEach(u => {
        [[u.deletes, dels], [u.inserts, ins]].forEach(([raws, into]) => (raws || []).forEach(raw => {
          n++;
          const key = 'live ' + name;         // live rows can be shaped differently from snapshot rows: keep one of each
          if (!(key in samples)) samples[key] = (typeof raw === 'string' ? raw : JSON.stringify(raw)).slice(0, 500);
          if (!known) return;                 // only counted, so its shape does not matter
          const r = decodeRow(name, raw);
          if (r) into.push(r); else stats.unreadable = (stats.unreadable || 0) + 1;
        }));
      });
      if (!n) continue;
      stats.rows += n;
      stats.byTable[name] = (stats.byTable[name] || 0) + n;
      // A changed row arrives as delete(old) + insert(new) with the same id; one without the other is a
      // real removal or a real arrival.
      const pk = r => String(r.entity_id != null ? r.entity_id : r.id);
      const was = new Map(dels.map(r => [pk(r), r])), now = new Map(ins.map(r => [pk(r), r]));
      const tally = new Map();               // "who|what" -> count, so a burst prints as one line
      const count = (id, what) => tally.set(id + '|' + what, (tally.get(id + '|' + what) || 0) + 1);
      if (name === 'mobile_entity_state') {
        now.forEach((r, id) => { if (people.has(id)) moves.set(id, (moves.get(id) || 0) + 1); });
      } else if (name === 'signed_in_player_state') {
        now.forEach((r, id) => { if (!was.has(id) && people.has(id)) line(`${whoIs(id)} signed in to the game`); });
        was.forEach((r, id) => { if (!now.has(id) && people.has(id)) line(`${whoIs(id)} signed out of the game`); });
      } else if (name === 'player_username_state') {         // fed only by the who-is-online query
        now.forEach((r, id) => { usernames.set(id, String(r.username || '')); if (!was.has(id) && !people.has(id)) line(`${r.username || 'someone'} came online in this region`); });
        was.forEach((r, id) => { if (!now.has(id) && !people.has(id)) line(`${r.username || usernames.get(id) || 'someone'} went offline`); });
      } else if (name === 'inventory_state') {
        for (const [id, row] of now) await inventoryLine(was.get(id) || null, row);
        was.forEach((r, id) => { if (!now.has(id)) line(`${bagLabel(r)} was removed`); });
      } else if (name === 'progressive_action_state') {
        now.forEach((r, id) => { const o = String(r.owner_entity_id); if (was.has(id)) craftTicks.set(o, (craftTicks.get(o) || 0) + 1); else count(o, 'start'); });
        was.forEach((r, id) => { if (!now.has(id)) count(String(r.owner_entity_id), 'end'); });
        tally.forEach((c, key) => {
          const [o, what] = key.split('|');
          if (what === 'end' && craftTicks.has(o)) {          // say the ticks before the ending they led to
            line(`${whoIs(o)}: crafting (${plural(craftTicks.get(o), 'progress tick', 'progress ticks')})`);
            craftTicks.delete(o);
          }
          line(`${whoIs(o)}: ${plural(c, 'craft', 'crafts')} ${what === 'start' ? 'started' : 'ended (finished or cancelled)'}`);
        });
      } else if (name === 'passive_craft_state') {
        now.forEach((r, id) => count(String(r.owner_entity_id), was.has(id) ? 'changed' : 'queued'));
        was.forEach((r, id) => { if (!now.has(id)) count(String(r.owner_entity_id), 'gone'); });
        tally.forEach((c, key) => {
          const [o, what] = key.split('|');
          line(`${whoIs(o)}: ${plural(c, 'passive craft', 'passive crafts')} ${what === 'queued' ? 'queued' : (what === 'gone' ? 'collected or removed' : 'changed state')}`);
        });
      } else {
        otherChanges.set(name, (otherChanges.get(name) || 0) + n);     // a table this script has no words for: counted, printed on the tick
      }
    }
  }
  conn.onUpdate = tables => { stats.messages++; enqueue(() => handleTables(tables)); };

  // ── the queries, added one set at a time on the same connection ──
  say('');
  say(`Step 2 - watching Region ${region}${regionName ? ' (' + regionName + ')' : ''}`);
  let friendNote = '';
  try {
    const mine = await addSet(conn, playerLiveQueries(meId));
    const myName = await lookupName(meId);
    people.set(meId, myName || 'You');
    const sum = summarize(meId, mine.tables);
    sum.name = myName;
    await resolveItemNames(sum.top.map(t => t.key));
    printPlayer('You', sum, names);
    if (friend) {
      let friendId = null;
      if (/^\d{6,}$/.test(friend)) friendId = friend;
      else {
        const t = await oneShot(conn, [`SELECT * FROM player_lowercase_username_state WHERE username_lowercase = ${sqlStr(friend.toLowerCase())}`]);
        const hit = (t.player_lowercase_username_state || [])[0];
        if (hit && /^\d+$/.test(String(hit.entity_id))) friendId = String(hit.entity_id);
        else friendNote = 'no character with that name is in this region right now';
      }
      if (friendId === meId) { friendId = null; friendNote = 'that is your own character'; }
      if (friendId) {
        const theirs = await addSet(conn, playerLiveQueries(friendId));
        const theirName = (await lookupName(friendId)) || friend;
        people.set(friendId, theirName);
        const fsum = summarize(friendId, theirs.tables);
        fsum.name = theirName;
        await resolveItemNames(fsum.top.map(t => t.key));
        printPlayer(`Friend "${friend}"`, fsum, names);
        adds.push("your friend's rows");
        line(`added your friend's queries to the open connection (${fmt(rowCount(theirs.tables))} rows, ${theirs.ms} ms)`);
      } else {
        say(`  Friend "${friend}": ${friendNote}`);
      }
    }
  } catch (e) {
    problems.push('setting up the queries failed: ' + clean(e.message));
  }
  // Developer checks, self-test only: the empty pre-launch world gives nothing to watch, so an extra
  // query can supply real live traffic and a replay file can push hand-made updates through the same path.
  if (SELFTEST && process.env.BC_SELFTEST_EXTRA) {
    try { await addSet(conn, process.env.BC_SELFTEST_EXTRA.split(';').map(s => s.trim()).filter(Boolean)); }
    catch (e) { problems.push('the extra self-test query failed: ' + clean(e.message)); }
  }
  if (SELFTEST && process.env.BC_REPLAY) {
    try { JSON.parse(fs.readFileSync(process.env.BC_REPLAY, 'utf8')).forEach((tables, i) => { const t = setTimeout(() => { if (conn.onUpdate) conn.onUpdate(tables); }, 1200 + i * 300); if (t.unref) t.unref(); }); }
    catch (e) { problems.push('the replay file could not be read: ' + clean(e.message)); }
  }

  // Two more steps on a timer, to prove queries can come and go while the stream runs.
  const onlineAt = Math.min(10000, durationMs * 0.15), dropAt = Math.min(90000, durationMs * 0.6);
  const timers = [
    setTimeout(() => enqueue(async () => {
      if (conn.closed) return;
      try {
        onlineSet = await addSet(conn, ['SELECT player_username_state.* FROM player_username_state JOIN signed_in_player_state ON player_username_state.entity_id = signed_in_player_state.entity_id']);
        const rows = onlineSet.tables.player_username_state || [];
        rows.forEach(x => usernames.set(String(x.entity_id), String(x.username || '')));
        adds.push('who is online');
        line(`added a "who is online here" query on the fly (${onlineSet.ms} ms): ${plural(rows.length, 'player', 'players')} online` + (rows.length ? ` - ${rows.slice(0, 8).map(x => x.username).join(', ')}${rows.length > 8 ? ', ...' : ''}` : ''));
      } catch (e) { problems.push('adding the "who is online" query failed: ' + clean(e.message)); }
    }), onlineAt),
    setTimeout(() => enqueue(async () => {
      if (conn.closed || !onlineSet) return;
      try {
        await dropSet(conn, onlineSet.id);
        drops.push('who is online');
        line('dropped the "who is online here" query again; everything else keeps running');
      } catch (e) { problems.push('dropping the "who is online" query failed: ' + clean(e.message)); }
    }), dropAt),
  ];
  const ticker = setInterval(() => enqueue(async () => {
    moves.forEach((c, id) => line(`${whoIs(id)} moved (${plural(c, 'position update', 'position updates')})`));
    moves.clear();
    craftTicks.forEach((c, id) => line(`${whoIs(id)}: crafting (${plural(c, 'progress tick', 'progress ticks')})`));
    craftTicks.clear();
    otherChanges.forEach((c, t) => line(`${t}: ${plural(c, 'row change', 'row changes')}`));
    otherChanges.clear();
    if (Date.now() - lastLine >= 30000) line('still connected; nothing changed in the last 30 seconds');
  }), 5000);

  say('');
  say(`  Watching now. Press Enter to stop (it also stops by itself after ${minutes >= 1 ? plural(Math.round(minutes), 'minute', 'minutes') : span(durationMs)}).`);
  say('  To see it work: log this character into the old-world game, walk a few steps, and move');
  say('  an item between bags. Each of those should print a line here within a second or two.');
  let capTimer;
  const cap = new Promise(resolve => { capTimer = setTimeout(() => resolve('time'), durationMs); });
  const pressed = ask('').then(l => (l == null ? new Promise(() => {}) : 'you'));     // no keyboard = run to the time limit
  const reason = await Promise.race([pressed, cap, conn.whenClosed.then(() => 'server')]);
  clearTimeout(capTimer);
  clearInterval(ticker);
  timers.forEach(clearTimeout);
  await work;
  const endAt = new Date();
  conn.onUpdate = null;
  if (reason !== 'server') conn.close();

  say('');
  say('Step 3 - what this run shows');
  say(`  Stayed connected                        ${span(endAt - startAt)}, then ` + (reason === 'server'
    ? `THE SERVER closed it at ${clock(endAt)}${conn.closeCode ? ' (code ' + conn.closeCode + (conn.closeReason ? ', ' + clean(conn.closeReason).slice(0, 80) : '') + ')' : ''}`
    : (reason === 'time' ? 'it reached the time limit' : 'you stopped it')));
  say(`  Live updates arrived                    ${stats.messages ? `YES - ${plural(stats.messages, 'message', 'messages')}, ${plural(stats.rows, 'row change', 'row changes')}` : 'NONE - either nothing in the watched rows changed, or the stream is not flowing'}`);
  if (stats.messages) say(`    by table: ${Object.entries(stats.byTable).sort((a, b) => b[1] - a[1]).map(([t, c]) => `${t} ${fmt(c)}`).join(', ')}`);
  if (stats.unreadable) say(`    note: ${fmt(stats.unreadable)} live rows arrived in a shape this script could not read (details are in the log)`);
  say(`  Added queries without reconnecting      ${adds.length ? 'YES - ' + adds.join(', ') : 'not shown (nothing was added in this run)'}`);
  say(`  Dropped a query without reconnecting    ${drops.length ? 'YES - ' + drops.join(', ') : 'not shown (the run ended before that step)'}`);
  problems.forEach(p => say('  PROBLEM: ' + p));
  if (reason === 'server') say('  It did not reconnect by itself on purpose: a reconnect is what kicks the character out of the game.');
  say('  Two things only you can see:');
  say('    1. After you logged back into the game, did it play normally while this kept printing?');
  say('    2. When this stopped, did the game kick you? If you were logged in, it should not have.');
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 18) { console.log('This script needs Node 18 or newer.'); return; }
  say('BitCraft old-world token test  (read-only)');
  say(new Date().toString());
  if (cmd === 'forget') {
    say(forgetToken() ? 'Saved token deleted from this PC.' : 'There was no saved token to delete.');
    return;
  }
  if (!['test', 'watch', 'login', 'code'].includes(cmd)) { say(`Unknown command "${cmd}". Use: ${SCRIPT}  [watch | login | code | forget]`); return; }
  let token = null;
  if (SELFTEST) {
    if (!SELF_NAME) { say('--selftest needs a player name.'); return; }
    say('SELF-TEST: public 1.0 relay, no login. Developer check only.');
  } else if (ANON) {
    say('NO-TOKEN CHECK: the real server without a login. Developer check only.');
  } else {
    if (cmd === 'test' || cmd === 'watch') token = loadToken();
    if (token) { SECRET = token; say(`Using the token saved on this PC (${tokenFacts(token)}).`); }
    else {
      token = await login(cmd === 'code');
      if (!token) return;
      say(`  Token dates: ${tokenFacts(token)}.`);
    }
  }
  if (cmd === 'watch') await runWatch(token); else await runTest(token);
  if (token) {
    say('');
    say(`Your token stays saved on this PC for the next run. Delete it with:  ${SCRIPT} forget`);
  }
}

main()
  .catch(e => { say('Unexpected error: ' + clean((e && e.stack) || e)); })
  .finally(() => {
    closeInput();
    flushLog();
    if (cmd !== 'forget') console.log(`\nA copy of this report was added to ${path.relative(process.cwd(), LOG_FILE) || LOG_FILE}`);
  });
