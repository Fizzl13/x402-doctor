const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createTrustProof, parseAnchor, verifyPath, recordOf, levelsOf, pathOf } = require('../lib/trust-proof');
const { createApp } = require('../server');

const sha = (...parts) => { const h = crypto.createHash('sha256'); for (const p of parts) h.update(p); return h.digest(); };
// The anchor's own tree (tools/trust-anchor/lib.mjs), written out separately: one Buffer per node, odd node moves up.
function anchorRoot(lines) {
  let level = lines.map((l) => sha(Buffer.from([0]), Buffer.from(l, 'utf8')));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? sha(Buffer.from([1]), level[i], level[i + 1]) : level[i]);
    level = next;
  }
  return level[0].toString('hex');
}
function anchorHex(day, root, count) {
  const b = Buffer.alloc(45);
  b.write('FZTI', 0, 'ascii');
  b[4] = 1;
  b.writeUInt32BE(Number(day.replace(/-/g, '')), 5);
  Buffer.from(root, 'hex').copy(b, 9);
  b.writeUInt32BE(count, 41);
  return b.toString('hex');
}

const ACCOUNT = '3t4YnWTTYwqLNQHcrYvE5bQWtgkfx8gMNwwm1dRbi61ofFURpp';
// A small published index: seven resources (an odd count, so a node moves up), out of order in the parts.
function trustData(day) {
  const res = {};
  const urls = ['https://b.example/paid', 'https://a.example/x', 'https://c.example/q', 'https://a.example/a', 'https://d.example/root', 'https://e.example/z', 'https://a.example/m'];
  urls.forEach((u, i) => { res[u] = { h: 'g'.repeat(i + 1), last: { verdict: i % 3 ? 'go' : 'caution', codes: i % 3 ? [] : ['slow'], price_usd: 0.01 * (i + 1), networks: ['eip155:8453'] }, m: 'GET', ...(i === 2 ? { pt: { a: { 'eip155:8453': 'ab12' } } } : {}), desc: 'not kept' }; });
  const lines = Object.entries(res).map((e) => JSON.stringify(e));
  return {
    meta: { version: 1, days: ['2026-11-10', day], count: urls.length, parts: ['00.ndjson', '01.ndjson'] },
    parts: { '00.ndjson': lines.slice(0, 4).join('\n') + '\n', '01.ndjson': lines.slice(4).join('\n') },
    delivery: { nohumans: { 'https://c.example/q': ['2026-11-09', 'listed', 'https://nohumans.directory/x'] }, payapi: {} },
    res,
  };
}
const expectedLines = (td) => Object.keys(td.res).sort().map((k) => JSON.stringify([k, recordOf(k, td.res[k], td.delivery)]));

function fakeFetch({ td, anchors }) {
  const calls = [];
  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.startsWith('https://wallet-proxy.mainnet.concordium.software/v1/accTransactions/')) {
      return json({ transactions: anchors().map((a, i) => ({ transactionHash: a.tx, blockHash: `b${i}`, blockTime: 1794483910 - i * 86400, origin: { type: 'self' }, details: { type: 'registerData', outcome: 'success', registeredData: a.data } })) });
    }
    const file = url.replace('https://raw.githubusercontent.com/Fizzl13/x402-doctor/trust-data/', '');
    if (file === 'index/meta.json') return json(td().meta);
    if (file === 'delivery-nohumans.json') return json({ endpoints: td().delivery.nohumans });
    if (file === 'delivery-payapi.json') return json({ endpoints: td().delivery.payapi });
    const part = file.replace('index/', '');
    if (td().parts[part] !== undefined) return { ok: true, status: 200, body: null, text: async () => td().parts[part] };
    return json({}, 404);
  };
  return { fetchImpl, calls };
}

test('trust proof: the root from the published index equals the anchor\'s; each record proves against the root on chain', async () => {
  const td = trustData('2026-11-12');
  const lines = expectedLines(td);
  const root = anchorRoot(lines);
  const tx = 'c7'.repeat(32);
  const { fetchImpl } = fakeFetch({ td: () => td, anchors: () => [{ tx, data: anchorHex('2026-11-12', root, lines.length) }] });
  const tp = createTrustProof({ fetchImpl, log: { warn() {} } });
  for (const key of Object.keys(td.res)) {
    const p = await tp.proof(key);
    assert.equal(p.found, true, key);
    assert.equal(p.root, root);
    assert.equal(p.day, '2026-11-12');
    assert.ok(verifyPath(p.leaf_json, p.path, p.root), `path of ${key}`);
    assert.equal(p.anchor.tx, tx);
    assert.equal(p.anchor.data, anchorHex('2026-11-12', root, lines.length));
    assert.equal(p.record.desc, undefined, 'the description is not part of the record');
  }
  const c = await tp.proof('https://c.example/q');
  assert.deepEqual(c.record.dn, ['2026-11-09', 'listed']);
  assert.deepEqual(c.record.pt, { 'eip155:8453': 'ab12' });
  const none = await tp.proof('https://nowhere.example/paid');
  assert.equal(none.found, false);
  assert.match(none.reason, /not in the Trust Index of 2026-11-12/);
  await assert.rejects(tp.proof('not a url'), (e) => e.status === 400);
  // The tree in blocks of hashes gives the same root as the anchor's list of nodes, for any count.
  for (const n of [1, 2, 3, 5, 8, 9, 17]) {
    const ls = Array.from({ length: n }, (_, i) => `["k${i}",{}]`);
    const leaves = Buffer.concat(ls.map((l) => sha(Buffer.from([0]), Buffer.from(l))));
    const lv = levelsOf(leaves);
    assert.equal(lv[lv.length - 1].toString('hex'), anchorRoot(ls), `n=${n}`);
    for (let i = 0; i < n; i++) assert.ok(verifyPath(ls[i], pathOf(lv, i), anchorRoot(ls)), `n=${n} i=${i}`);
  }
});

test('trust proof: refuses a root the chain doesn\'t have; waits for the anchor of a new scan, answering for the day it has', async () => {
  let td = trustData('2026-11-12');
  const lines = expectedLines(td);
  const good = { tx: 'aa'.repeat(32), data: anchorHex('2026-11-12', anchorRoot(lines), lines.length) };
  let anchors = [{ tx: 'bb'.repeat(32), data: anchorHex('2026-11-12', 'ff'.repeat(32), lines.length) }];
  let t = 0;
  const { fetchImpl } = fakeFetch({ td: () => td, anchors: () => anchors });
  const tp = createTrustProof({ fetchImpl, now: () => t, log: { warn() {} } });
  await assert.rejects(tp.proof('https://a.example/a'), (e) => e.status === 503 && /doesn't give the root registered on chain/.test(e.message));
  // Fixed on chain (a real anchor), an hour and more later: answers.
  anchors = [good];
  t += 2 * 60 * 60 * 1000;
  assert.equal((await tp.proof('https://a.example/a')).found, true);
  // The next scan is published, not anchored yet: still the 12th.
  td = trustData('2026-11-13');
  t += 2 * 60 * 60 * 1000;
  const p = await tp.proof('https://a.example/a');
  assert.equal(p.day, '2026-11-12');
  // Not a Trust Index anchor, or a later one with another account's data: ignored.
  assert.equal(parseAnchor('00'.repeat(45)), null);
  assert.equal(parseAnchor('465a5449'), null);
  // A fresh start before the new scan is anchored: says so.
  const fresh = createTrustProof({ fetchImpl, log: { warn() {} } });
  await assert.rejects(fresh.proof('https://a.example/a'), (e) => e.status === 503 && /isn't anchored on Concordium yet/.test(e.message));
});

test('trust proof: the 12 Nov 2026 anchor as registered on mainnet', () => {
  const a = parseAnchor('465a544901013528f8ace079e5c7ed91ccab1ac4e8e35ca435627032eeb0aaa0282e002590ae19a9fa00021e7f');
  assert.deepEqual(a, { version: 1, day: '2026-11-12', root: 'ace079e5c7ed91ccab1ac4e8e35ca435627032eeb0aaa0282e002590ae19a9fa', count: 138879 });
});

test('GET /api/trust/proof: open CORS, 200 found, 404 not in the index, 400 without a url, 503 while not ready', async () => {
  const answers = {
    'https://a.example/x': { found: true, day: '2026-11-12', key: 'https://a.example/x', path: [], root: 'ab' },
    'https://b.example/y': { found: false, day: '2026-11-12', key: 'https://b.example/y', reason: 'not in the Trust Index of 2026-11-12' },
  };
  let ready = true;
  const trustProof = { proof: async (url) => {
    if (!url) throw Object.assign(new Error('url is required'), { status: 400 });
    if (!ready) throw Object.assign(new Error('not anchored yet'), { status: 503 });
    return answers[url];
  } };
  const app = createApp({ env: {}, status: { snapshot: async () => ({}) }, trustProof });
  const s = await new Promise((r) => { const srv = app.listen(0, '127.0.0.1', () => r(srv)); });
  try {
    const base = `http://127.0.0.1:${s.address().port}/api/trust/proof`;
    const ok = await fetch(`${base}?url=${encodeURIComponent('https://a.example/x')}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('access-control-allow-origin'), '*');
    assert.equal((await ok.json()).found, true);
    assert.equal((await fetch(`${base}?url=${encodeURIComponent('https://b.example/y')}`)).status, 404);
    assert.equal((await fetch(base)).status, 400);
    ready = false;
    const wait = await fetch(`${base}?url=${encodeURIComponent('https://a.example/x')}`);
    assert.equal(wait.status, 503);
    assert.match((await wait.json()).error, /not anchored yet/);
  } finally {
    s.close();
  }
});
