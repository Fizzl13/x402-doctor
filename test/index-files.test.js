// The Trust Index in parts (lib/index-files.js), network views in parts (lib/trust-views.js, lib/trust-reader.js) and
// the scan in parallel shares (scripts/trust-scan.js): no published file grows past GitHub's 100 MB limit, no job past
// its 3 hours, and every reader gets the same index as from the single files. No network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeIndexDir, readIndexDir, readIndexFile, loadIndex } = require('../lib/index-files');
const { createTrustIndex } = require('../lib/trust-index');
const { buildViews, partsOf } = require('../lib/trust-views');
const { createTrustReader } = require('../lib/trust-reader');
const { interleave, shareOf, hostOf } = require('../lib/trust-scan');
const { merge } = require('../scripts/trust-scan');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'index-files-'));
const r = (url, h, last, d = '') => ({ url, m: 'GET', h, last, d });
const go = (networks) => ({ verdict: 'go', codes: [], price_usd: 0.01, networks });
// An index of n resources on a few hosts, Base and XRPL; descriptions with a two-byte character.
function indexOf(n) {
  const resources = {};
  for (let i = 0; i < n; i++) {
    const url = `https://h${i % 7}.example/api/${i}`;
    resources[url] = r(url, i % 3 ? 'gg' : '-c', go(i % 5 ? ['eip155:8453'] : ['eip155:8453', 'xrpl:0']), `Café price feed number ${i}`);
  }
  return { version: 1, updated: '2026-10-25T05:25:53.000Z', days: ['2026-10-24', '2026-10-25'], resources, sanctions: { list: 'OFAC SDN', published: '2026-10-21', addresses: 1050 } };
}
// Files of a directory served over fetch, as raw.githubusercontent.com would, with an ETag each.
function serve(dir, base) {
  const asked = [];
  const fetchImpl = async (u, opts = {}) => {
    const rel = u.replace(base, '');
    asked.push(rel);
    const file = path.join(dir, rel);
    if (!fs.existsSync(file)) return new Response('not found', { status: 404 });
    const etag = `"${fs.statSync(file).mtimeMs}"`;
    if (opts.headers?.['if-none-match'] === etag) return new Response(null, { status: 304 });
    return new Response(fs.readFileSync(file), { headers: { etag } });
  };
  return { fetchImpl, asked };
}

test('index parts: written in parts of at most partBytes, read back the same; the single files only while they fit', () => {
  const dir = tmp();
  const index = indexOf(500);
  const written = writeIndexDir(dir, index, { partBytes: 8000 });
  assert.equal(written.count, 500);
  assert.ok(written.parts.length > 5, `${written.parts.length} parts`);
  for (const part of written.parts) assert.ok(fs.statSync(path.join(dir, 'index', part)).size <= 8000, part);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'index', 'meta.json'), 'utf8'));
  assert.deepEqual([meta.count, meta.parts, meta.days, meta.resources], [500, written.parts, index.days, undefined]);
  assert.deepEqual(readIndexDir(dir), index);
  assert.equal(written.single, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')), index);
  assert.equal(fs.readFileSync(path.join(dir, 'index.ndjson'), 'utf8').trim().split('\n').length, 501, 'a header and one line per resource');

  // Too large for one file: the single files are left out (and yesterday's removed), the parts still hold it all.
  const smaller = indexOf(300);
  const again = writeIndexDir(dir, smaller, { partBytes: 8000, compatMaxBytes: 10000 });
  assert.equal(again.single, false);
  assert.ok(!fs.existsSync(path.join(dir, 'index.json')) && !fs.existsSync(path.join(dir, 'index.ndjson')));
  assert.equal(fs.readdirSync(path.join(dir, 'index')).length, again.parts.length + 1, "no part left over from yesterday's larger index");
  assert.deepEqual(readIndexDir(dir), smaller);

  // An empty index is still a valid one.
  writeIndexDir(dir, { ...index, resources: {} });
  assert.deepEqual(readIndexDir(dir).resources, {});
});

test('index parts: a script reads the parts beside its --index path, else the file itself; nothing at all is null', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(indexOf(3)));
  assert.equal(Object.keys(readIndexFile(path.join(dir, 'index.json')).resources).length, 3, 'a branch from before the parts');
  writeIndexDir(dir, indexOf(40), { partBytes: 2000, compatMaxBytes: 100 });
  assert.equal(Object.keys(readIndexFile(path.join(dir, 'index.json')).resources).length, 40, 'the parts, though index.json is gone');
  assert.equal(readIndexDir(tmp()), null);
});

test('index parts: a report reads the published parts, or index.json from before them, or a URL it is given', async () => {
  const base = 'https://raw.test/trust-data/';
  const dir = tmp();
  const index = indexOf(120);
  writeIndexDir(dir, index, { partBytes: 3000 });
  const { fetchImpl, asked } = serve(dir, base);
  assert.deepEqual(await loadIndex(undefined, { fetchImpl, base }), index);
  assert.equal(asked[0], 'index/meta.json');
  assert.ok(asked.length > 3, 'then each part');

  const old = tmp();
  fs.writeFileSync(path.join(old, 'index.json'), JSON.stringify(index));
  const before = serve(old, base);
  assert.deepEqual(await loadIndex(undefined, { fetchImpl: before.fetchImpl, base }), index);
  assert.deepEqual(before.asked, ['index/meta.json', 'index.json']);
  assert.deepEqual(await loadIndex(`${base}index.json`, { fetchImpl: before.fetchImpl, base }), index);
  await assert.rejects(loadIndex(undefined, { fetchImpl: async () => new Response('busy', { status: 503 }), base }), /HTTP 503/);
});

test("Doctor's full index: reads the parts line by line; an unchanged meta.json (304) downloads nothing", async () => {
  const base = 'https://raw.githubusercontent.com/Fizzl13/x402-doctor/trust-data/';
  const dir = tmp();
  const index = indexOf(60);
  writeIndexDir(dir, index, { partBytes: 2500 });
  const { fetchImpl, asked } = serve(dir, base);
  const ti = createTrustIndex({ categoriesUrl: 'http://cat.test/c.json', submittedUrl: 'http://sub.test/s.json', fetchImpl: (u, o) => (u.startsWith(base) ? fetchImpl(u, o) : new Response('', { status: 404 })) });
  await ti.refresh();
  const url = 'https://h1.example/api/1';
  assert.equal((await ti.lookup(url)).days_payable, 2);
  assert.equal(ti.summary().resources, 60);
  const parts = asked.filter((a) => a.endsWith('.ndjson'));
  assert.ok(parts.length > 2 && !asked.includes('index.ndjson'), 'the parts, not the single file');
  asked.length = 0;
  await ti.refresh();
  assert.deepEqual(asked, ['index/meta.json']);
});

test('network views: a large view is published as a head and parts, joined again to the same view and the same API answer', async () => {
  const index = indexOf(400);
  const whole = await buildViews({ index });
  const files = await buildViews({ index, viewPartChars: 30000 });
  const meta = files.get('views/meta.json');
  assert.ok(meta.network_parts['eip155:8453'] > 2, JSON.stringify(meta.network_parts));
  assert.ok(!meta.network_parts.xrpl, 'a small view stays one file');
  assert.equal(files.get('views/networks/eip155_3a8453.json').resources, undefined);
  for (const [p, v] of files) if (p.includes('.part')) assert.ok(JSON.stringify(v).length <= 30000, p);

  const base = 'https://data.test/trust-data/';
  const map = new Map([...files].map(([p, v]) => [base + p, JSON.stringify(v)]));
  const reader = createTrustReader({ base, fetchImpl: async (u) => (map.has(u) ? new Response(map.get(u), { headers: { etag: '"v1"' } }) : new Response('not found', { status: 404 })) });
  for (const n of ['eip155:8453', 'eip155', 'xrpl']) {
    const want = whole.get(`views/networks/${n.replace(':', '_3a')}.json`);
    assert.deepEqual(await reader.byNetwork(n, { waitMs: 2000 }), want, n);
    const opened = await reader.openNetwork(n);
    const text = opened.stream ? (await Array.fromAsync(opened.stream)).join('') : await opened.res.text();
    assert.deepEqual(JSON.parse(text), want, `${n} through the API`);
  }
  assert.ok((await reader.openNetwork('eip155:8453')).stream, 'a parted view is streamed part by part');
  assert.deepEqual(partsOf([], 10), [[]]);
  assert.deepEqual(partsOf(['aaaaaaaaaaaa', 'b'], 10), [['aaaaaaaaaaaa'], ['b']], 'an item larger than a part is a part of its own');
});

test("scan shares: a seller's endpoints all in one share; the daily turn changes each seller's starting point", () => {
  const resources = Object.values(indexOf(70).resources).map((x) => ({ key: x.url, url: x.url }));
  const shares = new Map();
  for (const x of resources) {
    const s = shareOf(hostOf(x), 4);
    assert.ok(s >= 0 && s < 4);
    if (shares.has(hostOf(x))) assert.equal(shares.get(hostOf(x)), s, hostOf(x));
    shares.set(hostOf(x), s);
  }
  assert.equal(shareOf('market.example', 4), shareOf('market.example', 4), 'the same share every day');
  const items = ['a1', 'a2', 'a3', 'b1', 'b2'];
  assert.deepEqual(interleave(items, (x) => x[0]), ['a1', 'b1', 'a2', 'b2', 'a3']);
  assert.deepEqual(interleave(items, (x) => x[0], (key) => (key === 'a' ? 4 : 0)), ['a2', 'b1', 'a3', 'b2', 'a1'], 'a turned by 4 % 3 = 1');
});

test('scan merge: shares become one index in parts; a share that did not finish leaves its endpoints not checked, never down', () => {
  const dir = tmp();
  const before = indexOf(28);
  writeIndexDir(dir, before);
  const todo = { date: '2026-10-26', resources: Object.values(before.resources).map((x) => ({ key: x.url, url: x.url, description: x.d })), added: [], hub_merchants: [] };
  const result = (x) => ({ key: x.key, url: x.url, method: 'GET', verdict: 'go', codes: [], price_usd: 0.01, networks: ['eip155:8453'], ms: 5 });
  const mine = (share) => todo.resources.filter((x) => shareOf(hostOf(x), 2) === share);
  assert.ok(mine(0).length && mine(1).length, 'both shares have sellers');
  const done = [{ share: 0, shares: 2, seconds: 30, sanctions: before.sanctions, statuses: [{ host: 'h1.example', total: 2, statuses: { 404: 2 } }], slow_hosts: [], results: mine(0).map(result) }];
  const logs = [];
  const log = console.log;
  console.log = (line) => logs.push(String(line));
  try { merge(todo, done, { out: dir }); } finally { console.log = log; }

  const index = readIndexDir(dir);
  assert.deepEqual(index.days, ['2026-10-24', '2026-10-25', '2026-10-26']);
  for (const x of mine(0)) assert.equal(index.resources[x.key].h.at(-1), 'g', x.key);
  for (const x of mine(1)) assert.equal(index.resources[x.key].h.at(-1), '-', `${x.key}: share 2 did not finish`);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
  assert.deepEqual([summary.date, summary.shares, summary.scan_seconds, summary.today.g], ['2026-10-26', { finished: 1, of: 2 }, 30, mine(0).length]);
  assert.deepEqual(index.sanctions, before.sanctions);
  assert.ok(logs.some((l) => l.startsWith('shares not finished: 2 of 2')), logs.join('\n'));
  assert.ok(logs.some((l) => l.includes('h1.example: 2 (404 x2)')));
  assert.ok(fs.existsSync(path.join(dir, 'paytos.json')));
});
