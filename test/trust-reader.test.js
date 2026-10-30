// The Doctor reads the Trust Index from precomputed files (lib/trust-views.js, lib/trust-reader.js): every answer
// must equal the full index's (lib/trust-index.js), and it falls back to the full index until the views exist.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTrustIndex } = require('../lib/trust-index');
const { buildViews, bucketOf } = require('../lib/trust-views');
const { createTrustReader } = require('../lib/trust-reader');
const { descKey } = require('../lib/services');

const BASE = 'https://data.test/trust-data/';
const days = ['2026-10-18', '2026-10-19', '2026-10-20'];
const r = (url, h, last, d = '', extra = {}) => ({ url, m: 'GET', h, last, d, ...extra });
const go = (price, networks, extra = {}) => ({ verdict: 'go', codes: [], price_usd: price, networks, ...extra });
const index = {
  version: 1,
  updated: '2026-10-20T01:00:00.000Z',
  days,
  sanctions: null,
  resources: {
    'https://a.example/forecast': r('https://a.example/forecast', 'ggg', go(0.01, ['eip155:8453', 'xrpl:0']), 'Weather forecast for any city, hourly'),
    'https://a.example/wallet/:address': r('https://a.example/wallet/:address', 'gcg', go(0.02, ['eip155:8453']), 'Wallet risk score by address'),
    'https://b.example/run': r('https://b.example/run', '-nn', { verdict: 'no_go', codes: ['no_402'], price_usd: null, networks: [] }, 'Run a job', { p: 'mpp' }),
    'https://c.example/tide': r('https://c.example/tide', 'ccc', { verdict: 'caution', codes: ['resource_mismatch'], price_usd: 0.03, networks: ['eip155:8453'], unpayable: { 'xrpl:0': 'no trust line for RLUSD' } }, 'Tide and weather forecast for harbours'),
    'https://d.example/quote?x=1': r('https://d.example/quote?x=1', 'g-g', go(0.05, ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp']), 'Stock quote for a ticker'),
    'https://e.example/free-llm': r('https://e.example/free-llm', 'ggg', go(0.001, ['eip155:8453']), 'Claude Opus answers, guaranteed returns'),
  },
};
index.resources['https://d.example/quote'] = index.resources['https://d.example/quote?x=1'];
delete index.resources['https://d.example/quote?x=1'];
const categories = { categories: { [descKey('Weather forecast for any city, hourly')]: 'weather' }, bait: { [descKey('Claude Opus answers, guaranteed returns')]: [0.95, 0.9] } };
const submitted = { version: 1, updated: index.updated, days: ['2026-10-20'], resources: { 'https://s.example/added': r('https://s.example/added', 'c', { verdict: 'caution', codes: [], price_usd: 0.02, networks: ['eip155:8453'] }) } };

const memFull = () => createTrustIndex({
  url: 'mem:index', categoriesUrl: 'mem:cat', submittedUrl: 'mem:sub',
  fetchImpl: async (u) => {
    const body = { 'mem:index': index, 'mem:cat': categories, 'mem:sub': submitted }[u];
    return body ? { ok: true, status: 200, headers: new Headers(), json: async () => body } : { ok: false, status: 404 };
  },
});

async function served() {
  const files = await buildViews({ index, categories, submitted });
  const map = new Map([...files].map(([p, v]) => [BASE + p, JSON.stringify(v)]));
  map.set(`${BASE}submitted.json`, JSON.stringify(submitted));
  const asked = [];
  const fetchImpl = async (u) => (asked.push(u.replace(BASE, '')), map.has(u) ? new Response(map.get(u), { headers: { etag: '"v1"' } }) : new Response('not found', { status: 404 }));
  return { files, fetchImpl, asked };
}

test('trust reader: every answer equals the full index', async () => {
  const full = memFull();
  await full.refresh();
  const { files, fetchImpl, asked } = await served();
  assert.equal([...files.keys()].filter((k) => k.startsWith('keys/')).length, 256);
  const reader = createTrustReader({ base: BASE, fetchImpl });

  for (const url of ['https://a.example/forecast', 'https://a.example/wallet/0xabc', 'https://b.example/run', 'https://c.example/tide/', 'https://d.example/quote?x=1', 'https://nobody.example/x', 'https://s.example/added', 'not a url']) {
    assert.deepEqual(await reader.lookup(url, { waitMs: 2000 }), await full.lookup(url), url);
  }
  for (const url of ['https://a.example/anything', 'https://nobody.example/']) assert.deepEqual(await reader.seller(url, { waitMs: 2000 }), await full.seller(url), url);
  assert.deepEqual(reader.summary(), full.summary());
  assert.equal(reader.updated(), full.updated());
  assert.deepEqual(reader.atlas(), full.atlas());
  for (const n of ['xrpl', 'eip155', 'eip155:8453', 'solana', 'stellar', 'nothing']) assert.deepEqual(await reader.byNetwork(n), await full.byNetwork(n), n);
  assert.deepEqual(await reader.similar('https://z.example/x', 'Weather forecast for a city'), await full.similar('https://z.example/x', 'Weather forecast for a city'));
  assert.deepEqual(reader.submittedKeys('s.example'), full.submittedKeys('s.example'));
  for (const site of ['a.example', 'b.example', 'e.example', 'nobody.example']) assert.deepEqual(await reader.sellerEndpoints(site), full.sellerEndpoints(site), site);
  assert.equal((await reader.sellerEndpoints('a.example')).total, 2);

  // A network view is passed through as its file, or answered empty, never parsed for the API.
  const opened = await reader.openNetwork('xrpl');
  assert.deepEqual(await opened.res.json(), await full.byNetwork('xrpl'));
  assert.deepEqual((await reader.openNetwork('nothing')).empty, await full.byNetwork('nothing'));

  // Only the files the questions needed: no full index.
  assert.ok(!asked.some((p) => /index\.(json|ndjson)$/.test(p)));
  assert.ok(asked.includes('views/meta.json'));
});

test('trust reader: keeps at most maxBuckets buckets, and falls back to the full index without views', async () => {
  const { fetchImpl } = await served();
  const reader = createTrustReader({ base: BASE, fetchImpl, maxBuckets: 2 });
  const urls = [];
  for (let i = 0; urls.length < 3; i++) {
    const url = `https://h${i}.example/x`;
    if (!urls.some((u) => bucketOf(u) === bucketOf(url))) urls.push(url);
  }
  for (const u of urls) await reader.lookup(u, { waitMs: 2000 });
  assert.equal(reader.kept(), 2);

  const none = async () => new Response('not found', { status: 404 });
  const fallback = createTrustReader({ base: BASE, fetchImpl: none, createFull: memFull });
  assert.equal((await fallback.lookup('https://a.example/forecast', { waitMs: 2000 })).days_payable, 3);
  assert.equal(fallback.summary().resources, Object.keys(index.resources).length);
  assert.equal(await fallback.openNetwork('xrpl'), null, 'the API then answers from byNetwork()');
});

test('trust reader: seller endpoints are unavailable, not an error, until a scan has published their files', async () => {
  const { fetchImpl } = await served();
  const without = async (u) => (u.includes('views/seller-endpoints/') ? new Response('not found', { status: 404 }) : fetchImpl(u));
  const reader = createTrustReader({ base: BASE, fetchImpl: without });
  assert.deepEqual(await reader.sellerEndpoints('a.example', { waitMs: 2000 }), { unavailable: true });
});
