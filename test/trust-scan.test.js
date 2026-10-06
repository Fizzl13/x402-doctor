// x402 Trust Index: catalog loading, polite fetching, the scan itself against
// local sellers, and the rolling 30-day history. No network.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createSafeFetch } = require('../lib/safe-fetch');
const { loadCatalog, politeFetch, retryAfterMs, scan, mergeIndex, trackRecord, summarize, USER_AGENT } = require('../lib/trust-scan');
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

test('scan: a listing that declares GET but only asks for payment on POST still counts as payable', async () => {
  const postOnly = await listen((req, res) => {
    if (req.url === '/openapi.json') return res.end('{}');
    if (req.method !== 'POST') { res.statusCode = 405; return res.end('use POST'); }
    const challenge = { x402Version: 2, resource: { url: `http://${req.headers.host}${req.url}`, mimeType: 'application/json', description: 'x' }, accepts: [{ scheme: 'exact', network: BASE, amount: '10000', asset: USDC_BASE, payTo: '0x6B0F4651eD42893ab58139938175E4a69f175F25', maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }] };
    res.statusCode = 402;
    res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(challenge)).toString('base64'));
    res.end('{}'); // requirements in the header only
  });
  const [r] = await scan([{ key: 'p', url: `${postOnly}/paid`, method: 'GET' }], { safeFetch: createSafeFetch({ allowPrivate: true, timeoutMs: 2000 }) });
  assert.equal(r.verdict, 'go');
  assert.equal(r.method, 'POST');
});

test('Retry-After: seconds or an HTTP date, capped at 60 s, 5 s when missing', () => {
  assert.equal(retryAfterMs('10'), 10000);
  assert.equal(retryAfterMs('3600'), 60000);
  assert.equal(retryAfterMs(undefined), 5000);
  assert.equal(retryAfterMs('soon'), 5000);
  const now = Date.parse('2026-09-25T12:00:00Z');
  assert.equal(retryAfterMs('Fri, 25 Sep 2026 12:00:20 GMT', now), 20000, 'HTTP date');
  assert.equal(retryAfterMs('Fri, 25 Sep 2026 11:59:00 GMT', now), 0, 'a date in the past means now');
});

test('scan: a 429 is retried once after Retry-After; still limited = not checked, never down', async () => {
  const challenge = (host, url) => ({ x402Version: 2, resource: { url: `http://${host}${url}`, mimeType: 'application/json', description: 'x' }, accepts: [{ scheme: 'exact', network: BASE, amount: '20000', asset: USDC_BASE, payTo: '0x6B0F4651eD42893ab58139938175E4a69f175F25', maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }] });
  let hits = 0;
  const busyOnce = await listen((req, res) => {
    if (req.url === '/openapi.json') return res.end('{}');
    if (hits++ === 0) {
      res.statusCode = 429;
      res.setHeader('Retry-After', '7');
      return res.end('slow down');
    }
    const c = challenge(req.headers.host, req.url);
    res.statusCode = 402;
    res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(c)).toString('base64'));
    res.end(JSON.stringify(c));
  });
  const alwaysBusy = await listen((req, res) => {
    if (req.url === '/openapi.json') return res.end('{}');
    res.statusCode = 429;
    res.end('slow down');
  });
  const waits = [];
  const results = await scan(
    [
      { key: 'once', url: `${busyOnce}/paid`, method: 'GET' },
      { key: 'always', url: `${alwaysBusy}/paid`, method: 'GET' },
    ],
    { safeFetch: createSafeFetch({ allowPrivate: true, timeoutMs: 2000 }), sleep: async (ms) => waits.push(ms) }
  );
  const by = Object.fromEntries(results.map((r) => [r.key, r]));
  assert.equal(by.once.verdict, 'go', 'the retry got the 402');
  assert.equal(by.always.verdict, 'rate_limited');
  assert.deepEqual(by.always.codes, ['rate_limited']);
  assert.ok(waits.some((ms) => ms >= 7000 && ms < 8000), 'waited Retry-After plus jitter');
  const index = mergeIndex(null, results, { date: '2026-09-25' });
  assert.equal(index.resources.always.h, '-', 'rate limited is not scored');
  assert.equal(index.resources.once.h, 'g');
});

test('politeFetch: Retry-After waiting per host is capped, then limited URLs are recorded without waiting', async () => {
  const origin = await listen((_req, res) => {
    res.statusCode = 429;
    res.setHeader('Retry-After', '50');
    res.end('slow down');
  });
  const waits = [];
  const f = politeFetch(createSafeFetch({ allowPrivate: true }), { perHost: 1, jitterMs: 0, sleep: async (ms) => waits.push(ms) });
  for (let i = 0; i < 5; i++) await f(`${origin}/x/${i}`);
  assert.deepEqual(waits, [50000, 50000], 'two waits fit the 120 s budget, the rest are not retried');
  assert.equal(f.rateLimited.size, 5);
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

test('trust summary: failure reasons of the latest scan and one row per day', async () => {
  const r = (key, verdict, codes = []) => ({ key: `https://${key}.example/p`, url: `https://${key}.example/p`, method: 'GET', verdict, codes, price_usd: 0.01, networks: [BASE], ms: 5 });
  let index = mergeIndex(null, [r('a', 'go'), r('b', 'no_go', ['no_402'])], { date: '2026-09-23' });
  index = mergeIndex(index, [r('a', 'caution', ['suspicious_amount']), r('b', 'no_go', ['no_402', 'testnet_only']), r('c', 'no_go', ['no_402'])], { date: '2026-09-24' });
  const trust = createTrustIndex({ url: 'https://raw.test/index.json', fetchImpl: async () => ({ ok: true, json: async () => index }) });
  await trust.lookup('https://a.example/p', { waitMs: 1000 });
  const s = trust.summary();
  assert.deepEqual(s.latest, { go: 0, caution: 1, no_go: 2, unreachable: 0 });
  assert.deepEqual(s.reasons, [{ code: 'no_402', count: 2 }, { code: 'suspicious_amount', count: 1 }, { code: 'testnet_only', count: 1 }]);
  assert.deepEqual(s.daily, [
    { date: '2026-09-23', go: 1, caution: 0, no_go: 1, unreachable: 0 },
    { date: '2026-09-24', go: 0, caution: 1, no_go: 2, unreachable: 0 },
  ]);
});

test('MPP in the Trust Index: the directory becomes scan entries; challenges get go / caution / no_go; the summary splits x402 and MPP', async () => {
  const { loadMppCatalog } = require('../lib/trust-scan');
  const directory = { version: 1, services: [
    { id: 'a', serviceUrl: 'https://api.a.example', status: 'active', endpoints: [{ method: 'GET', path: '/price' }, { method: 'POST', path: '/v1/run' }, { method: 'GET', path: '/items/{id}' }, { method: 'GET', path: '/price' }] },
    { id: 'b', url: 'https://b.example', status: 'deprecated', endpoints: [{ method: 'GET', path: '/x' }] },
    // A service URL with a path of its own: the endpoint path goes after it.
    { id: 'd', serviceUrl: 'https://mpp.d.example/jobs/', status: 'active', endpoints: [{ method: 'GET', path: '/v1/feed', payment: { intent: 'charge', amount: '1000' } }] },
    // Free routes (payment null, amount "0") never answer 402: left out. A priced or dynamic one stays.
    { id: 'c', serviceUrl: 'https://c.example', status: 'active', endpoints: [
      { method: 'GET', path: '/v0/inboxes', payment: null },
      { method: 'POST', path: '/sign-up', payment: { intent: 'charge', amount: '0' } },
      { method: 'POST', path: '/v0/inboxes', payment: { intent: 'charge', amount: '2000000' } },
      { method: 'POST', path: '/top-up', payment: { intent: 'charge', dynamic: true } },
    ] },
  ] };
  const list = await loadMppCatalog({ fetchImpl: async () => Response.json(directory) });
  assert.deepEqual(list.map((r) => [r.url, r.method, r.p]), [['https://api.a.example/price', 'GET', 'mpp'], ['https://api.a.example/v1/run', 'POST', 'mpp'], ['https://mpp.d.example/jobs/v1/feed', 'GET', 'mpp'], ['https://c.example/v0/inboxes', 'POST', 'mpp'], ['https://c.example/top-up', 'POST', 'mpp']]);

  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const soon = new Date(Date.now() + 300_000).toISOString();
  const usdc = { amount: '10000', currency: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', recipient: '0x1111111111111111111111111111111111111111', methodDetails: { chainId: 8453, decimals: 6 } };
  const after = [];
  const api = await new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const host = 'localhost';
      if (req.url === '/good') { res.statusCode = 402; res.setHeader('www-authenticate', `Payment id="1", realm="${host}", method="evm", intent="charge", request="${b64u(usdc)}", expires="${soon}"`); return res.end(); }
      if (req.url === '/meh') { res.statusCode = 402; res.setHeader('www-authenticate', `Payment id="1", realm="other.example", method="evm", intent="charge", request="${b64u(usdc)}"`); return res.end(); }
      if (req.url === '/strict') { res.statusCode = 400; return res.end('{"error":"symbol is required"}'); }
      if (req.url === '/old') { res.statusCode = 402; res.setHeader('www-authenticate', `Payment id="1", realm="${host}", method="evm", intent="charge", request="${b64u(usdc)}", expires="2020-01-01T00:00:00Z"`); return res.end(); }
      res.statusCode = 404; res.end();
    }).listen(0, () => resolve(`http://localhost:${server.address().port}`));
    after.push(() => server.close());
  });
  const safeFetch = createSafeFetch({ allowPrivate: true });
  const entries = ['good', 'meh', 'old', 'gone', 'strict'].map((p) => ({ key: `${api}/${p}`, url: `${api}/${p}`, method: 'GET', p: 'mpp' }));
  const results = await scan(entries, { safeFetch, rpcUrl: 'http://127.0.0.1:1' });
  const by = Object.fromEntries(results.map((r) => [r.url.split('/').pop(), r]));
  assert.equal(by.good.verdict, 'go');
  assert.equal(by.good.price_usd, 0.01);
  assert.deepEqual(by.good.networks, ['mpp:evm:8453']);
  assert.equal(by.good.p, 'mpp');
  assert.equal(by.meh.verdict, 'caution');
  assert.deepEqual(by.meh.codes.sort(), ['mpp_no_expires', 'mpp_realm_mismatch']);
  assert.equal(by.old.verdict, 'no_go');
  assert.deepEqual(by.old.codes, ['mpp_expired']);
  assert.equal(by.gone.verdict, 'no_go');
  assert.deepEqual(by.gone.codes, ['no_402']);
  assert.equal(by.strict.verdict, 'needs_input'); // checks input before the 402: not judged

  const index = mergeIndex(null, [...results, { key: 'https://x.example/a', url: 'https://x.example/a', method: 'GET', verdict: 'go', codes: [], price_usd: 0.01, networks: [], ms: 1 }], { date: '2026-10-04' });
  assert.equal(index.resources[`${api}/good`].p, 'mpp');
  assert.equal(index.resources['https://x.example/a'].p, undefined);
  const trust = createTrustIndex({ fetchImpl: async () => Response.json(index) });
  await trust.refresh();
  const s = trust.summary();
  assert.deepEqual(s.by_protocol.mpp, { resources: 4, go: 1, caution: 1, no_go: 2, unreachable: 0 });
  assert.deepEqual(s.by_protocol.x402, { resources: 1, go: 1, caution: 0, no_go: 0, unreachable: 0 });
  assert.equal((await trust.lookup(`${api}/good`)).protocol, 'mpp');
  for (const f of after) f();
});

test('GoPlausible catalog: resourceUrl and method, https only, one per origin + path, pages until the total', async () => {
  const { loadGoPlausibleCatalog } = require('../lib/trust-scan');
  const page = (offset) => offset === 0
    ? { items: [
      { resourceUrl: 'https://a.example/v1/signal?x=1', method: 'GET', description: 'Signal', accepts: [] },
      { resourceUrl: 'https://a.example/v1/signal?x=2', method: 'GET', description: 'dup', accepts: [] },
      { resourceUrl: 'http://b.example/pay', method: 'POST', description: 'plain http', accepts: [] },
      ...Array.from({ length: 497 }, (_, i) => ({ resourceUrl: `https://c.example/r/${i}`, discoveryInfo: { input: { method: 'POST' } } })),
    ], pagination: { limit: 500, offset: 0, total: 501 } }
    : { items: [{ resourceUrl: 'https://d.example/last', method: 'DELETE' }], pagination: { limit: 500, offset: 500, total: 501 } };
  const urls = [];
  const list = await loadGoPlausibleCatalog({ fetchImpl: async (u) => { urls.push(u); return Response.json(page(Number(new URL(u).searchParams.get('offset')))); } });
  assert.equal(urls.length, 2);
  assert.equal(list.length, 1 + 497 + 1);
  assert.equal(list[0].method, 'GET');
  assert.equal(list.find((r) => r.url === 'https://c.example/r/0').method, 'POST');
  assert.equal(list.find((r) => r.url === 'https://d.example/last').method, undefined);
  assert.ok(!list.some((r) => r.url.startsWith('http://')));
});
