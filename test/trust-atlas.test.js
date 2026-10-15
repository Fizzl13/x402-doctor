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

test('GET /api/trust/atlas: gzipped when asked, plain otherwise, open to any origin, 503 while loading', async (t) => {
  const app = createApp({ env: {}, status: { snapshot: async () => ({}) }, trustIndex: createTrustIndex({ url: 'http://index.test', categoriesUrl: 'http://cat.test', fetchImpl }) });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/trust/atlas`;
  let res = await fetch(url);
  if (res.status === 503) { await new Promise((r) => setTimeout(r, 200)); res = await fetch(url); }
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal((await res.json()).sellers.length, 2);
  const http = require('node:http');
  const raw = await new Promise((resolve, reject) => {
    http.get(url, { headers: { 'accept-encoding': 'gzip' } }, (r) => { const parts = []; r.on('data', (c) => parts.push(c)); r.on('end', () => resolve({ enc: r.headers['content-encoding'], body: Buffer.concat(parts) })); }).on('error', reject);
  });
  assert.equal(raw.enc, 'gzip');
  assert.equal(JSON.parse(zlib.gunzipSync(raw.body)).endpoints.length, 3);
});
