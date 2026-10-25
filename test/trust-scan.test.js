// x402 Trust Index: catalog loading, polite fetching, the scan itself against
// local sellers, and the rolling 30-day history. No network.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createSafeFetch } = require('../lib/safe-fetch');
const { loadCatalog, politeFetch, retryAfterMs, scan, statusReport, mergeIndex, trackRecord, summarize, interleave, USER_AGENT } = require('../lib/trust-scan');
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

test('loadCatalog: a 502, a 429 or a dropped connection on one page is tried again; a 404 or retries run out fail', async () => {
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  const answers = [() => ({ ok: false, status: 502 }), () => { throw new Error('socket hang up'); }, () => ({ ok: false, status: 429 }), () => ({ ok: true, json: async () => ({ items: [{ resource: 'https://ok.example/api' }] }) })];
  let calls = 0;
  const list = await loadCatalog({ url: 'https://cdp.test/r', fetchImpl: async () => answers[calls++](), sleep, retryDelays: [1, 2, 3] });
  assert.deepEqual([list.length, calls, waits], [1, 4, [1, 2, 3]]);

  await assert.rejects(loadCatalog({ url: 'https://cdp.test/r', fetchImpl: async () => ({ ok: false, status: 502 }), sleep, retryDelays: [1, 1] }), /CDP discovery HTTP 502/);
  let notFound = 0;
  await assert.rejects(loadCatalog({ url: 'https://cdp.test/r', fetchImpl: async () => { notFound++; return { ok: false, status: 404 }; }, sleep, retryDelays: [1] }), /HTTP 404/);
  assert.equal(notFound, 1, 'a 404 is not retried');
});

test('loadCatalog: a listed path template is probed with the example value from its listing, or marked when there is none', async () => {
  const bazaar = (pathParams) => ({ bazaar: { info: { input: { method: 'GET', pathParams } } } });
  const items = [
    { resource: 'https://w.example/wallet/:address', extensions: bazaar({ address: '0x171d8021b98c53DCbB3c9C30CBbBeb1b01850fCA' }) },
    { resource: 'https://w.example/token/{id}/price', extensions: bazaar({ id: 'eth usd' }) },
    { resource: 'https://w.example/profile/:solana_address', extensions: bazaar({ address: 'So1ana' }) },
    { resource: 'https://w.example/plain' },
  ];
  const list = await loadCatalog({ url: 'https://cdp.test/r', fetchImpl: async () => ({ ok: true, json: async () => ({ items }) }) });
  const by = Object.fromEntries(list.map((r) => [r.url, r]));
  assert.equal(by['https://w.example/wallet/:address'].probe, 'https://w.example/wallet/0x171d8021b98c53DCbB3c9C30CBbBeb1b01850fCA');
  assert.equal(by['https://w.example/token/{id}/price'].probe, 'https://w.example/token/eth%20usd/price');
  assert.equal(by['https://w.example/profile/:solana_address'].template, true, 'the example names another parameter');
  assert.equal(by['https://w.example/profile/:solana_address'].probe, undefined);
  assert.deepEqual([by['https://w.example/plain'].probe, by['https://w.example/plain'].template], [undefined, undefined]);
});

test('scan: a template is probed at its example URL and recorded under its listing; one without an example is needs_input, not broken', async () => {
  const seen = [];
  const seller = await listen((req, res) => {
    seen.push(req.url);
    if (req.url === '/openapi.json') return res.end('{}');
    if (!req.url.startsWith('/wallet/0x')) { res.statusCode = 404; return res.end('{"error":"not found"}'); }
    const challenge = { x402Version: 2, resource: { url: `http://${req.headers.host}${req.url}`, mimeType: 'application/json', description: 'x' }, accepts: [{ scheme: 'exact', network: BASE, amount: '5000', asset: USDC_BASE, payTo: '0x6B0F4651eD42893ab58139938175E4a69f175F25', maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }] };
    res.statusCode = 402;
    res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(challenge)).toString('base64'));
    res.end(JSON.stringify(challenge));
  });
  const results = await scan(
    [
      { key: 'filled', url: `${seller}/wallet/:address`, probe: `${seller}/wallet/0xabc`, method: 'GET' },
      { key: 'literal', url: `${seller}/wallet/:address`, method: 'GET' },
      { key: 'no-example', url: `${seller}/profile/:solana_address`, template: true, method: 'GET' },
    ],
    { safeFetch: createSafeFetch({ allowPrivate: true, timeoutMs: 2000 }) }
  );
  const by = Object.fromEntries(results.map((r) => [r.key, r]));
  assert.equal(by.filled.verdict, 'go');
  assert.equal(by.filled.price_usd, 0.005);
  assert.equal(by.filled.url, `${seller}/wallet/:address`);
  assert.equal(by.filled.probe, `${seller}/wallet/0xabc`);
  assert.equal(by.literal.verdict, 'no_go', 'the placeholder itself is what the scan used to probe');
  assert.deepEqual([by['no-example'].verdict, by['no-example'].codes], ['needs_input', ['needs_input']]);
  assert.ok(!seen.some((u) => u.startsWith('/profile')), 'nothing is requested for a template without an example');
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
  assert.equal(by.down.verdict, 'error');
  assert.deepEqual(by.down.codes, ['unreachable']);
});

// From the nohumans.directory comparison (25 Oct 2026): sellers its paid calls reached that the scan called no_402.
test('scan: a GET that times out next to a POST 404/405 is unreachable, not no_402; a POST 200 next to it still is no_402', async () => {
  const challenge = (req) => ({ x402Version: 2, resource: { url: `http://${req.headers.host}${req.url}`, mimeType: 'application/json', description: 'x' }, accepts: [{ scheme: 'exact', network: BASE, amount: '10000', asset: USDC_BASE, payTo: '0x6B0F4651eD42893ab58139938175E4a69f175F25', maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }] });
  // A sleeping host (a free Render instance waking up): GET answers too late, POST at once with 405.
  const sleepy = await listen((req, res) => {
    if (req.url === '/openapi.json') return res.end('{}');
    if (req.method === 'POST') { res.statusCode = 405; return res.end('{"detail":"Method Not Allowed"}'); }
    setTimeout(() => { res.statusCode = 402; res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(challenge(req))).toString('base64')); res.end('{}'); }, 1500).unref();
  });
  const freeOnPost = await listen((req, res) => {
    if (req.url === '/openapi.json') return res.end('{}');
    if (req.method === 'POST') return res.end('{"ok":true}');
    setTimeout(() => res.end('{}'), 1500).unref();
  });
  const results = await scan([{ key: 'sleepy', url: `${sleepy}/gleif/lei` }, { key: 'free', url: `${freeOnPost}/x` }], { safeFetch: createSafeFetch({ allowPrivate: true, timeoutMs: 400 }) });
  const by = Object.fromEntries(results.map((r) => [r.key, r]));
  assert.equal(by.sleepy.verdict, 'error');
  assert.deepEqual(by.sleepy.codes, ['unreachable']);
  assert.equal(mergeIndex(null, results, { date: '2026-10-25' }).resources.sleepy.h, 'x');
  assert.equal(by.free.verdict, 'no_go', 'POST answered without payment: no_402 as before');
  assert.deepEqual(by.free.codes, ['no_402']);
});

test('scan: a free trial (x-free-trial) is asked again for the 402 behind it; one that stays free is not judged, the last verdict stays', async () => {
  const challenge = (req) => ({ x402Version: 2, resource: { url: `http://${req.headers.host}${req.url}`, mimeType: 'application/json', description: 'x' }, accepts: [{ scheme: 'exact', network: BASE, amount: '1000', asset: USDC_BASE, payTo: '0x6B0F4651eD42893ab58139938175E4a69f175F25', maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }] });
  const calls = { trial: 0, always: 0 };
  const trial = await listen((req, res) => {
    if (req.url === '/openapi.json') return res.end('{}');
    if (req.method === 'POST') { res.statusCode = 404; return res.end('Cannot POST'); }
    // Two free answers, then the 402 (as agents.ai-rook.com does, on and off).
    if (++calls.trial <= 2) { res.setHeader('x-free-trial', 'true'); res.setHeader('x-trial-remaining', '0'); return res.end('{"gwei":"0.01"}'); }
    res.statusCode = 402;
    res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(challenge(req))).toString('base64'));
    res.end('{}');
  });
  const always = await listen((req, res) => {
    if (req.url === '/openapi.json') return res.end('{}');
    if (req.method === 'POST') { res.statusCode = 404; return res.end('Cannot POST'); }
    calls.always++;
    res.setHeader('x-free-trial', 'true');
    res.end('{"ok":true}');
  });
  const results = await scan([{ key: 'trial', url: `${trial}/api/gas-tracker` }, { key: 'always', url: `${always}/api/ip-lookup` }], { safeFetch: createSafeFetch({ allowPrivate: true, timeoutMs: 2000 }) });
  const by = Object.fromEntries(results.map((r) => [r.key, r]));
  assert.equal(by.trial.verdict, 'go');
  assert.equal(by.trial.price_usd, 0.001);
  assert.equal(by.always.verdict, 'not_checked');
  assert.deepEqual(by.always.codes, ['free_trial']);
  assert.equal(calls.always, 4, 'the first GET and three more, then no further');
  const previous = mergeIndex(null, [{ key: 'always', url: `${always}/api/ip-lookup`, method: 'GET', verdict: 'go', codes: [], price_usd: 0.001, networks: [BASE], ms: 5 }], { date: '2026-10-24' });
  const merged = mergeIndex(previous, results, { date: '2026-10-25' }).resources.always;
  assert.equal(merged.h, 'g-');
  assert.equal(merged.last.verdict, 'go', 'the last real verdict stays for lookups');
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

const postChallenge = (host, url) => ({ x402Version: 2, resource: { url: `http://${host}${url}`, mimeType: 'application/json', description: 'x' }, accepts: [{ scheme: 'exact', network: BASE, amount: '10000', asset: USDC_BASE, payTo: '0x6B0F4651eD42893ab58139938175E4a69f175F25', maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }] });

test('scan: a bot challenge (Cloudflare cf-mitigated) is not checked today, never down; a plain 403 still is no_go', async () => {
  let hits = 0;
  const challenged = await listen((req, res) => {
    if (req.url === '/openapi.json') return res.end('{}');
    hits++;
    res.statusCode = 403;
    res.setHeader('cf-mitigated', 'challenge');
    res.end('<html>Just a moment...</html>');
  });
  const closed = await listen((req, res) => {
    if (req.url === '/openapi.json') return res.end('{}');
    res.statusCode = 403;
    res.end('forbidden');
  });
  let report = null;
  const results = await scan(
    [{ key: 'cf', url: `${challenged}/paid` }, { key: 'closed', url: `${closed}/paid` }],
    { safeFetch: createSafeFetch({ allowPrivate: true, timeoutMs: 2000 }), sleep: async () => {}, onStatuses: (rows) => { report = rows; } }
  );
  const by = Object.fromEntries(results.map((r) => [r.key, r]));
  assert.equal(by.cf.verdict, 'rate_limited');
  assert.equal(hits, 2, 'GET and POST once each: a challenge is not retried');
  assert.equal(mergeIndex(null, results, { date: '2026-10-14' }).resources.cf.h, '-');
  assert.equal(by.closed.verdict, 'no_go');
  assert.deepEqual(by.closed.codes, ['no_402']);
  const cfHost = new URL(challenged).host;
  assert.deepEqual(report.find((r) => r.host === cfHost).statuses, { '403 challenge': 2 });
  assert.equal(report.find((r) => r.host === new URL(closed).host).statuses['403'], 2);
});

test('scan: once a host turns out to ask for payment on POST only, its other undeclared routes are tried with POST first', async () => {
  const seen = [];
  const postOnly = await listen((req, res) => {
    if (req.url === '/openapi.json') return res.end('{}');
    seen.push(req.method);
    if (req.method !== 'POST') { res.statusCode = 405; return res.end('use POST'); }
    const c = postChallenge(req.headers.host, req.url);
    res.statusCode = 402;
    res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(c)).toString('base64'));
    res.end('{}');
  });
  const resources = [1, 2, 3, 4].map((i) => ({ key: `r${i}`, url: `${postOnly}/x/${i}` }));
  const results = await scan(resources, { safeFetch: createSafeFetch({ allowPrivate: true, timeoutMs: 2000 }), concurrency: 1 });
  assert.deepEqual(results.map((r) => r.verdict), ['go', 'go', 'go', 'go']);
  assert.deepEqual(seen, ['GET', 'POST', 'POST', 'POST', 'POST'], 'one GET to learn, then POST only');
  const f = politeFetch(createSafeFetch({ allowPrivate: true }), {});
  await f(`${postOnly}/x/9`);
  assert.deepEqual(statusReport(f), [{ host: new URL(postOnly).host, total: 1, statuses: { 405: 1 } }]);
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

test('trust index summary: one seller with a large share of the latest scan is counted apart, never named', async () => {
  const entry = (url, h, verdict) => [url, { url, m: 'GET', h, last: { verdict, codes: verdict === 'go' ? [] : ['server_error'], price_usd: 0.01, networks: [BASE] } }];
  const resources = Object.fromEntries([
    ...Array.from({ length: 1200 }, (_, i) => entry(`https://farm.example/e${i}`, 'gn', 'no_go')),
    ...Array.from({ length: 1000 }, (_, i) => entry(`https://seller${i}.example/x`, 'gg', 'go')),
  ]);
  const index = { version: 1, updated: '2026-10-18T08:00:00Z', days: ['2026-10-17', '2026-10-18'], resources };
  const trust = createTrustIndex({ url: 'https://raw.test/index.json', fetchImpl: async () => ({ ok: true, json: async () => index }) });
  await trust.refresh();
  const s = trust.summary();
  assert.deepEqual(s.latest, { go: 1000, caution: 0, no_go: 1200, unreachable: 0 }, 'the totals themselves are unchanged');
  assert.deepEqual(s.largest_host, { endpoints: 1200, share_pct: 54.5, down: true, latest_without: { go: 1000, caution: 0, no_go: 0, unreachable: 0 } });
  assert.doesNotMatch(JSON.stringify(s.largest_host), /farm/);
  // Small farms (under 1,000 endpoints) or small shares (under 20%) change nothing.
  const small = createTrustIndex({ url: 'https://raw.test/index.json', fetchImpl: async () => ({ ok: true, json: async () => ({ ...index, resources: Object.fromEntries(Object.entries(resources).slice(600)) }) }) });
  await small.refresh();
  assert.equal(small.summary().largest_host, undefined);
});

test('trust index lookup: a concrete URL finds the record of its listed path template, and says so', async () => {
  const index = mergeIndex(null, [
    { key: 'https://w.example/wallet/:address', url: 'https://w.example/wallet/:address', probe: 'https://w.example/wallet/0xabc', method: 'GET', verdict: 'go', codes: [], price_usd: 0.005, networks: [BASE], ms: 5 },
    { key: 'https://w.example/token/%7Bid%7D', url: 'https://w.example/token/{id}', method: 'GET', verdict: 'go', codes: [], price_usd: 0.01, networks: [BASE], ms: 5 },
    { key: 'https://w.example/wallet/stats', url: 'https://w.example/wallet/stats', method: 'GET', verdict: 'no_go', codes: ['no_402'], price_usd: null, networks: [], ms: 5 },
  ], { date: '2026-10-14' });
  assert.equal(index.resources['https://w.example/wallet/:address'].probe, 'https://w.example/wallet/0xabc', 'the index keeps what was probed');
  const trust = createTrustIndex({ url: 'https://raw.test/index.json', fetchImpl: async () => ({ ok: true, json: async () => index }) });
  const rec = await trust.lookup('https://w.example/wallet/0x0000000000000000000000000000000000000001', { waitMs: 1000 });
  assert.equal(rec.last_scan.price_usd, 0.005);
  assert.equal(rec.listed_as, 'https://w.example/wallet/:address');
  assert.equal((await trust.lookup('https://w.example/token/42')).listed_as, 'https://w.example/token/{id}');
  const exact = await trust.lookup('https://w.example/wallet/stats');
  assert.equal(exact.last, 'n', 'an exact listing wins over a template');
  assert.equal(exact.listed_as, undefined);
  assert.equal(await trust.lookup('https://w.example/wallet/0xabc/extra'), null, 'one segment per parameter');
  assert.equal(await trust.lookup('https://other.example/wallet/0xabc'), null);
});

test('trust index refresh: unchanged index (304) is not downloaded again, a changed one replaces the old before parsing', async () => {
  const index = mergeIndex(null, [{ key: 'https://s.example/p', url: 'https://s.example/p', method: 'GET', verdict: 'go', codes: [], price_usd: 0.01, networks: [BASE], ms: 5 }], { date: '2026-09-23' });
  const seen = [];
  let reply = 'full';
  let release;
  const trust = createTrustIndex({
    url: 'https://raw.test/index.json',
    categoriesUrl: 'https://raw.test/categories.json',
    submittedUrl: 'https://raw.test/submitted.json',
    fetchImpl: async (u, opts = {}) => {
      if (u.endsWith('categories.json') || u.endsWith('submitted.json')) return { ok: false, status: 404 };
      seen.push(opts.headers?.['if-none-match'] ?? null);
      if (reply === '304') return { ok: false, status: 304 };
      if (reply === 'slow') return { ok: true, status: 200, headers: new Headers({ etag: '"v2"' }), json: () => new Promise((r) => { release = () => r(index); }) };
      return { ok: true, status: 200, headers: new Headers({ etag: '"v1"' }), json: async () => index };
    },
  });
  await trust.refresh();
  assert.equal(trust.summary().latest.go, 1);
  reply = '304';
  await trust.refresh();
  assert.deepEqual(seen, [null, '"v1"'], 'the second refresh asks with the ETag');
  assert.equal(trust.summary().latest.go, 1, 'a 304 keeps the loaded index');
  reply = 'slow';
  const pending = trust.refresh();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(trust.summary(), null, 'the old index is released before the new one is parsed');
  release();
  await pending;
  assert.equal(trust.summary().latest.go, 1);
  reply = '304';
  await trust.refresh();
  assert.equal(seen.at(-1), '"v2"', 'the new ETag is used next time');
});

test('trust summary: which sanctions list the latest scan screened against', async () => {
  const index = mergeIndex(null, [{ key: 'https://s.example/p', url: 'https://s.example/p', method: 'GET', verdict: 'go', codes: [], price_usd: 0.01, networks: [BASE], ms: 5 }], { date: '2026-10-13' });
  assert.equal(summarize(index).sanctions, null, 'not screened');
  index.sanctions = { list: 'OFAC SDN', published: '2026-10-09', addresses: 1050 };
  assert.deepEqual(summarize(index).sanctions, { list: 'OFAC SDN', published: '2026-10-09', addresses: 1050 });
  assert.equal(summarize(index).payto_sanctioned, 0);
  const trust = createTrustIndex({ url: 'https://raw.test/index.json', fetchImpl: async () => ({ ok: true, json: async () => index }) });
  await trust.refresh();
  assert.equal(trust.summary().sanctions.addresses, 1050);
  assert.equal(trust.summary().payto_sanctioned, 0);
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
      if (req.url === '/burn') { res.statusCode = 402; res.setHeader('www-authenticate', `Payment id="1", realm="${host}", method="evm", intent="charge", request="${b64u({ ...usdc, recipient: '0x0000000000000000000000000000000000000000' })}", expires="${soon}"`); return res.end(); }
      if (req.url === '/old') { res.statusCode = 402; res.setHeader('www-authenticate', `Payment id="1", realm="${host}", method="evm", intent="charge", request="${b64u(usdc)}", expires="2020-01-01T00:00:00Z"`); return res.end(); }
      res.statusCode = 404; res.end();
    }).listen(0, () => resolve(`http://localhost:${server.address().port}`));
    after.push(() => server.close());
  });
  const safeFetch = createSafeFetch({ allowPrivate: true });
  const entries = ['good', 'meh', 'old', 'gone', 'strict', 'burn'].map((p) => ({ key: `${api}/${p}`, url: `${api}/${p}`, method: 'GET', p: 'mpp' }));
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
  assert.equal(by.burn.verdict, 'no_go');
  assert.deepEqual(by.burn.codes, ['payto_burn']);
  assert.equal(by.gone.verdict, 'no_go');
  assert.deepEqual(by.gone.codes, ['no_402']);
  assert.equal(by.strict.verdict, 'needs_input'); // checks input before the 402: not judged

  const index = mergeIndex(null, [...results, { key: 'https://x.example/a', url: 'https://x.example/a', method: 'GET', verdict: 'go', codes: [], price_usd: 0.01, networks: [], ms: 1 }], { date: '2026-10-04' });
  assert.equal(index.resources[`${api}/good`].p, 'mpp');
  assert.equal(index.resources['https://x.example/a'].p, undefined);
  const trust = createTrustIndex({ fetchImpl: async () => Response.json(index) });
  await trust.refresh();
  const s = trust.summary();
  assert.deepEqual(s.by_protocol.mpp, { resources: 5, go: 1, caution: 1, no_go: 3, unreachable: 0 });
  assert.equal(s.payto_burn, 1);
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

test('nohumans.directory catalogue: endpoint_url, https only, one per origin + path, no /mcp, templates marked, pages until next_offset is null', async () => {
  const { loadNohumansCatalog } = require('../lib/trust-scan');
  const page = (offset) => offset === 0
    ? { total: 203, count: 200, limit: 200, offset: 0, next_offset: 200, results: [
      { endpoint_url: 'https://a.example/v1/fees?x=1', description: 'Fees', status: 'verified' },
      { endpoint_url: 'https://a.example/v1/fees?x=2', description: 'dup', status: 'verified' },
      { endpoint_url: 'http://b.example/pay', description: 'plain http', status: 'verified' },
      { endpoint_url: 'https://c.example/mcp', description: 'an MCP server, listed free', status: 'verified' },
      { endpoint_url: 'https://d.example/v1/outcome/:mint', description: 'template', status: 'verified' },
      ...Array.from({ length: 195 }, (_, i) => ({ endpoint_url: `https://e.example/r/${i}`, status: 'failing' })),
    ] }
    : { total: 203, count: 3, limit: 200, offset: 200, next_offset: null, results: [{ endpoint_url: 'https://f.example/last' }, { endpoint_url: 'not a url' }, {}] };
  const urls = [];
  const list = await loadNohumansCatalog({ sleep: async () => {}, fetchImpl: async (u, opts) => { urls.push([u, opts.headers['user-agent']]); return Response.json(page(Number(new URL(u).searchParams.get('offset')))); } });
  assert.deepEqual(urls.map(([u]) => new URL(u).search), ['?limit=200&offset=0', '?limit=200&offset=200']);
  assert.ok(urls.every(([, ua]) => ua === USER_AGENT));
  assert.equal(list.length, 1 + 1 + 195 + 1);
  assert.equal(list[0].description, 'Fees');
  assert.equal(list[0].method, undefined, 'no method named: both are tried');
  assert.ok(!list.some((r) => r.url.startsWith('http://') || r.url.endsWith('/mcp')));
  assert.equal(list.find((r) => r.url.includes(':mint')).template, true);
  // A next_offset that doesn't move on ends the paging instead of looping.
  const stuck = await loadNohumansCatalog({ sleep: async () => {}, fetchImpl: async () => Response.json({ next_offset: 0, results: [{ endpoint_url: 'https://g.example/x' }] }) });
  assert.equal(stuck.length, 1);
  await assert.rejects(loadNohumansCatalog({ sleep: async () => {}, retryDelays: [], fetchImpl: async () => new Response('no', { status: 404 }) }), /nohumans.directory HTTP 404/);
});

test('interleave: one item per host in turn, each host keeping its own order', () => {
  const items = ['a1', 'a2', 'a3', 'b1', 'c1', 'c2'];
  assert.deepEqual(interleave(items, (x) => x[0]), ['a1', 'b1', 'c1', 'a2', 'c2', 'a3']);
  assert.deepEqual(interleave([], (x) => x), []);
});

test('scan: a seller that answers too slowly is cut short (not checked today), without holding up the others', async () => {
  const challengeFor = (req) => ({ x402Version: 2, resource: { url: `http://${req.headers.host}${req.url}`, mimeType: 'application/json', description: 'x' }, accepts: [{ scheme: 'exact', network: BASE, amount: '20000', asset: USDC_BASE, payTo: '0x6B0F4651eD42893ab58139938175E4a69f175F25', maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }] });
  const answer = (req, res) => {
    if (req.url === '/openapi.json') return res.end('{}');
    const challenge = challengeFor(req);
    res.statusCode = 402;
    res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(challenge)).toString('base64'));
    res.end(JSON.stringify(challenge));
  };
  let slowHits = 0;
  const slow = await listen((req, res) => { slowHits++; setTimeout(() => answer(req, res), 150); });
  const fast = await listen(answer);
  const resources = [
    ...Array.from({ length: 12 }, (_, i) => ({ key: `slow${i}`, url: `${slow}/paid/${i}`, method: 'GET' })),
    ...Array.from({ length: 4 }, (_, i) => ({ key: `fast${i}`, url: `${fast}/paid/${i}`, method: 'GET' })),
    ...Array.from({ length: 12 }, (_, i) => ({ key: `down${i}`, url: `http://127.0.0.1:1/paid/${i}`, method: 'GET' })),
  ];
  let reported = null;
  const results = await scan(resources, { safeFetch: createSafeFetch({ allowPrivate: true, timeoutMs: 2000 }), concurrency: 4, slowMs: 100, slowStreak: 3, onSlowHosts: (rows) => { reported = rows; } });
  const by = Object.fromEntries(results.map((r) => [r.key, r]));
  for (let i = 0; i < 4; i++) assert.equal(by[`fast${i}`].verdict, 'go');
  const skipped = results.filter((r) => r.key.startsWith('slow') && r.verdict === 'not_checked');
  assert.ok(skipped.length >= 6, `most of the slow seller is skipped (${skipped.length})`);
  assert.ok(skipped.every((r) => r.codes[0] === 'host_slow' && r.ms === 0));
  assert.ok(slowHits < 12 * 2, 'the slow seller is not asked for every endpoint');
  assert.deepEqual(reported.map((r) => r.host), [new URL(slow).host]);
  assert.equal(reported[0].skipped, skipped.length);
  assert.match(reported[0].why, /requests in a row took 0 s or more/);
  // A seller that refuses at once is down, not slow: every endpoint is checked (and comes out unreachable).
  assert.ok(results.filter((r) => r.key.startsWith('down')).every((r) => r.verdict === 'error' && r.codes[0] === 'unreachable'));

  // Not checked today: a '-' in the history, and the last real verdict stays for pages and lookups.
  const previous = { days: ['2026-10-16'], resources: { slow0: { url: `${slow}/paid/0`, m: 'GET', h: 'g', last: { verdict: 'go', codes: [], price_usd: 0.02, networks: [BASE] } } } };
  const cutKey = skipped[0].key;
  previous.resources[cutKey] = { ...previous.resources.slow0, url: skipped[0].url };
  const merged = mergeIndex(previous, results, { date: '2026-10-17' });
  assert.equal(merged.resources[cutKey].h, 'g-');
  assert.equal(merged.resources[cutKey].last.verdict, 'go');
});

test('index.ndjson: written line by line and read back the same, also from chunks that split lines and characters', async () => {
  const { indexLines } = require('../lib/trust-scan');
  const { readIndex } = require('../lib/trust-index');
  const index = {
    version: 1, updated: '2026-10-20T01:00:00Z', days: ['2026-10-19', '2026-10-20'], sanctions: null,
    resources: {
      'https://a.example/paid': { url: 'https://a.example/paid', m: 'GET', h: 'gg', last: { verdict: 'go', codes: [] }, d: 'Café prices €' },
      'https://b.example/run': { url: 'https://b.example/run?x=1', m: 'POST', h: '-n', last: { verdict: 'no_go', codes: ['no_402'] }, d: '' },
    },
  };
  const text = `${[...indexLines(index)].join('\n')}\n`;
  assert.equal(text.split('\n').filter(Boolean).length, 3, 'a header and one line per resource');
  const bytes = new TextEncoder().encode(text);
  const chunked = (size) => new Response(new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
      controller.close();
    },
  }));
  assert.deepEqual(await readIndex(new Response(text)), index);
  assert.deepEqual(await readIndex(chunked(7)), index, 'chunks of 7 bytes split lines and the two-byte é');
  assert.deepEqual(await readIndex(new Response(JSON.stringify(index))), index, 'a whole index.json on one line');
  assert.deepEqual(await readIndex({ json: async () => index }), index, 'no body stream: res.json()');
});

test('trust index: falls back to index.ndjson, then index.json, while the parts are not published', async () => {
  const { createTrustIndex } = require('../lib/trust-index');
  const index = { version: 1, updated: 'now', days: ['2026-10-20'], resources: { 'https://a.example/paid': { url: 'https://a.example/paid', m: 'GET', h: 'g', last: { verdict: 'go' } } } };
  const asked = [];
  const fetchImpl = async (u) => {
    asked.push(u.split('/').pop());
    if (u.endsWith('/index.json')) return new Response(JSON.stringify(index), { headers: { etag: '"j1"' } });
    return new Response('not found', { status: 404 });
  };
  const ti = createTrustIndex({ categoriesUrl: 'http://cat.test/categories.json', submittedUrl: 'http://sub.test/submitted.json', fetchImpl });
  await ti.refresh();
  assert.equal((await ti.lookup('https://a.example/paid')).days_payable, 1);
  assert.deepEqual(asked.slice(0, 3), ['meta.json', 'index.ndjson', 'index.json']);
  asked.length = 0;
  await ti.refresh();
  assert.equal(asked[0], 'index.json', 'within 6 hours: straight to index.json');
});
