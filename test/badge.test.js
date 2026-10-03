const test = require('node:test');
const assert = require('node:assert/strict');
const { renderBadge, badgeFor } = require('../lib/badge');
const { createApp } = require('../server.js');

test('badge text: a resource by its days, a whole origin by its endpoints', () => {
  assert.deepEqual(badgeFor({ record: { last: 'g', payable_ratio: 1, days_payable: 30, days_checked: 30 } }), { message: 'payable 30/30 days', color: 'green' });
  assert.equal(badgeFor({ record: { last: 'c', payable_ratio: 0.7, days_payable: 7, days_checked: 10 } }).color, 'yellow');
  assert.deepEqual(badgeFor({ record: { last: 'n', payable_ratio: 0.95, days_payable: 19, days_checked: 20 } }), { message: 'not payable today', color: 'red' });
  assert.deepEqual(badgeFor({ seller: { resources: 4, payable_now: 4, avg_payable_ratio: 0.98 } }), { message: '4 endpoints · 98% payable', color: 'green' });
  assert.equal(badgeFor({ seller: { resources: 4, payable_now: 3, avg_payable_ratio: 0.98 } }).color, 'yellow');
  assert.equal(badgeFor({ seller: { resources: 0 } }).message, 'not scanned yet');
  const svg = renderBadge({ message: 'a <b> & "c"', color: 'green' });
  assert.match(svg, /^<svg /);
  assert.ok(!svg.includes('<b>'), 'text is escaped');
  assert.match(svg, /a &lt;b&gt; &amp; &quot;c&quot;/);
});

test('GET /badge.svg: from the trust index, cached, and usable from any site', async (t) => {
  const trustIndex = {
    lookup: async (u) => (u === 'https://api.example.com/paid' ? { last: 'g', payable_ratio: 1, days_payable: 9, days_checked: 9 } : null),
    seller: async (u) => (new URL(u).origin === 'https://api.example.com' ? { origin: 'https://api.example.com', resources: 3, payable_now: 3, avg_payable_ratio: 0.97 } : { resources: 0 }),
    summary: () => null,
    refresh: async () => {},
  };
  const app = createApp({ env: {}, trustIndex, status: { snapshot: async () => ({}) } });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const one = await fetch(`${base}/badge.svg?url=${encodeURIComponent('https://api.example.com/paid')}`);
  assert.equal(one.status, 200);
  assert.equal(one.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
  assert.match(one.headers.get('cache-control'), /max-age=3600/);
  assert.equal(one.headers.get('access-control-allow-origin'), '*');
  assert.match(await one.text(), /payable 9\/9 days/);
  assert.match(await (await fetch(`${base}/badge.svg?url=https://api.example.com`)).text(), /3 endpoints · 97% payable/);
  assert.match(await (await fetch(`${base}/badge.svg?url=https://api.example.com/other`)).text(), /3 endpoints/); // unknown path: the origin's record
  assert.match(await (await fetch(`${base}/badge.svg?url=https://nobody.test/x`)).text(), /not scanned yet/);
  assert.equal((await fetch(`${base}/badge.svg?url=nonsense`)).status, 400);
});
