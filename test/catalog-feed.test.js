// lib/catalog-feed.js: the marketplace feed (report, events, signature, retries), on a small fake index.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { buildFeed, deliver, sign } = require('../lib/catalog-feed');

const rec = (url, h, verdict, codes = [], pt) => ({ url, h, last: { verdict, codes }, ...(pt ? { pt } : {}) });
const index = {
  updated: '2026-11-22T01:39:00Z',
  days: ['2026-11-20', '2026-11-21', '2026-11-22'],
  resources: {
    'https://a.test/ok': rec('https://a.test/ok', 'ggg', 'go'),
    'https://a.test/broke': rec('https://a.test/broke', 'ggn', 'no_go', ['no_402']),
    'https://b.test/back': rec('https://b.test/back', 'nng', 'go'),
    'https://b.test/dead': rec('https://b.test/dead', 'nnn', 'no_go', ['host_disabled']),
    'https://c.test/wrong': rec('https://c.test/wrong', 'ggg', 'caution', ['resource_mismatch']),
    'https://c.test/moved': rec('https://c.test/moved', 'ggg', 'go', [], { a: { 'eip155:8453': 'abc' }, s: '2026-11-22' }),
    'https://d.test/not-today': rec('https://d.test/not-today', 'gn-', 'no_go', ['unreachable']),
    'https://e.test/not-listed': rec('https://e.test/not-listed', 'ggn', 'no_go', ['no_402']),
  },
};
const urls = ['https://a.test/ok/', 'https://a.test/broke', 'https://b.test/back', 'https://b.test/dead', 'https://c.test/wrong', 'https://c.test/moved', 'https://d.test/not-today', 'https://z.test/unknown', 'http://insecure.test/x'];

test('the daily report counts only the catalogue, from the index history', () => {
  const { report, events, state } = buildFeed({ catalogue: 'payapi', name: 'PayAPI Market', urls, index });
  assert.equal(report.date, '2026-11-22');
  assert.deepEqual(report.listed, { urls: 8, hosts: 5, in_index: 7, scanned_today: 6 });
  assert.equal(report.unpayable_today, 2);
  assert.equal(report.wrong_answers_today, 1);
  assert.deepEqual(report.broke_since_yesterday.map((i) => i.url), ['https://a.test/broke']);
  assert.deepEqual(report.recovered_since_yesterday.map((i) => i.url), ['https://b.test/back']);
  assert.deepEqual(report.payee_changed_today.map((i) => i.url), ['https://c.test/moved']);
  assert.deepEqual(events.map((e) => [e.event, e.url]), [['listing.broke', 'https://a.test/broke'], ['listing.recovered', 'https://b.test/back'], ['listing.payee_changed', 'https://c.test/moved']]);
  assert.equal(events[0].record, 'https://x402-doctor.fizzl.eu/?url=https://a.test/broke');
  assert.equal(events[0].payable_days_30d, '2/3');
  assert.deepEqual(state, { date: '2026-11-22', broken: ['https://a.test/broke', 'https://b.test/dead', 'https://c.test/wrong'] });
  assert.match(report.markdown, /Broke since yesterday: \*\*1\*\*/);
});

test("with yesterday's broken set, a wrong answer counts as broke too, and a fix as recovered", () => {
  const { report } = buildFeed({ catalogue: 'payapi', name: 'PayAPI Market', urls, index, previous: ['https://b.test/dead', 'https://b.test/back'] });
  assert.deepEqual(report.broke_since_yesterday.map((i) => i.url), ['https://a.test/broke', 'https://c.test/wrong']);
  assert.deepEqual(report.recovered_since_yesterday.map((i) => i.url), ['https://b.test/back']);
});

test('delivery signs the body with HMAC-SHA256 and retries until a 2xx', async () => {
  const calls = [];
  const statuses = [500, 202];
  const ok = await deliver({
    url: 'https://hook.test/x', secret: 's3cret', payload: { event: 'report.daily', catalogue: 'payapi', date: '2026-11-22' },
    fetchImpl: async (url, init) => { calls.push(init); return { status: statuses.shift() }; },
    delays: [1], sleep: async () => {}, log: { warn() {} },
  });
  assert.equal(ok, true);
  assert.equal(calls.length, 2);
  const want = `sha256=${crypto.createHmac('sha256', 's3cret').update(calls[0].body).digest('hex')}`;
  assert.equal(calls[0].headers['x-fizzl-signature'], want);
  assert.equal(sign('s3cret', calls[0].body), want);
  assert.equal(calls[0].headers['x-fizzl-delivery'], calls[1].headers['x-fizzl-delivery']);
  assert.equal(calls[0].headers['x-fizzl-event'], 'report.daily');
});

test('delivery gives up after the retries', async () => {
  let n = 0;
  const ok = await deliver({ url: 'https://hook.test/x', secret: 's', payload: { event: 'listing.broke', catalogue: 'payapi', since: 'd', url: 'u' }, fetchImpl: async () => { n++; throw new Error('down'); }, delays: [1, 1], sleep: async () => {}, log: { warn() {} } });
  assert.equal(ok, false);
  assert.equal(n, 3);
});
