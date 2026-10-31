// Delivery evidence from nohumans.directory and PayAPI Market: the plan collects the endpoints they bought and got an
// answer from (lib/trust-scan.js loadNohumansCatalog, loadPayApiCatalog), lib/delivery-elsewhere.js reads
// delivery-nohumans.json and delivery-payapi.json, and the pre-payment check shows it as information next to its own
// verdict. Local sellers and fake fetches, no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { loadNohumansCatalog, loadPayApiCatalog } = require('../lib/trust-scan');
const { createDeliveryElsewhere, openClawSource, SOURCES } = require('../lib/delivery-elsewhere');
const { createSafeFetch } = require('../lib/safe-fetch');
const { preflight } = require('../lib/preflight');
const { keyOf } = require('../lib/bazaar-index');

const servers = [];
function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    servers.push(server);
  });
}
test.after(() => servers.forEach((s) => s.close()));

test('loadNohumansCatalog: with evidence, the listings bought and delivered by key, as [day, status, id]', async () => {
  const results = [
    { id: 'aaa-111', endpoint_url: 'https://a.example/v1/fees', status: 'verified', paid_verified: true, paid_verified_at: 1791676800 },
    { id: 'bbb-222', endpoint_url: 'https://b.example/v1/feed', status: 'failing', paid_verified: true, paid_verified_at: 1789084800 },
    { id: 'ccc-333', endpoint_url: 'https://c.example/v1/x', status: 'verified', paid_verified: false, paid_verified_at: null },
    { id: 'ddd-444', endpoint_url: 'https://d.example/mcp', status: 'verified', paid_verified: true, paid_verified_at: 1791676800 },
  ];
  const evidence = new Map();
  const list = await loadNohumansCatalog({ evidence, sleep: async () => {}, fetchImpl: async () => Response.json({ next_offset: null, results }) });
  assert.equal(list.length, 3);
  assert.deepEqual(Object.fromEntries(evidence), {
    [keyOf('https://a.example/v1/fees')]: ['2026-10-11', 'verified', 'aaa-111'],
    [keyOf('https://b.example/v1/feed')]: ['2026-09-11', 'failing', 'bbb-222'],
  });
  // Without a Map nothing is collected, and the entries stay the same.
  assert.deepEqual(await loadNohumansCatalog({ sleep: async () => {}, fetchImpl: async () => Response.json({ next_offset: null, results }) }), list);
});

test('loadPayApiCatalog: with evidence, the routes it paid and got product from, as [day, verified, listing page]; the latest payment wins', async () => {
  const results = [
    { base_url: 'https://lint.example/lint/one', marketplace_url: 'https://payapi.market/api/lint', verified_routes: [{ route: '/lint/one', method: 'POST', verified_at: '2026-09-03T09:15:37+00:00', receipt_url: 'https://basescan.org/tx/0x1' }] },
    { base_url: 'https://two.example/a', marketplace_url: 'https://payapi.market/api/two', verified_routes: [{ route: '/lint/one', verified_at: 'not a day' }, { route: 'https://lint.example/lint/one', verified_at: '2026-10-01T00:00:00Z' }] },
    { base_url: 'https://never.example/x', marketplace_url: 'https://payapi.market/api/never', verified_routes: [] },
  ];
  const evidence = new Map();
  await loadPayApiCatalog({ evidence, sleep: async () => {}, fetchImpl: async () => Response.json({ results }) });
  assert.deepEqual(Object.fromEntries(evidence), { [keyOf('https://lint.example/lint/one')]: ['2026-10-01', 'verified', 'https://payapi.market/api/two'] });
});

const file = (endpoints) => ({ version: 1, updated: '2026-10-26', endpoints });
const sources = () => SOURCES.map((s) => ({ ...s, url: `https://x/${s.name}.json` }));

test('createDeliveryElsewhere: finds an endpoint by origin + path in each source, the latest purchase first, with listing links', async () => {
  let calls = 0;
  const files = {
    'nohumans.directory': file({ [keyOf('https://a.example/v1/fees')]: ['2026-10-10', 'verified', 'aaa-111'], [keyOf('https://bad.example/x')]: ['not a day', 'verified', 'z'] }),
    'PayAPI Market': file({ [keyOf('https://a.example/v1/fees')]: ['2026-10-20', 'verified', 'https://payapi.market/api/fees'], [keyOf('https://p.example/only')]: ['2026-09-01', 'verified', 'https://evil.example/x'] }),
  };
  const delivery = createDeliveryElsewhere({ sources: sources(), fetchImpl: async (u) => { calls++; return Response.json(files[decodeURIComponent(new URL(u).pathname.slice(1, -5))]); } });
  const both = await delivery.forUrl('https://a.example/v1/fees?ignored=1', { waitMs: 1000 });
  assert.deepEqual([both.source, both.paid_on, both.listing], ['PayAPI Market', '2026-10-20', 'https://payapi.market/api/fees']);
  assert.deepEqual(both.sources.map((h) => [h.source, h.paid_on, h.listing, h.license ?? null]), [
    ['PayAPI Market', '2026-10-20', 'https://payapi.market/api/fees', null],
    ['nohumans.directory', '2026-10-10', 'https://nohumans.directory/l/aaa-111', 'CC BY 4.0'],
  ]);
  assert.equal((await delivery.forUrl('https://p.example/only')).listing, null, 'a link off payapi.market is not passed on');
  assert.equal(await delivery.forUrl('https://bad.example/x'), null, 'an entry without a day is dropped');
  assert.equal(await delivery.forUrl('https://other.example/'), null);
  assert.equal(await delivery.forUrl('not a url'), null);
  assert.equal(calls, 2, 'each file loaded once, then kept');
  // One source down: the other still answers.
  const half = createDeliveryElsewhere({ sources: sources(), fetchImpl: async (u) => (u.includes('PayAPI') ? new Response('no', { status: 404 }) : Response.json(files['nohumans.directory'])) });
  assert.equal((await half.forUrl('https://a.example/v1/fees', { waitMs: 1000 })).source, 'nohumans.directory');
});

test('preflight: an endpoint others bought and got an answer from adds an info line naming every source, and a signal; the verdict stays', async () => {
  const origin = await listen((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/openapi.json') { res.statusCode = 404; return res.end('{}'); }
    const challenge = { x402Version: 2, resource: { url: `http://${req.headers.host}${req.url}`, mimeType: 'application/json', description: 'x' }, accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '10000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0x6B0F4651eD42893ab58139938175E4a69f175F25', maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }] };
    res.statusCode = 402;
    res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(challenge)).toString('base64'));
    res.end(JSON.stringify(challenge));
  });
  const url = `${origin}/paid`;
  const safeFetch = createSafeFetch({ allowPrivate: true });
  const plain = await preflight(url, { safeFetch });
  const nohumans = { source: 'nohumans.directory', paid_on: '2026-09-10', status: 'failing', listing: 'https://nohumans.directory/l/bbb-222', license: 'CC BY 4.0' };
  const payapi = { source: 'PayAPI Market', paid_on: '2026-10-20', status: 'verified', listing: 'https://payapi.market/api/x' };
  const failing = { forUrl: async () => ({ ...payapi, sources: [payapi, nohumans] }) };
  const seen = await preflight(url, { safeFetch, delivery: failing });
  assert.equal(seen.verdict, plain.verdict);
  const line = seen.reasons.find((r) => r.code === 'delivered_elsewhere');
  assert.equal(line.level, 'info');
  assert.equal(line.message, "Bought with real USDC, and the answer came: PayAPI Market on 2026-10-20, nohumans.directory on 2026-09-10 (failing that directory's checks since).");
  assert.equal(seen.signals.delivered_elsewhere.listing, 'https://payapi.market/api/x');
  assert.equal(seen.signals.delivered_elsewhere.sources.length, 2);
  assert.ok(!plain.reasons.some((r) => r.code === 'delivered_elsewhere') && !plain.signals.delivered_elsewhere);
  const down = await preflight(url, { safeFetch, delivery: { forUrl: async () => { throw new Error('down'); } } });
  assert.equal(down.verdict, plain.verdict, 'a failing source changes nothing');
});

test('OpenClaw grades: the latest graded purchase per endpoint, delivered or failed, with its reason and report link', async () => {
  const feed = { grades: [
    { url: 'https://a.example/v1/x?q=1', date: '2026-10-20', delivered: true, report: 'https://openclaw.example/r/1' },
    { url: 'https://a.example/v1/x', date: '2026-10-31T12:00:00Z', delivered: false, reason: 'paid, but GET\n returned only a usage note', report: 'javascript:alert(1)' },
    { url: 'https://b.example/v1/y', date: '2026-10-29', delivered: true },
    { url: 'https://b.example/v1/y', date: '2026-10-01', delivered: false, reason: 'older' },
    { url: 'not a url', date: '2026-10-29', delivered: true },
    { url: 'https://c.example/z', date: 'yesterday', delivered: false },
    { url: 'https://d.example/z', date: '2026-10-29', delivered: 'yes' },
  ] };
  const delivery = createDeliveryElsewhere({ sources: [openClawSource('https://openclaw.example/grades.json')], fetchImpl: async () => Response.json(feed) });
  const a = await delivery.forUrl('https://a.example/v1/x', { waitMs: 1000 });
  assert.deepEqual([a.source, a.paid_on, a.status, a.reason, a.listing], ['OpenClaw', '2026-10-31', 'failed', 'paid, but GET returned only a usage note', null]);
  const b = await delivery.forUrl('https://b.example/v1/y');
  assert.deepEqual([b.status, b.paid_on, b.reason ?? null], ['delivered', '2026-10-29', null]);
  assert.equal(await delivery.forUrl('https://c.example/z'), null);
  assert.equal(await delivery.forUrl('https://d.example/z'), null);
  assert.ok(!SOURCES.some((x) => x.name === 'OpenClaw'), 'off without OPENCLAW_GRADES_URL');
});

test('preflight: a grader paid and got no usable answer is an info line next to the verdict; one that got an answer stays under delivered', async () => {
  const origin = await listen((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/openapi.json') { res.statusCode = 404; return res.end('{}'); }
    const challenge = { x402Version: 2, resource: { url: `http://${req.headers.host}${req.url}`, mimeType: 'application/json', description: 'x' }, accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '10000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0x6B0F4651eD42893ab58139938175E4a69f175F25', maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }] };
    res.statusCode = 402;
    res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(challenge)).toString('base64'));
    res.end(JSON.stringify(challenge));
  });
  const url = `${origin}/paid`;
  const safeFetch = createSafeFetch({ allowPrivate: true });
  const failed = { source: 'OpenClaw', paid_on: '2026-10-31', status: 'failed', reason: 'GET returned only a usage note', listing: null };
  const payapi = { source: 'PayAPI Market', paid_on: '2026-10-20', status: 'verified', listing: 'https://payapi.market/api/x' };
  const seen = await preflight(url, { safeFetch, delivery: { forUrl: async () => ({ ...failed, sources: [failed, payapi] }) } });
  assert.equal(seen.verdict, 'go');
  assert.equal(seen.reasons.find((r) => r.code === 'failed_elsewhere').message, 'Bought with real USDC, and no usable answer came: OpenClaw on 2026-10-31 (GET returned only a usage note).');
  assert.equal(seen.reasons.find((r) => r.code === 'delivered_elsewhere').message, 'Bought with real USDC, and the answer came: PayAPI Market on 2026-10-20.');
  const onlyFailed = await preflight(url, { safeFetch, delivery: { forUrl: async () => ({ ...failed, sources: [failed] }) } });
  assert.ok(!onlyFailed.reasons.some((r) => r.code === 'delivered_elsewhere'));
});
