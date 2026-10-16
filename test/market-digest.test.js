// lib/market-digest.js: the weekly market digest from the Bazaar's per-route counts and the Trust Index's kinds.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTrustIndex } = require('../lib/trust-index');
const { descKey } = require('../lib/services');
const { marketDigest } = require('../lib/market-digest');

const index = {
  updated: '2026-10-19T01:00:00Z',
  days: ['2026-10-17', '2026-10-18', '2026-10-19'],
  resources: {
    a: { url: 'https://pay.seller.ai/a', h: 'ggg', d: 'Bitcoin price signal', last: { verdict: 'go', price_usd: 0.01, networks: ['eip155:8453'] } },
    q: { url: 'https://quest.example/verdict', h: 'ggg', d: 'Token verdict for a wallet', last: { verdict: 'go', price_usd: 0.02, networks: ['eip155:8453'] } },
    s: { url: 'https://search.example/web', h: 'ggg', d: 'Web search for agents', last: { verdict: 'go', price_usd: 0.005, networks: ['eip155:8453'] } },
  },
};
const categories = { categories: { [descKey('Token verdict for a wallet')]: 'onchain', [descKey('Web search for agents')]: 'search' } };
const fetchImpl = async (url) => new Response(JSON.stringify(String(url).includes('cat') ? categories : index));
async function atlasMap() {
  const ti = createTrustIndex({ url: 'http://index.test', categoriesUrl: 'http://cat.test', fetchImpl });
  await ti.refresh();
  return ti.atlas();
}
const at = Date.parse('2026-10-19T06:00:00Z');
const daysAgo = (d) => new Date(at - d * 864e5).toISOString();
// Week 1: a quest route (400,000 calls from 4,000 wallets, stopped 8 days ago) next to two sellers still paid.
const week1 = {
  at,
  calls: new Map([['seller.ai', 50_000], ['quest.example', 400_000], ['search.example', 10_000]]),
  active: new Map([['seller.ai', 50_000], ['search.example', 10_000]]),
  payers: new Map([['seller.ai', 5_000], ['quest.example', 4_000], ['search.example', 900]]),
  top: [
    { route: 'https://quest.example/verdict', site: 'quest.example', calls: 400_000, payers: 4_000, last: daysAgo(8) },
    { route: 'https://pay.seller.ai/a', site: 'seller.ai', calls: 50_000, payers: 5_000, last: daysAgo(0.1) },
    { route: 'https://search.example/web', site: 'search.example', calls: 10_000, payers: 900, last: daysAgo(0.2) },
  ],
};

test('market digest: the share still paid, kinds by still-paid calls, and a route paid many times per wallet counted but never named', async () => {
  const { stats, markdown, posts, snapshot } = marketDigest({ map: await atlasMap(), bazaar: week1 });
  assert.equal(stats.calls_30d, 460_000);
  assert.equal(stats.calls_active, 60_000);
  assert.equal(stats.active_pct, 13);
  assert.deepEqual(stats.kinds.map((k) => [k.id, k.calls_active, k.share_active]), [['crypto', 50_000, 83.3], ['search', 10_000, 16.7]], 'a kind with nothing still paid drops out');
  assert.equal(stats.heavy_routes.length, 1, 'seller.ai is 10 calls per wallet: ordinary');
  const [q] = stats.heavy_routes;
  assert.equal(q.calls_per_wallet, 100);
  assert.equal(q.still_paid, false);
  assert.equal(q.last_paid, '2026-10-11');
  assert.equal(q.new, null, 'nothing to compare with in the first week');
  assert.match(q.kind, /on-chain/i);
  assert.equal(stats.previous, null);
  assert.deepEqual(stats.risers, []);
  for (const text of [markdown, posts.x, posts.linkedin, JSON.stringify(snapshot)]) assert.doesNotMatch(text, /quest\.example/, 'the route is described, not named');
  assert.match(markdown, /\*\*60,000 of 460,000 paid calls over 30 days \(13%\) are on routes still paid in the last 3 days\.\*\*/);
  assert.match(posts.x, /One route \(.+\) had 400,000 of all those calls, from 4,000 wallets; last paid 2026-10-11\./);
  assert.ok(posts.x_length <= 280, `X draft is ${posts.x_length} characters`);
  assert.doesNotMatch(posts.x, /Week on week/);
  assert.match(posts.linkedin, /atlas\.fizzl\.eu/);
});

test('market digest, the week after: still-paid change, risers named only with ordinary calls per wallet, known routes not new', async () => {
  const map = await atlasMap();
  const { snapshot } = marketDigest({ map, bazaar: week1 });
  const week2 = {
    ...week1,
    at: at + 7 * 864e5,
    calls: new Map([['seller.ai', 56_000], ['quest.example', 60_000], ['search.example', 12_000]]),
    active: new Map([['seller.ai', 56_000], ['search.example', 12_000], ['quest.example', 60_000]]),
    payers: new Map([['seller.ai', 5_600], ['quest.example', 600], ['search.example', 1_000]]),
    top: [{ route: 'https://quest.example/verdict', site: 'quest.example', calls: 60_000, payers: 600, last: new Date(at + 7 * 864e5 - 3600e3).toISOString() }],
  };
  const { stats, posts, markdown } = marketDigest({ map, bazaar: week2, previous: snapshot });
  assert.equal(stats.previous.calls_active, 60_000);
  assert.equal(stats.calls_active, 128_000);
  assert.deepEqual(stats.risers.map((r) => [r.site, r.gained]), [['seller.ai', 6_000], ['search.example', 2_000]], 'quest.example gained more but is paid 100 times per wallet');
  assert.equal(stats.heavy_routes[0].new, false, 'the same route as last week');
  assert.equal(stats.heavy_routes[0].still_paid, true);
  assert.match(markdown, /Week on week, still-paid calls went up by 68,000/);
  assert.match(posts.linkedin, /Rising this week, in still-paid calls: seller\.ai \(\+6,000\) and search\.example \(\+2,000\)\./);
  assert.ok(posts.x_length <= 280);
  assert.doesNotMatch(markdown + posts.x + posts.linkedin, /quest\.example/);
});

test('market digest needs the Bazaar\'s still-paid counts', async () => {
  const map = await atlasMap();
  assert.throws(() => marketDigest({ map, bazaar: { ...week1, active: null } }), /still-paid/);
});
