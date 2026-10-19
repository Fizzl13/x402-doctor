// Sellers add their own endpoint to the Trust Index: the submit check, the list the scan reads, the scan's selection
// and the lookup of an added endpoint (kept apart from the registry index and its totals).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTrustSubmissions, MAX_PER_HOST } = require('../lib/trust-submissions');
const { loadSubmissions, submittedResources } = require('../lib/trust-scan');
const { createTrustIndex } = require('../lib/trust-index');
const { createApp } = require('../server.js');

const x402 = { verdict: 'go', method: 'GET', options: [{ protocol: 'x402', payable: true }], reasons: [] };
const noChallenge = { verdict: 'no_go', method: 'GET', options: [], reasons: [{ level: 'no_go', code: 'no_402', message: 'The endpoint does not answer 402 Payment Required, so there is nothing to pay.' }] };
const fakeLog = () => {
  const events = [];
  let flushes = 0;
  return { events, flushes: () => flushes, record: (e) => events.push(e), flush: async () => { flushes++; } };
};
const noIndex = { lookup: async () => null, submittedKeys: () => [] };

test('submit: checks the endpoint, adds it once, and the list has it', async () => {
  const usageLog = fakeLog();
  const subs = createTrustSubmissions({ usageLog });
  const checked = [];
  const check = async (url) => (checked.push(url), x402);

  assert.equal((await subs.submit('not a url', { check, trustIndex: noIndex })).status, 400);
  assert.equal((await subs.submit('http://seller.example/paid', { check, trustIndex: noIndex })).status, 400);

  const out = await subs.submit('https://seller.example/paid?x=1', { check, trustIndex: noIndex });
  assert.equal(out.status, 201);
  assert.equal(out.body.status, 'added');
  assert.match(out.body.message, /next daily scan/);
  assert.deepEqual(checked, ['https://seller.example/paid?x=1']);
  assert.equal(usageLog.events[0].route, 'trust submit');
  assert.equal(usageLog.events[0].result.accepted, true);
  assert.equal(usageLog.flushes(), 1);

  const again = await subs.submit('https://seller.example/paid', { check, trustIndex: noIndex });
  assert.equal(again.status, 200);
  assert.equal(again.body.status, 'submitted');
  assert.equal(checked.length, 1);
  const list = await subs.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].url, 'https://seller.example/paid?x=1');
  assert.equal(list[0].method, 'GET');
});

test('submit: already listed by a registry, no challenge, MPP only', async () => {
  const subs = createTrustSubmissions({ usageLog: fakeLog() });
  const listed = { lookup: async () => ({ days_checked: 3 }), submittedKeys: () => [] };
  const out = await subs.submit('https://big.example/paid', { check: async () => assert.fail('no check needed'), trustIndex: listed });
  assert.equal(out.body.status, 'listed');

  const none = await subs.submit('https://seller.example/free', { check: async () => noChallenge, trustIndex: noIndex });
  assert.equal(none.status, 422);
  assert.match(none.body.error, /does not answer 402/);
  assert.match(none.body.check, /\?url=https%3A%2F%2Fseller\.example%2Ffree$/);

  const mpp = await subs.submit('https://mpp.example/run', { check: async () => ({ verdict: 'go', method: 'POST', options: [{ protocol: 'mpp' }], reasons: [] }), trustIndex: noIndex });
  assert.equal(mpp.status, 201);
  const [entry] = (await subs.list()).filter((s) => s.url === 'https://mpp.example/run');
  assert.deepEqual([entry.method, entry.p], ['POST', 'mpp']);
});

test(`submit: at most ${MAX_PER_HOST} endpoints per host, counting the ones already scanned`, async () => {
  const subs = createTrustSubmissions({ usageLog: fakeLog() });
  const scanned = ['https://farm.example/s1', 'https://farm.example/s2'];
  const index = { lookup: async () => null, submittedKeys: (host) => (host === 'farm.example' ? scanned : []) };
  for (let i = 0; i < MAX_PER_HOST - scanned.length; i++) {
    assert.equal((await subs.submit(`https://farm.example/r${i}`, { check: async () => x402, trustIndex: index })).status, 201);
  }
  const over = await subs.submit('https://farm.example/one-more', { check: async () => x402, trustIndex: index });
  assert.equal(over.status, 429);
  assert.equal((await subs.submit('https://other.example/r', { check: async () => x402, trustIndex: index })).status, 201);
});

test('list: reads accepted submissions back from the trust-submit log, oldest first, one per path', async () => {
  let asked;
  const usageReader = {
    configured: true,
    load: async (opts) => {
      asked = opts;
      return { events: [
        { t: '2026-10-19T10:00:00Z', route: 'trust submit', input: { url: 'https://b.example/x', method: 'POST' }, result: { accepted: true } },
        { t: '2026-10-18T10:00:00Z', route: 'trust submit', input: { url: 'https://a.example/x?q=1', method: 'GET' }, result: { accepted: true } },
        { t: '2026-10-19T11:00:00Z', route: 'trust submit', input: { url: 'https://a.example/x' }, result: { accepted: true } },
        { t: '2026-10-19T12:00:00Z', route: 'trust submit', input: { url: 'https://c.example/x' }, result: { accepted: false } },
      ] };
    },
  };
  const subs = createTrustSubmissions({ usageLog: fakeLog(), usageReader });
  const list = await subs.list();
  assert.equal(asked.service, 'trust-submit');
  assert.deepEqual(list.map((s) => s.url), ['https://a.example/x?q=1', 'https://b.example/x']);
  assert.equal(list[1].method, 'POST');
});

test('scan: loads submissions and picks what to scan into submitted.json', async () => {
  const fetchImpl = async () => Response.json({ submissions: [
    { url: 'https://a.example/x', method: 'GET' },
    { url: 'http://insecure.example/x' },
    { url: 'https://a.example/x/' },
    { url: 'https://m.example/run', method: 'POST', p: 'mpp' },
  ] });
  const subs = await loadSubmissions({ url: 'https://doctor.test/api/trust/submitted', fetchImpl });
  assert.deepEqual(subs.map((s) => s.key), ['https://a.example/x', 'https://m.example/run']);
  assert.equal(subs[1].p, 'mpp');

  const previous = { resources: {
    'https://old.example/ok': { url: 'https://old.example/ok', m: 'GET', h: '--gnn' },
    'https://old.example/dead': { url: 'https://old.example/dead', m: 'GET', h: 'n'.repeat(14) },
    'https://a.example/x': { url: 'https://a.example/x', m: 'GET', h: 'g' },
    'https://listed.example/now': { url: 'https://listed.example/now', m: 'GET', h: 'g' },
  } };
  const picked = submittedResources(previous, subs, new Set(['https://listed.example/now']));
  assert.deepEqual(picked.map((r) => r.key), ['https://old.example/ok', 'https://a.example/x', 'https://m.example/run']);

  const many = Array.from({ length: 30 }, (_, i) => ({ key: `https://farm.example/r${i}`, url: `https://farm.example/r${i}` }));
  assert.equal(submittedResources(null, many, new Set()).length, 25);
});

test('trust index: an added endpoint has a track record, marked submitted, and stays out of the totals', async () => {
  const index = { updated: 'now', days: ['2026-10-19', '2026-10-20'], resources: { 'https://a.example/paid': { url: 'https://a.example/paid', m: 'GET', h: 'gg', last: { verdict: 'go' } } } };
  const submitted = { updated: 'now', days: ['2026-10-20'], resources: { 'https://seller.example/paid': { url: 'https://seller.example/paid', m: 'GET', h: 'c', last: { verdict: 'caution' } } } };
  const fetchImpl = async (url) => (url === 'http://index.test' ? Response.json(index) : url === 'http://submitted.test' ? Response.json(submitted) : new Response('{}', { status: 404 }));
  const ti = createTrustIndex({ url: 'http://index.test', categoriesUrl: 'http://cat.test', submittedUrl: 'http://submitted.test', fetchImpl });
  const record = await ti.lookup('https://seller.example/paid', { waitMs: 2000 });
  assert.equal(record.submitted, true);
  assert.equal(record.days_payable, 1);
  assert.equal((await ti.lookup('https://a.example/paid')).submitted, undefined);
  assert.equal(ti.summary().resources, 1);
  assert.deepEqual(ti.submittedKeys('seller.example'), ['https://seller.example/paid']);
});

test('server: POST /api/trust/submit, GET /api/trust/submitted, and a 404 that says it was added', async (t) => {
  const added = { url: 'https://seller.example/paid', method: 'GET', t: '2026-10-19T20:00:00.000Z' };
  const calls = [];
  const trustSubmissions = {
    submit: async (url) => (calls.push(url), { status: 201, body: { status: 'added', url } }),
    list: async () => [added],
    find: async (url) => (url === added.url ? added : null),
  };
  const empty = { updated: 'now', days: ['2026-10-19'], resources: {} };
  const app = createApp({
    env: {},
    status: { snapshot: async () => ({}) },
    trustIndex: createTrustIndex({ url: 'http://index.test', categoriesUrl: 'http://cat.test', submittedUrl: 'http://submitted.test', fetchImpl: async () => Response.json(empty) }),
    trustSubmissions,
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const res = await fetch(`${base}/api/trust/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://seller.example/paid' }) });
  assert.equal(res.status, 201);
  assert.deepEqual(calls, ['https://seller.example/paid']);
  assert.deepEqual((await (await fetch(`${base}/api/trust/submitted`)).json()).submissions, [added]);

  const miss = await (await fetch(`${base}/api/trust?url=${encodeURIComponent(added.url)}`)).json();
  assert.equal(miss.submitted_at, added.t);
  assert.match(miss.how_to_list, /POST \/api\/trust\/submit/);
  const other = await (await fetch(`${base}/api/trust?url=${encodeURIComponent('https://nobody.example/x')}`)).json();
  assert.equal(other.submitted_at, undefined);
});
