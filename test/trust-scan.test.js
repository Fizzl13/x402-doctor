// x402 Trust Index: catalog loading, polite fetching, the scan itself against
// local sellers, and the rolling 30-day history. No network.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createSafeFetch } = require('../lib/safe-fetch');
const { loadCatalog, politeFetch, scan, mergeIndex, trackRecord, summarize, USER_AGENT } = require('../lib/trust-scan');
const { createTrustIndex } = require('../lib/trust-index');

const BASE = 'eip155:8453';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const servers = [];
function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    servers.push(server);
  });
}
test.after(() => servers.forEach((s) => s.close()));

test('loadCatalog pages through the CDP catalog, dedupes by origin + path and keeps the declared method', async () => {
  const page0 = [
    ...Array.from({ length: 498 }, (_, i) => ({ resource: `https://s${i}.example/api` })),
    { resource: 'https://a.example/paid?x=1', extensions: { bazaar: { info: { input: { method: 'POST' } } } }, description: 'A paid thing' },
    { resource: 'https://a.example/paid?x=2' },
  ];
  const fetchImpl = async (url) => ({ ok: true, json: async () => ({ items: new URL(url).searchParams.get('offset') === '0' ? page0 : [{ resource: 'not a url' }] }) });
  const list = await loadCatalog({ url: 'https://cdp.test/r', fetchImpl });
  assert.equal(list.length, 499);
  const a = list.find((r) => r.key === 'https://a.example/paid');
  assert.equal(a.method, 'POST');
  assert.equal(a.url, 'https://a.example/paid?x=1');
  assert.equal(a.description, 'A paid thing');
});

test('politeFetch: User-Agent, at most 2 requests per host, one /openapi.json per origin', async () => {
  let active = 0;
  let peak = 0;
  let openapiHits = 0;
  const agents = new Set();
  const origin = await listen(async (req, res) => {
    agents.add(req.headers['user-agent']);
    if (req.url === '/openapi.json') openapiHits++;
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 30));
    active--;
    res.end('{}');
  });
  const f = politeFetch(createSafeFetch({ allowPrivate: true }), { perHost: 2 });
  await Promise.all([...Array.from({ length: 8 }, (_, i) => f(`${origin}/x/${i}`)), f(`${origin}/openapi.json`), f(`${origin}/openapi.json`)]);
  assert.equal(peak, 2);
  assert.equal(openapiHits, 1);
  assert.deepEqual([...agents], [USER_AGENT]);
});

test('scan: go, no_go and unreachable sellers, with price and networks', async () => {
  const good = await listen((req, res) => {
    if (req.url === '/openapi.json') return res.end('{}');
    const challenge = { x402Version: 2, resource: { url: `http://${req.headers.host}${req.url}`, mimeType: 'application/json', description: 'x' }, accepts: [{ scheme: 'exact', network: BASE, amount: '20000', asset: USDC_BASE, payTo: '0x6B0F4651eD42893ab58139938175E4a69f175F25', maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }] };
    res.statusCode = 402;
    res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(challenge)).toString('base64'));
    res.end(JSON.stringify(challenge));
  });
  const free = await listen((_req, res) => res.end('{"ok":true}'));
  const results = await scan(
    [
      { key: 'good', url: `${good}/paid` },
      { key: 'free', url: `${free}/paid`, method: 'GET' },
      { key: 'down', url: 'http://127.0.0.1:1/paid', method: 'GET' },
    ],
    { safeFetch: createSafeFetch({ allowPrivate: true, timeoutMs: 2000 }) }
  );
  const by = Object.fromEntries(results.map((r) => [r.key, r]));
  assert.equal(by.good.verdict, 'go');
  assert.equal(by.good.price_usd, 0.02);
  assert.deepEqual(by.good.networks, [BASE]);
  assert.equal(by.free.verdict, 'no_go');
  assert.deepEqual(by.free.codes, ['no_402']);
  assert.equal(by.down.verdict, 'no_go');
});

test('mergeIndex keeps one letter per day aligned with days, replaces a same-day re-run, drops long-gone resources', () => {
  const r = (key, verdict) => ({ key, url: `https://${key}.example/p`, method: 'GET', verdict, codes: [], price_usd: 0.01, networks: [BASE], ms: 5 });
  let index = mergeIndex(null, [r('a', 'go'), r('b', 'no_go')], { date: '2026-09-01' });
  assert.deepEqual(index.days, ['2026-09-01']);
  assert.equal(index.resources.a.h, 'g');
  index = mergeIndex(index, [r('a', 'caution'), r('c', 'go')], { date: '2026-09-02' });
  assert.equal(index.resources.a.h, 'gc');
  assert.equal(index.resources.b.h, 'n-');
  assert.equal(index.resources.c.h, '-g');
  index = mergeIndex(index, [r('a', 'error')], { date: '2026-09-02' });
  assert.equal(index.resources.a.h, 'gx', 'same-day re-run replaces the day');
  for (let d = 3; d <= 32; d++) index = mergeIndex(index, [r('a', 'go')], { date: `2026-09-${String(d).padStart(2, '0')}` });
  assert.equal(index.days.length, 30);
  assert.equal(index.resources.a.h.length, 30);
  assert.equal(index.resources.b, undefined, 'not seen for 30 days');
  assert.deepEqual(summarize(index).today, { g: 1, c: 0, n: 0, x: 0 });
});

test('trackRecord counts payable days and the current streak', () => {
  assert.deepEqual(trackRecord('--ggnxgg'), { days_checked: 6, days_payable: 4, payable_ratio: 0.67, last: 'g', streak: 2 });
  assert.deepEqual(trackRecord('ggnn'), { days_checked: 4, days_payable: 2, payable_ratio: 0.5, last: 'n', streak: 2 });
  assert.equal(trackRecord('---'), null);
});

test('trust index lookup reads the published index', async () => {
  const index = mergeIndex(null, [{ key: 'https://s.example/p', url: 'https://s.example/p?q=1', method: 'GET', verdict: 'go', codes: [], price_usd: 0.01, networks: [BASE], ms: 5 }], { date: '2026-09-23' });
  const trust = createTrustIndex({ url: 'https://raw.test/index.json', fetchImpl: async () => ({ ok: true, json: async () => index }) });
  const rec = await trust.lookup('https://s.example/p?other=2', { waitMs: 1000 });
  assert.equal(rec.days_checked, 1);
  assert.equal(rec.last_scan.price_usd, 0.01);
  assert.equal(await trust.lookup('https://t.example/p'), null);
  assert.equal(trust.summary().latest.go, 1);
});
