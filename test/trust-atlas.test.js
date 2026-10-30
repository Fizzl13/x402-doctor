// GET /api/trust/atlas: the Trust Index as a star map for atlas.fizzl.eu (sellers, endpoints, daily verdicts).
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { createTrustIndex } = require('../lib/trust-index');
const { descKey } = require('../lib/services');
const { createApp } = require('../server.js');

const index = {
  updated: '2026-10-15T01:00:00Z',
  days: ['2026-10-13', '2026-10-14', '2026-10-15'],
  resources: {
    a: { url: 'https://pay.seller.ai/a', h: 'ggg', d: 'Bitcoin price signal', last: { verdict: 'go', price_usd: 0.01, networks: ['eip155:8453', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'] } },
    b: { url: 'https://api.seller.ai/b', h: 'gn', d: 'Bitcoin price signal for traders', last: { verdict: 'no_go', codes: ['no_402'], networks: [null] } },
    c: { url: 'https://x.run.app/c', h: 'c', d: "Google's newest model, pay per call", last: { verdict: 'caution', price_usd: 0.03, networks: ['xrpl:0'] } },
    gone: { url: 'https://gone.example/z', h: '---' },
  },
};
const categories = { categories: { [descKey("Google's newest model, pay per call")]: 'ai' }, bait: { [descKey("Google's newest model, pay per call")]: [0.95, 0.02] } };
const fetchImpl = async (url) => new Response(JSON.stringify(String(url).includes('cat') ? categories : index));

test('atlas: sellers by size with their category, bait, median price and networks; endpoints with padded history', async () => {
  const ti = createTrustIndex({ url: 'http://index.test', categoriesUrl: 'http://cat.test', fetchImpl });
  assert.equal(ti.atlas(), null, 'null while loading');
  await ti.refresh();
  const a = ti.atlas();
  assert.equal(a.updated, '2026-10-15T01:00:00Z');
  assert.deepEqual(a.days, index.days);
  const cat = (id) => a.categories.findIndex((c) => c.id === id);
  assert.deepEqual(a.sellers, [
    ['seller.ai', cat('crypto'), 2, 0, 0.01, 0b11],
    ['x.run.app', cat('ai'), 1, 1, 0.03, 0b100],
  ]);
  assert.deepEqual(a.endpoints, [[0, 'ggg'], [0, '-gn'], [1, '--c', 1]], 'never-scanned resources are left out; short histories are padded');
  assert.equal(ti.updated(), '2026-10-15T01:00:00Z');
});

test('GET /api/trust/atlas: gzipped when asked, plain otherwise, open to any origin, 503 while loading; Bazaar paid calls per seller', async (t) => {
  const bazaarIndex = { lookup: async () => null, listings: async () => null, refresh: () => Promise.resolve(), siteCalls: () => ({ at: Date.parse('2026-10-15T12:00:00Z'), calls: new Map([['seller.ai', 900]]) }) };
  const app = createApp({ env: {}, status: { snapshot: async () => ({}) }, bazaarIndex, trustIndex: createTrustIndex({ url: 'http://index.test', categoriesUrl: 'http://cat.test', fetchImpl }) });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/trust/atlas`;
  let res = await fetch(url);
  if (res.status === 503) { await new Promise((r) => setTimeout(r, 200)); res = await fetch(url); }
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const body = await res.json();
  assert.equal(body.sellers.length, 2);
  assert.deepEqual(body.sellers.map((x) => [x[0], x[6]]), [['seller.ai', 900], ['x.run.app', 0]], "the Bazaar's 30-day settled calls per seller, 0 when unlisted");
  assert.deepEqual(body.paid_30d, { source: 'CDP Bazaar quality.l30DaysTotalCalls', read_at: '2026-10-15T12:00:00.000Z' });
  assert.equal(body.sellers[0].length, 7, 'no still-paid count without the Bazaar\'s lastCalledAt');
  const http = require('node:http');
  const raw = await new Promise((resolve, reject) => {
    http.get(url, { headers: { 'accept-encoding': 'gzip' } }, (r) => { const parts = []; r.on('data', (c) => parts.push(c)); r.on('end', () => resolve({ enc: r.headers['content-encoding'], body: Buffer.concat(parts) })); }).on('error', reject);
  });
  assert.equal(raw.enc, 'gzip');
  assert.equal(JSON.parse(zlib.gunzipSync(raw.body)).endpoints.length, 3);
});

test('GET /api/trust/atlas: per seller also the calls on routes still paid (a settled payment in the last 3 days)', async (t) => {
  const siteCalls = () => ({ at: Date.parse('2026-10-15T12:00:00Z'), calls: new Map([['seller.ai', 900], ['x.run.app', 300]]), active: new Map([['seller.ai', 700]]), payers: new Map() });
  const bazaarIndex = { lookup: async () => null, listings: async () => null, refresh: () => Promise.resolve(), siteCalls };
  const app = createApp({ env: {}, status: { snapshot: async () => ({}) }, bazaarIndex, trustIndex: createTrustIndex({ url: 'http://index.test', categoriesUrl: 'http://cat.test', fetchImpl }) });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/trust/atlas`;
  let res = await fetch(url);
  if (res.status === 503) { await new Promise((r) => setTimeout(r, 200)); res = await fetch(url); }
  const body = await res.json();
  // x.run.app was paid 300 times in 30 days but not in the last 3: a campaign that stopped.
  assert.deepEqual(body.sellers.map((x) => [x[0], x[6], x[7]]), [['seller.ai', 900, 700], ['x.run.app', 300, 0]]);
  assert.deepEqual(body.paid_30d, { source: 'CDP Bazaar quality.l30DaysTotalCalls', read_at: '2026-10-15T12:00:00.000Z', active_days: 3 });
});

test('bazaar index: settled calls over 30 days summed per seller site', async () => {
  const { createBazaarIndex } = require('../lib/bazaar-index');
  const day = 24 * 60 * 60 * 1000;
  const items = [
    { resource: 'https://pay.seller.ai/a', accepts: [], quality: { l30DaysTotalCalls: 700, l30DaysUniquePayers: 7, lastCalledAt: new Date(Date.now() - day).toISOString() } },
    { resource: 'https://api.seller.ai/b', accepts: [], quality: { l30DaysTotalCalls: 200, l30DaysUniquePayers: 2, lastCalledAt: new Date(Date.now() - 5 * day).toISOString() } },
    { resource: 'https://x.run.app/c', accepts: [], quality: {} },
  ];
  const bz = createBazaarIndex({ url: 'http://bazaar.test', fetchImpl: async () => new Response(JSON.stringify({ items })) });
  assert.equal(bz.siteCalls(), null, 'null while loading');
  await bz.refresh();
  assert.deepEqual([...bz.siteCalls().calls], [['seller.ai', 900]]);
  assert.deepEqual([...bz.siteCalls().active], [['seller.ai', 700]], 'route b has had no settled payment for 5 days');
  assert.deepEqual([...bz.siteCalls().payers], [['seller.ai', 9]]);
  assert.deepEqual(bz.siteCalls().top.map((r) => [r.route, r.site, r.calls, r.payers]), [['https://pay.seller.ai/a', 'seller.ai', 700, 7], ['https://api.seller.ai/b', 'seller.ai', 200, 2]], 'the largest routes by calls, for the market digest');
  assert.match(bz.siteCalls().top[0].last, /^\d{4}-\d\d-\d\dT/);
});

test('market summary: settled calls per seller grouped by today\'s verdicts and by kind of service', async () => {
  const { marketSummary } = require('../lib/market-summary');
  const ti = createTrustIndex({ url: 'http://index.test', categoriesUrl: 'http://cat.test', fetchImpl });
  await ti.refresh();
  const m = marketSummary(ti.atlas(), new Map([['seller.ai', 900], ['nobody.example', 50]]));
  assert.equal(m.scan_day, '2026-10-15');
  assert.equal(m.sellers, 2);
  assert.equal(m.calls_30d, 900, 'only sellers in today\'s scan count');
  assert.deepEqual(m.by_verdict, [
    { key: 'all_go', sellers: 0, sellers_with_calls: 0, calls: 0 },
    { key: 'caution', sellers: 1, sellers_with_calls: 0, calls: 0 },
    { key: 'some_no_go', sellers: 1, sellers_with_calls: 1, calls: 900 },
    { key: 'mostly_no_go', sellers: 0, sellers_with_calls: 0, calls: 0 },
  ], 'seller.ai has 1 of 2 endpoints failing (some, not most); x.run.app only caution');
  assert.deepEqual(m.bait, { sellers: 1, calls: 0 });
  assert.deepEqual(m.by_kind.map((k) => [k.id, k.sellers, k.sellers_with_calls, k.calls, k.top_seller_share]), [['crypto', 1, 1, 900, 1], ['ai', 1, 0, 0, 0]]);
  assert.equal(m.calls_active, undefined, 'no still-paid count without the Bazaar\'s quality fields');
  const withActive = marketSummary(ti.atlas(), new Map([['seller.ai', 900]]), { active: new Map([['seller.ai', 700]]), payers: new Map([['seller.ai', 9]]) });
  assert.equal(withActive.calls_active, 700);
  assert.deepEqual(withActive.by_kind.map((k) => [k.id, k.calls, k.calls_active, k.payers]), [['crypto', 900, 700, 9], ['ai', 0, 0, 0]]);
  assert.equal(marketSummary(null, new Map()), null);
  assert.equal(marketSummary(ti.atlas(), null), null);
});

test('GET /api/stats carries the market summary once the Trust Index and the Bazaar are in, with no "paid" key', async (t) => {
  const bazaarIndex = { lookup: async () => null, listings: async () => null, refresh: () => Promise.resolve(), siteCalls: () => ({ at: Date.parse('2026-10-15T12:00:00Z'), calls: new Map([['seller.ai', 900]]) }) };
  const trustIndex = createTrustIndex({ url: 'http://index.test', categoriesUrl: 'http://cat.test', fetchImpl });
  await trustIndex.refresh();
  const app = createApp({ env: {}, status: { snapshot: async () => ({}) }, bazaarIndex, trustIndex, publicStats: { get: async () => ({ updated: '2026-10-15T12:00:00Z' }) } });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => server.close());
  const body = await (await fetch(`http://127.0.0.1:${server.address().port}/api/stats`)).json();
  assert.equal(body.updated, '2026-10-15T12:00:00Z');
  assert.equal(body.market.calls_30d, 900);
  assert.equal(body.market.source, 'CDP Bazaar quality.l30DaysTotalCalls');
  assert.equal(body.market.read_at, '2026-10-15T12:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(body.market), /paid/);
});

test('sellerEndpoints: one seller across its subdomains, payable first, with verdict, record, price, networks and bait', async () => {
  const ti = createTrustIndex({ url: 'http://index.test', categoriesUrl: 'http://cat.test', fetchImpl });
  assert.equal(ti.sellerEndpoints('seller.ai'), null, 'null while loading');
  await ti.refresh();
  const s = ti.sellerEndpoints('seller.ai');
  assert.equal(s.total, 2);
  assert.deepEqual(s.endpoints.map((e) => [e.url, e.verdict]), [['https://pay.seller.ai/a', 'go'], ['https://api.seller.ai/b', 'no_go']]);
  assert.equal(s.endpoints[0].price_usd, 0.01);
  assert.equal(s.endpoints[0].payable_ratio, 1);
  assert.deepEqual(s.endpoints[1].networks, [], 'non-string networks dropped');
  assert.equal(ti.sellerEndpoints('x.run.app').endpoints[0].bait, true);
  assert.equal(ti.sellerEndpoints('nobody.example').total, 0);
  assert.equal(ti.sellerEndpoints('seller.ai', { limit: 1 }).truncated, true);
});

test('GET /api/trust/seller: any subdomain names the seller, open to any origin; 400 without a host, 404 for an unknown seller', async (t) => {
  const bazaarIndex = { lookup: async () => null, listings: async () => null, refresh: () => Promise.resolve(), siteCalls: () => null };
  const ti = createTrustIndex({ url: 'http://index.test', categoriesUrl: 'http://cat.test', fetchImpl });
  await ti.refresh();
  const app = createApp({ env: {}, status: { snapshot: async () => ({}) }, bazaarIndex, trustIndex: ti });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/trust/seller`;
  const res = await fetch(`${base}?host=api.seller.ai`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const body = await res.json();
  assert.equal(body.site, 'seller.ai');
  assert.equal(body.endpoints.length, 2);
  assert.match(body.check, /\/\?url=$/);
  assert.equal((await (await fetch(`${base}?host=https://pay.seller.ai/a`)).json()).site, 'seller.ai', 'a URL works too');
  assert.equal((await fetch(base)).status, 400);
  assert.equal((await fetch(`${base}?host=nobody.example`)).status, 404);
});

test('GET /api/trust/seller: 503 with a reason while the seller lists are not published, and when the reader has none', async (t) => {
  const bazaarIndex = { lookup: async () => null, listings: async () => null, refresh: () => Promise.resolve(), siteCalls: () => null };
  for (const [trustIndex, want] of [[{ sellerEndpoints: async () => ({ unavailable: true }) }, /next daily scan/], [{}, /loading/]]) {
    const app = createApp({ env: {}, status: { snapshot: async () => ({}) }, bazaarIndex, trustIndex: { atlas: () => null, summary: () => null, refresh: () => Promise.resolve(), ...trustIndex } });
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    t.after(() => server.close());
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/trust/seller?host=fizzl.eu`);
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, want);
  }
});
