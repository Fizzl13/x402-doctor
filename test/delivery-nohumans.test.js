// Delivery evidence from nohumans.directory: the plan collects the listings it bought and got an answer from
// (lib/trust-scan.js loadNohumansCatalog), lib/delivery-nohumans.js reads delivery-nohumans.json, and the pre-payment
// check shows it as information next to its own verdict. Local sellers and fake fetches, no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { loadNohumansCatalog } = require('../lib/trust-scan');
const { createNohumansDelivery } = require('../lib/delivery-nohumans');
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

const file = (endpoints) => ({ version: 1, source: 'https://nohumans.directory', license: 'CC BY 4.0', updated: '2026-10-26', endpoints });

test('createNohumansDelivery: finds an endpoint by origin + path, with the listing link; null otherwise', async () => {
  let calls = 0;
  const delivery = createNohumansDelivery({ url: 'https://x/delivery-nohumans.json', fetchImpl: async () => { calls++; return Response.json(file({ [keyOf('https://a.example/v1/fees')]: ['2026-10-10', 'verified', 'aaa-111'], [keyOf('https://bad.example/x')]: ['not a day', 'verified', 'z'] })); } });
  assert.deepEqual(await delivery.forUrl('https://a.example/v1/fees?ignored=1', { waitMs: 1000 }), { source: 'nohumans.directory', paid_on: '2026-10-10', status: 'verified', listing: 'https://nohumans.directory/l/aaa-111', license: 'CC BY 4.0' });
  assert.equal(await delivery.forUrl('https://bad.example/x'), null, 'an entry without a day is dropped');
  assert.equal(await delivery.forUrl('https://other.example/'), null);
  assert.equal(await delivery.forUrl('not a url'), null);
  assert.equal(calls, 1, 'loaded once, then kept');
  const broken = createNohumansDelivery({ url: 'https://x/d.json', fetchImpl: async () => new Response('no', { status: 404 }) });
  assert.equal(await broken.forUrl('https://a.example/v1/fees', { waitMs: 1000 }), null);
});

test('preflight: an endpoint nohumans.directory bought and got an answer from adds an info line and a signal; the verdict stays', async () => {
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
  const failing = { forUrl: async () => ({ source: 'nohumans.directory', paid_on: '2026-09-10', status: 'failing', listing: 'https://nohumans.directory/l/bbb-222', license: 'CC BY 4.0' }) };
  const seen = await preflight(url, { safeFetch, delivery: failing });
  assert.equal(seen.verdict, plain.verdict);
  const line = seen.reasons.find((r) => r.code === 'delivered_elsewhere');
  assert.equal(line.level, 'info');
  assert.match(line.message, /nohumans\.directory bought this endpoint with real USDC on 2026-09-10 and got its answer; it has failed that directory's checks since\./);
  assert.equal(seen.signals.delivered_elsewhere.listing, 'https://nohumans.directory/l/bbb-222');
  assert.ok(!plain.reasons.some((r) => r.code === 'delivered_elsewhere') && !plain.signals.delivered_elsewhere);
  const down = await preflight(url, { safeFetch, delivery: { forUrl: async () => { throw new Error('down'); } } });
  assert.equal(down.verdict, plain.verdict, 'a failing source changes nothing');
});
