// Refused outcomes reach the seller: GET /api/v1/refusals and the free web check's buyer-refusals line.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../server.js');
const { diagnose } = require('../lib/diagnose');
const { createSafeFetch } = require('../lib/safe-fetch');

test('GET /api/v1/refusals: counts per reason, zero when none, 400 without a URL', async (t) => {
  const app = createApp({ env: {}, trustIndex: { lookup: async () => null, refresh: () => Promise.resolve(), summary: () => null }, status: { snapshot: async () => ({}) } });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/v1/refusals`)).status, 400);
  const res = await fetch(`${base}/api/v1/refusals?url=${encodeURIComponent('https://api.example.com/paid')}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual({ url: body.url, refused: body.refused, reasons: body.reasons }, { url: 'https://api.example.com/paid', refused: 0, reasons: [] });
  assert.match(body.how, /"refused"/);
});

test('the web check names the refusals and their reasons (info)', async (t) => {
  const server = http.createServer((req, res) => {
    const challenge = { x402Version: 2, resource: { url: `http://127.0.0.1:${server.address().port}/paid`, mimeType: 'application/json', description: 'x' }, accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '10000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0x6B0F4651eD42893ab58139938175E4a69f175F25', maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }] };
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/paid')) { res.statusCode = 402; res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(challenge)).toString('base64')); return res.end(JSON.stringify(challenge)); }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/paid`;
  const refusals = (u) => (u === url ? { days: 30, refused: 3, wallets: 2, reasons: [{ reason: 'payto_changed', count: 2, wallets: 2 }, { reason: 'price_changed', count: 1, wallets: 1 }] } : null);
  const report = await diagnose(url, { safeFetch: createSafeFetch({ allowPrivate: true }), refusals });
  const line = report.checks.find((c) => c.id === 'buyer-refusals');
  assert.equal(line.status, 'info');
  assert.match(line.message, /refused to pay this endpoint 3 times after checking it \(2 wallets\): payto_changed \(2\), price_changed \(1\)/);
});
