// Proof that one resource's record in the x402 Trust Index of a day is in the Merkle root registered on Concordium
// that day (the Trust Index anchor: one RegisterData a day, 45 bytes, "FZTI" || version || day || root || count).
//
// Built from public data only, so anyone can check the answer without trusting us:
// - the records: the same index/ parts and delivery files on the trust-data branch the anchor read, turned into
//   records exactly as the anchor does (recordOf below is the anchor's own, tools/trust-anchor/lib.mjs);
// - the root: read from the chain, the anchor account's RegisterData, through Concordium's wallet proxy.
// The tree is rebuilt once a day, when a new day is anchored, and kept only if its root equals the one on chain, so
// it can't prove a record that isn't there. A caller checks the answer itself: the record's leaf, then the path to the
// root, then that root against the chain (fizzl.eu/concordium does all three in the browser).
//
// Leaf: sha256(0x00 || utf8(JSON.stringify([key, record]))), records sorted by key (code-unit order).
// Node: sha256(0x01 || left || right); an odd node at the end of a level moves up unchanged.

const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { keyOf } = require('./bazaar-index');
const { eachLine } = require('./index-files');

const DATA = 'https://raw.githubusercontent.com/Fizzl13/x402-doctor/trust-data/';
const WALLET_PROXY = 'https://wallet-proxy.mainnet.concordium.software';
// The account that registers the anchor each day (a dedicated mainnet account; nothing else is sent from it).
const ANCHOR_ACCOUNT = '3t4YnWTTYwqLNQHcrYvE5bQWtgkfx8gMNwwm1dRbi61ofFURpp';
const CHECK_MS = 60 * 60 * 1000; // look for a newer anchor at most once an hour
const RETRY_MS = 15 * 60 * 1000; // after a failed build
const TIMEOUT_MS = 60000;
// The records are kept gzipped in blocks of this many, with the first key of each block: 29 MB of record text on
// 12 Nov 2026 (138,879 records) takes about 3 MB that way, and a lookup unpacks one block.
const BLOCK = 256;

const LEAF = Buffer.from([0]);
const NODE = Buffer.from([1]);
const sha = (...parts) => {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};

// The record kept for one resource: what the scan saw, without the free-text description and the response time.
// Must stay byte for byte the anchor's (tools/trust-anchor/lib.mjs recordOf), or no root will match.
function recordOf(key, r, delivery = {}) {
  const last = r.last ?? {};
  const rec = { h: r.h ?? null, v: last.verdict ?? null, c: Array.isArray(last.codes) ? last.codes : [], p: last.price_usd ?? null, n: Array.isArray(last.networks) ? last.networks : [] };
  if (r.m) rec.m = r.m;
  if (r.pt?.a) rec.pt = r.pt.a;
  const dn = delivery.nohumans?.[key];
  const dp = delivery.payapi?.[key];
  if (dn) rec.dn = [dn[0], dn[1]];
  if (dp) rec.dp = [dp[0], dp[1]];
  return rec;
}

// The 45 bytes on chain (hex), or null when they aren't a Trust Index anchor.
function parseAnchor(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-f]{90}$/i.test(hex)) return null;
  const b = Buffer.from(hex, 'hex');
  if (b.toString('ascii', 0, 4) !== 'FZTI' || b[4] !== 1) return null;
  const d = String(b.readUInt32BE(5));
  if (!/^\d{8}$/.test(d)) return null;
  return { version: b[4], day: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, root: b.subarray(9, 41).toString('hex'), count: b.readUInt32BE(41) };
}

// The newest anchors on chain: [{ day, root, count, tx, block, time, data }], newest first.
async function chainAnchors({ fetchImpl = fetch, account = ANCHOR_ACCOUNT, walletProxy = WALLET_PROXY, limit = 20 } = {}) {
  const res = await fetchImpl(`${walletProxy}/v1/accTransactions/${account}?order=d&limit=${limit}`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Concordium's wallet proxy answered ${res.status}`);
  const body = await res.json();
  const out = [];
  for (const t of body?.transactions || []) {
    const d = t?.details;
    if (d?.type !== 'registerData' || d.outcome !== 'success' || t.origin?.type !== 'self') continue;
    const a = parseAnchor(d.registeredData);
    if (a) out.push({ ...a, tx: t.transactionHash, block: t.blockHash, time: typeof t.blockTime === 'number' ? new Date(t.blockTime * 1000).toISOString() : null, data: d.registeredData.toLowerCase() });
  }
  // One anchor per day is the rule; if a day was ever registered twice, the first one counts.
  const byDay = new Map();
  for (const a of out.reverse()) if (!byDay.has(a.day)) byDay.set(a.day, a);
  return [...byDay.values()].sort((x, y) => (x.day < y.day ? 1 : -1));
}

// Every level of the tree, leaves first, each level one Buffer of 32-byte hashes.
function levelsOf(leaves) {
  const all = [leaves];
  while (all[all.length - 1].length > 32) {
    const cur = all[all.length - 1];
    const n = cur.length / 32;
    const next = Buffer.alloc(Math.ceil(n / 2) * 32);
    for (let i = 0; i < n; i += 2) {
      const h = i + 1 < n ? sha(NODE, cur.subarray(i * 32, i * 32 + 32), cur.subarray(i * 32 + 32, i * 32 + 64)) : cur.subarray(i * 32, i * 32 + 32);
      h.copy(next, (i / 2) * 32);
    }
    all.push(next);
  }
  return all;
}

// The path from leaf i to the root: [{ s: 'L' | 'R', h: hex }], the sibling's side at each level.
function pathOf(levels, i) {
  const path = [];
  for (let l = 0; l < levels.length - 1; l++) {
    const n = levels[l].length / 32;
    const sib = i ^ 1;
    if (sib < n) path.push({ s: i % 2 ? 'L' : 'R', h: levels[l].subarray(sib * 32, sib * 32 + 32).toString('hex') });
    i = Math.floor(i / 2);
  }
  return path;
}

function verifyPath(json, path, rootHex) {
  let h = sha(LEAF, Buffer.from(json, 'utf8'));
  for (const step of path) {
    const sib = Buffer.from(step.h, 'hex');
    h = step.s === 'L' ? sha(NODE, sib, h) : sha(NODE, h, sib);
  }
  return h.toString('hex') === String(rootHex).toLowerCase();
}

// The day's records from the trust-data branch, as the anchor builds them: { day, count, keys, lines }, sorted by key.
async function readRecords({ fetchImpl = fetch, data = DATA } = {}) {
  const get = async (file) => {
    const res = await fetchImpl(new URL(file, data).href, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`trust-data ${file} HTTP ${res.status}`);
    return res;
  };
  const metaRes = await get('index/meta.json');
  if (!metaRes) throw new Error('trust-data has no index/meta.json');
  const meta = await metaRes.json();
  const day = Array.isArray(meta.days) ? meta.days[meta.days.length - 1] : null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) throw new Error('index/meta.json has no days[]');
  const endpoints = async (file) => {
    const res = await get(file);
    return res ? (await res.json())?.endpoints ?? {} : {};
  };
  const delivery = { nohumans: await endpoints('delivery-nohumans.json'), payapi: await endpoints('delivery-payapi.json') };
  const rows = [];
  for (const part of meta.parts || []) {
    const res = await get(`index/${part}`);
    if (!res) throw new Error(`trust-data index/${part} is missing`);
    await eachLine(res, (line) => {
      if (!line.trim()) return;
      const [key, r] = JSON.parse(line);
      rows.push([key, JSON.stringify([key, recordOf(key, r, delivery)])]);
    });
  }
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (let i = 1; i < rows.length; i++) if (rows[i][0] === rows[i - 1][0]) throw new Error(`duplicate key ${rows[i][0]}`);
  if (meta.count && rows.length !== meta.count) throw new Error(`index/meta.json says ${meta.count} resources, the parts hold ${rows.length}`);
  return { day, count: rows.length, keys: rows.map((r) => r[0]), lines: rows.map((r) => r[1]) };
}

function createTrustProof({ fetchImpl = fetch, account = ANCHOR_ACCOUNT, walletProxy = WALLET_PROXY, data = DATA, now = () => Date.now(), log = console } = {}) {
  let tree = null; // { day, count, root, anchor, keys, lines, levels }
  let checkedAt = 0;
  let failedAt = 0;
  let building = null;

  async function build() {
    const anchors = await chainAnchors({ fetchImpl, account, walletProxy });
    checkedAt = now();
    if (!anchors.length) throw Object.assign(new Error('no Trust Index anchor found on chain yet'), { status: 503 });
    const newest = anchors[0];
    if (tree && tree.day === newest.day) return tree;
    const rec = await readRecords({ fetchImpl, data });
    const anchor = anchors.find((a) => a.day === rec.day);
    if (!anchor) {
      // The newest scan isn't anchored yet (the anchor runs after it): keep answering for the day we have.
      if (tree) return tree;
      throw Object.assign(new Error(`the newest Trust Index (${rec.day}) isn't anchored on Concordium yet; the anchor follows the daily scan, try again in an hour`), { status: 503 });
    }
    const leaves = Buffer.alloc(rec.lines.length * 32);
    rec.lines.forEach((json, i) => sha(LEAF, Buffer.from(json, 'utf8')).copy(leaves, i * 32));
    const levels = levelsOf(leaves);
    const root = levels[levels.length - 1].toString('hex');
    if (root !== anchor.root || rec.count !== anchor.count) {
      failedAt = now();
      log.warn?.(`[trust-proof] ${rec.day}: the records give root ${root.slice(0, 12)}… (${rec.count}), the chain has ${anchor.root.slice(0, 12)}… (${anchor.count})`);
      if (tree) return tree;
      throw Object.assign(new Error(`the published Trust Index of ${rec.day} doesn't give the root registered on chain; try again later`), { status: 503 });
    }
    const firstKeys = [];
    const blocks = [];
    for (let i = 0; i < rec.lines.length; i += BLOCK) {
      firstKeys.push(rec.keys[i]);
      blocks.push(zlib.gzipSync(rec.lines.slice(i, i + BLOCK).join('\n')));
    }
    tree = { day: rec.day, count: rec.count, root, anchor, firstKeys, blocks, levels };
    return tree;
  }

  async function ready() {
    const due = !tree || now() - checkedAt > CHECK_MS;
    if (!due) return tree;
    if (!tree && failedAt && now() - failedAt < RETRY_MS) throw Object.assign(new Error('the proof index is not ready; try again in a few minutes'), { status: 503 });
    if (!building) {
      building = build().catch((err) => {
        failedAt = now();
        checkedAt = now();
        throw err;
      }).finally(() => { building = null; });
    }
    try {
      return await building;
    } catch (err) {
      if (tree) return tree; // an outage of the chain reader or GitHub doesn't stop answers for the day we have
      throw err;
    }
  }

  // The proof for one resource URL (the key the Trust Index uses for it).
  async function proof(url) {
    let key;
    try { key = keyOf(String(url || '')); } catch { key = null; }
    if (!key) throw Object.assign(new Error('url is required: a paid x402 endpoint, e.g. ?url=https://api.example.com/paid'), { status: 400 });
    const t = await ready();
    // The last block whose first key is not after this key, then the record inside it.
    let lo = 0;
    let hi = t.firstKeys.length - 1;
    let b = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (t.firstKeys[mid] <= key) { b = mid; lo = mid + 1; } else hi = mid - 1;
    }
    let i = -1;
    let json = null;
    if (b >= 0) {
      const lines = zlib.gunzipSync(t.blocks[b]).toString('utf8').split('\n');
      const j = lines.findIndex((line) => JSON.parse(line)[0] === key);
      if (j >= 0) { i = b * BLOCK + j; json = lines[j]; }
    }
    const anchor = { network: 'mainnet', account, tx: t.anchor.tx, block: t.anchor.block, time: t.anchor.time, data: t.anchor.data, explorer: `https://ccdscan.io/?dcount=1&dentity=transaction&dhash=${t.anchor.tx}` };
    if (i < 0) return { found: false, day: t.day, key, count: t.count, root: t.root, anchor, reason: `not in the Trust Index of ${t.day} (it lists every paid x402 endpoint the daily scan found; an endpoint added later is in the next day's)` };
    return {
      found: true,
      day: t.day,
      key,
      record: JSON.parse(json)[1],
      leaf_json: json,
      index: i,
      count: t.count,
      path: pathOf(t.levels, i),
      root: t.root,
      anchor,
      how: 'leaf = sha256(0x00 || utf8(leaf_json)); for each step, node = sha256(0x01 || h || node) when s is "L", else sha256(0x01 || node || h); the result is root. The anchor\'s data is "FZTI" || 0x01 || day (uint32, YYYYMMDD) || root || count (uint32): check it in the transaction on chain.',
    };
  }

  return { proof, ready, status: () => (tree ? { day: tree.day, count: tree.count, root: tree.root, tx: tree.anchor.tx } : null) };
}

module.exports = { createTrustProof, recordOf, parseAnchor, chainAnchors, levelsOf, pathOf, verifyPath, readRecords, ANCHOR_ACCOUNT };
