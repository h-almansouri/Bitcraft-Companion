#!/usr/bin/env node
'use strict';
/*
 * BitCraft old-world token test — READ ONLY
 * ------------------------------------------------------------------------------------------------
 * Checks what a player's own login token can read straight from the game server for the old
 * (Early Access) world, now that the community relays have moved on to the 1.0 world.
 *
 *   node tools/oldworld-token-test.js            run the test (logs in first if no token is saved)
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
};

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
  try { fs.unlinkSync(TOKEN_FILE); return true; } catch (e) { return false; }
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
  const c = { closed: false, closeCode: null, closeReason: '', inbox: [], waiters: [] };
  let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  let parts = [];
  const settleClose = () => {
    if (c.closed) return;
    c.closed = true;
    c.waiters.splice(0).forEach(w => { clearTimeout(w.timer); w.reject(new Error('closed')); });
  };
  const deliver = text => {
    let m;
    try { m = JSON.parse(text); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.TransactionUpdate || m.TransactionUpdateLight) return;      // live changes: a snapshot test ignores them
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
    if (!c.closed) { try { sock.write(wsFrame(8, Buffer.from([0x03, 0xe8]))); } catch (e) {} }
    try { sock.end(); } catch (e) {}
    const t = setTimeout(() => { try { sock.destroy(); } catch (e) {} }, 500);
    if (t.unref) t.unref();
    settleClose();
  };
  pump();
  return c;
}
function openConn({ host, port, db, token, tls }) {
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
      req = https.request(Object.assign({ host, port: port || 443, method: 'GET', path: `/v1/database/${db}/subscribe?compression=None`, headers, agent: false }, tls || {}));
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
function target(region, token) {
  if (SELFTEST) {
    return {
      host: 'relay.bitcraftsync.app', port: 3000 + region, db: `idc-${region}`, token: null,   // the relay needs these two flags from Node
      tls: { secureOptions: crypto.constants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION | crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT },
    };
  }
  return { host: GAME_HOST, port: 443, db: `bitcraft-live-${region}`, token };
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
    const cols = COLS[table];
    if (!cols || v.length < cols.length) return null;
    const o = {};
    cols.forEach((col, i) => { o[col] = v[i]; });
    return o;
  }
  return v && typeof v === 'object' ? v : null;
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
  const out = {};
  const tables = (m.InitialSubscription.database_update && m.InitialSubscription.database_update.tables) || [];
  tables.forEach(tb => {
    const list = out[tb.table_name] || (out[tb.table_name] = []);
    (tb.updates || []).forEach(u => (u.inserts || []).forEach(raw => {
      if (!(tb.table_name in samples)) samples[tb.table_name] = (typeof raw === 'string' ? raw : JSON.stringify(raw)).slice(0, 500);
      const row = decodeRow(tb.table_name, raw);
      if (row) list.push(row); else out.__unreadable = (out.__unreadable || 0) + 1;
    }));
  });
  return out;
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
  const s = { id, name: '', signedIn: false, carried: { n: 0, stacks: 0, parts: [] }, stored: { n: 0, stacks: 0 }, active: 0, passive: 0, top: [], unread: t.__unreadable || 0 };
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
    const group = onPlayer ? s.carried : s.stored;
    group.n++; group.stacks += n;
    if (onPlayer) s.carried.parts.push(`${PERSONAL[x.inventory_index] || 'bag ' + x.inventory_index} ${n}`);
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
  const out = { region, kind: 'connected', regionName: '', me: null, meNote: '', friend: null, names: {}, namesNote: '', ms: 0 };
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
function printPlayer(label, s, names) {
  const pile = t => `${fmt(t.qty)} ${names[t.key] || (t.key[0] === 'c' ? 'cargo #' : 'item #') + t.key.slice(2)}`;
  say(`  ${label}: ${s.name || '(name not listed in this region)'}   character id ${s.id}`);
  say(`    in the game right now   ${s.signedIn ? 'YES' : 'no'}`);
  say(`    carried                 ${s.carried.n} bags, ${fmt(s.carried.stacks)} item stacks` + (s.carried.parts.length ? `  (${s.carried.parts.join(', ')})` : ''));
  say(`    stored in this region   ${s.stored.n} storages, ${fmt(s.stored.stacks)} item stacks`);
  say(`    crafts                  ${s.active} in progress, ${fmt(s.passive)} passive`);
  if (s.top.length) say(`    biggest piles           ${s.top.map(pile).join(' | ')}`);
  if (s.unread) say(`    note: ${s.unread} rows arrived in a shape this script could not read (details are in the log)`);
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
    say(`Step 2 - what the token could read in Region ${res.region}${res.regionName ? ' (' + res.regionName + ')' : ''}   [${res.ms} ms]`);
    if (res.me) printPlayer('You', res.me, res.names);
    else say('  You: ' + (res.meNote || 'not identified'));
    if (res.friend) {
      const fs_ = res.friend.sum;
      const blank = fs_ && !fs_.name && !fs_.carried.n && !fs_.stored.n && !fs_.active && !fs_.passive;
      if (fs_ && !blank) printPlayer(`Friend "${res.friend.asked}"`, fs_, res.names);
      else say(`  Friend "${res.friend.asked}": ${blank ? 'nothing belonging to that character is in this region' : (res.friend.note || 'not found')}`);
    }
    if (res.namesNote) say('  note: item names could not be looked up (' + clean(res.namesNote) + ')');
  });

  say('');
  say('Step 3 - what this run shows');
  if (badToken) {
    say('  The server did not accept the token itself (it is malformed, revoked, or not a BitCraft token).');
    say(`  Get a fresh one with:  ${SCRIPT} login`);
    return;
  }
  if (!connected.length && !halfRead.length) {
    if (refused.length && refused.length === results.length) {
      say(`  All ${results.length} regions answered, then refused the login.`);
      if (token) {
        say('  The token itself is fine. The usual reason is the 24-hour rule: the server only admits a');
        say('  login whose owner has opened the game in the last day. Start the old-world game, get into');
        say('  the world, then run this again (log out of the game first if you do not want to be kicked).');
      } else {
        say('  That is the expected result without a token: the old world cannot be read anonymously.');
      }
    } else {
      say('  Nothing connected, and not because of the token:');
      trouble.forEach(r => say(`    Region ${r.region}: ${regionLabel(r)}`));
      say('  Check your internet connection and try again.');
    }
    return;
  }
  const accepted = connected.concat(halfRead);
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
    const nothing = s => !s.name && !s.carried.n && !s.stored.n && !s.active && !s.passive;
    if (fr && fr.sum && nothing(fr.sum)) { fr.sum = null; fr.note = 'nothing belonging to that character is in this region'; }
    say(`  Your own data came back                 ${me ? 'YES' : 'NO - ' + (home.meNote || 'unknown reason')}`);
    if (fr) say(`  Your friend's data came back            ${fr.sum ? 'YES' : 'NO - ' + (fr.note || 'not found')}`);
    if (fr && !fr.sum && !/own character/.test(fr.note || '')) {
      say('    A token only sees the region its owner stands in. If your friend is in another region, his');
      say('    name is not listed here. His character id still works: pass it with --friend <id>.');
    }
    if (me && me.signedIn) {
      say('  You were IN THE GAME during this test. Look at the game now: were you kicked, frozen,');
      say('  or did nothing happen? That is the one thing this script cannot see for itself.');
    } else if (me) {
      say('  You were not in the game during this test, so the "does it kick you" question is still open.');
    }
  }
  halfRead.forEach(r => say(`  Region ${r.region} connected but the read stopped early: ${r.error}`));
  if (trouble.length) say(`  ${trouble.length} region(s) could not be reached at all (network or timeout), so they prove nothing either way.`);
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 18) { console.log('This script needs Node 18 or newer.'); return; }
  say('BitCraft old-world token test  (read-only)');
  say(new Date().toString());
  if (cmd === 'forget') {
    say(forgetToken() ? 'Saved token deleted from this PC.' : 'There was no saved token to delete.');
    return;
  }
  if (cmd !== 'test' && cmd !== 'login' && cmd !== 'code') { say(`Unknown command "${cmd}". Use: ${SCRIPT}  [login | code | forget]`); return; }
  let token = null;
  if (SELFTEST) {
    if (!SELF_NAME) { say('--selftest needs a player name.'); return; }
    say('SELF-TEST: public 1.0 relay, no login. Developer check only.');
  } else if (ANON) {
    say('NO-TOKEN CHECK: the real server without a login. Developer check only.');
  } else {
    if (cmd === 'test') token = loadToken();
    if (token) { SECRET = token; say(`Using the token saved on this PC (${tokenFacts(token)}).`); }
    else {
      token = await login(cmd === 'code');
      if (!token) return;
      say(`  Token dates: ${tokenFacts(token)}.`);
    }
  }
  await runTest(token);
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
