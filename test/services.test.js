// Distinct services and their kind (lib/services.js, lib/jev-category.js, scripts/categorize.js): near-identical
// endpoints of one seller are one service, Jev's cached category wins over the keyword guess, Jev is asked in
// batches with a Choice question and only about descriptions it hasn't answered, and the Trust Index views count
// services and categories.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { groupServices, guessCategory, descKey, categoryOf, CATEGORY_IDS } = require('../lib/services');
const { createCategorizer } = require('../lib/jev-category');
const { createTrustIndex } = require('../lib/trust-index');

const entry = (url, d, verdict = 'go', networks = ['eip155:8453']) => [url, { url, d, h: 'g', last: { verdict, price_usd: 0.01, networks } }];
const resources = Object.fromEntries([
  ...['bitcoin', 'ethereum', 'solana', 'dogecoin'].map((c) => entry(`https://api.farm.example/price/${c}`, `Live ${c} price in USD with 24h change and volume`, 'go', ['algorand:x'])),
  entry('https://api.farm.example/weather', 'Weather forecast for any city: temperature, rain and wind for 7 days', 'go', ['algorand:x']),
  entry('https://other.example/check', 'Check a token for honeypot and rug-pull risk before buying'),
  entry('https://other.example/broken', 'Live bitcoin price in USD with 24h change and volume', 'no_go'),
]);

test('groupServices: one seller\'s near-identical endpoints are one service; only payable resources count', () => {
  const { services, byUrl, bySite } = groupServices(resources);
  assert.equal(services.length, 3);
  assert.deepEqual(bySite['farm.example'], { endpoints: 5, services: 2 });
  assert.deepEqual(bySite['other.example'], { endpoints: 1, services: 1 });
  assert.equal(byUrl.get('https://api.farm.example/price/solana').members.length, 4);
  assert.equal(byUrl.has('https://other.example/broken'), false, 'not payable: not counted');
});

test('guessCategory and categoryOf: keywords as the fallback, Jev\'s cached answer first', () => {
  assert.equal(guessCategory('Live bitcoin price in USD'), 'crypto');
  assert.equal(guessCategory('Check a token for honeypot and rug-pull risk'), 'security');
  assert.equal(guessCategory('Something else entirely'), 'data');
  const { services } = groupServices(resources);
  const weather = services.find((s) => /Weather/.test(s.rep.d));
  assert.equal(categoryOf(weather, {}), 'places');
  assert.equal(categoryOf(weather, { [descKey(weather.rep.d)]: 'data' }), 'data');
  assert.equal(categoryOf(weather, { [descKey(weather.rep.d)]: 'nonsense' }), 'places', 'an unknown id is ignored');
  assert.equal(descKey(' Same Text '), descKey('same text'));
  assert.ok(CATEGORY_IDS.includes('data'));
});

test('categorizer: off without a key; Choice questions in batches; answers kept per key; a failed batch skipped', async () => {
  assert.equal(createCategorizer({ apiKey: '' }).enabled, false);
  const calls = [];
  let n = 0;
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (n++ === 1) return new Response('{}', { status: 529 });
    return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map((k) => [k, { type: 'choice', choice: k === 's1' ? 'bogus' : 'crypto' }])) });
  };
  const items = Array.from({ length: 5 }, (_, i) => ({ key: `k${i}`, host: 'h.example', description: `d${i}` }));
  const out = await createCategorizer({ apiKey: 'k', fetch, batch: 2, log: { warn() {} } }).categorize(items);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].questions.s0.type, 'choice');
  assert.ok(calls[0].questions.s0.criteria.security);
  assert.equal(calls[0].questions.s0.instructions.service.description, 'd0');
  assert.deepEqual(out, { k0: 'crypto', k4: 'crypto' }, 'k1 had an unknown id, k2/k3 were in the failed batch');
});

test('scripts/categorize.js: without a key it carries over the answers still in the index and drops the rest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-'));
  const { services } = groupServices(resources);
  const kept = descKey(services[0].rep.d);
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ resources }));
  fs.writeFileSync(path.join(dir, 'prev.json'), JSON.stringify({ categories: { [kept]: 'crypto', gone: 'ai' } }));
  execFileSync(process.execPath, [path.join(__dirname, '../scripts/categorize.js'), '--index', path.join(dir, 'index.json'), '--previous', path.join(dir, 'prev.json'), '--out', path.join(dir, 'out.json')], { env: { ...process.env, TYPESAFE_API_KEY: '', GITHUB_STEP_SUMMARY: '' }, stdio: 'pipe' });
  const out = JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8'));
  assert.deepEqual(out.categories, { [kept]: 'crypto' });
});

test('Trust Index: summary counts services, the largest sellers and categories; byNetwork adds them per network', async () => {
  const { services } = groupServices(resources);
  const weatherKey = descKey(services.find((s) => /Weather/.test(s.rep.d)).rep.d);
  const ti = createTrustIndex({
    url: 'http://index.test', categoriesUrl: 'http://cats.test',
    fetchImpl: async (u) => (String(u).includes('cats') ? Response.json({ categories: { [weatherKey]: 'data' } }) : Response.json({ updated: 'now', days: ['d'], resources })),
  });
  await ti.refresh();
  const s = ti.summary().services;
  assert.equal(s.payable_endpoints, 6);
  assert.equal(s.services, 3);
  assert.equal(s.sellers, 2);
  assert.deepEqual(s.largest[0], { seller: 'farm.example', endpoints: 5, services: 2 });
  assert.deepEqual(s.categories.map((c) => [c.id, c.services]).sort(), [['crypto', 1], ['data', 1], ['security', 1]]);
  const a = await ti.byNetwork('algorand');
  assert.equal(a.endpoints, 5);
  assert.equal(a.services, 2);
  assert.deepEqual(a.sellers.map((x) => [x.host, x.endpoints, x.services]), [['farm.example', 5, 2]]);
  const btc = a.resources.find((r) => r.url.endsWith('/bitcoin'));
  assert.equal(btc.category, 'crypto');
  assert.equal(btc.same_service_endpoints, 4);
  assert.equal(a.resources.find((r) => r.url.endsWith('/weather')).category, 'data', 'Jev\'s cached answer');
});
