// POST /api/trust/batch: many track records in one call, for directories that re-test their own lists.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTrustIndex } = require('../lib/trust-index');
const { createSpotResults } = require('../lib/spot-results');
const { createApp } = require('../server.js');

const serve = (body, status = 200) => async () => new Response(JSON.stringify(body), { status });
const index = {
  updated: '2026-10-14T01:00:00Z',
  days: ['2026-10-12', '2026-10-13', '2026-10-14'],
  resources: {
    'https://a.example/paid': { url: 'https://a.example/paid', m: 'GET', h: 'ggg', last: { verdict: 'go', price_usd: 0.01 } },
    'https://b.example/run': { url: 'https://b.example/run', m: 'POST', h: 'gnn', last: { verdict: 'no_go', codes: ['no_402'] } },
  },
};
const report = {
  date: '2026-10-12', index_date: '2026-10-12', rules: { n: 30, cap_usd: 0.05 },
  summary: { live: true, sampled: 1, bought: 1, outcomes: { charged_not_delivered: 1 }, paid_and_delivered_pct: 0, spent_usd: 0.01 },
  results: [{ url: 'https://b.example/run', host: 'b.example', step: 'paid', result: 'charged_not_delivered', price_usd: 0.01, charged_usd: 0.01, status: 422 }],
};

async function start(t, opts = {}) {
  const app = createApp({
    env: {},
    status: { snapshot: async () => ({}) },
    trustIndex: createTrustIndex({ url: 'http://index.test', categoriesUrl: 'http://cat.test', fetchImpl: serve(index) }),
    spotResults: createSpotResults({ url: 'http://spot.test', fetchImpl: serve(report) }),
    ...opts,
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return (body) => fetch(`${base}/api/trust/batch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

test('trust batch: one record per URL in the order sent; days and date once at the top', async (t) => {
  const post = await start(t);
  const res = await post({ urls: ['https://a.example/paid', 'https://nobody.example/x', 'not a url', 'https://b.example/run'] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.updated, '2026-10-14T01:00:00Z');
  assert.deepEqual(body.days, index.days);
  assert.equal(body.found, 2);
  assert.deepEqual(body.results.map((r) => [r.url, r.found ?? r.error]), [
    ['https://a.example/paid', true],
    ['https://nobody.example/x', false],
    ['not a url', 'not a valid URL'],
    ['https://b.example/run', true],
  ]);
  const [a, , , b] = body.results;
  assert.equal(a.days_payable, 3);
  assert.equal(a.history, 'ggg');
  assert.equal(a.days, undefined, 'the days are only at the top');
  assert.equal(b.last_scan.verdict, 'no_go');
  assert.equal(b.spot_buy.result, 'charged_not_delivered', 'the spot-buy result rides along, as in GET /api/trust');
});

test('trust batch: 1 to 100 URLs, else 400', async (t) => {
  const post = await start(t);
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ urls: [] })).status, 400);
  assert.equal((await post({ urls: 'https://a.example/paid' })).status, 400);
  const tooMany = Array.from({ length: 101 }, (_, i) => `https://a.example/${i}`);
  assert.match((await (await post({ urls: tooMany })).json()).error, /1 to 100/);
  assert.equal((await post({ urls: tooMany.slice(0, 100) })).status, 200);
});

test('trust batch: rate limited per IP (10 a minute)', async (t) => {
  const post = await start(t);
  const statuses = [];
  for (let i = 0; i < 11; i++) statuses.push((await post({ urls: ['https://a.example/paid'] })).status);
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(200));
  assert.equal(statuses[10], 429);
});
