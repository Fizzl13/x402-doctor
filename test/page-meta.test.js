// Link previews (lib/page-meta.js): Open Graph and Twitter card tags on the static pages, with today's numbers on /trust.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPageMeta, trustDescription } = require('../lib/page-meta');
const { createApp } = require('../server.js');

test('adds preview tags from the page title and description, escaped; leaves pages that have them', () => {
  const pages = {
    a: '<html><head><title>Page &amp; more</title><meta name="description" content="Own text"></head><body></body></html>',
    b: '<html><head><meta property="og:title" content="x"></head></html>',
  };
  const m = createPageMeta({ origin: 'https://doc.test', read: (f) => pages[f] });
  const a = m.render('a', { path: '/a' });
  assert.match(a, /<meta property="og:title" content="Page &amp; more">/);
  assert.match(a, /<meta property="og:description" content="Own text">/);
  assert.match(a, /<meta property="og:url" content="https:\/\/doc.test\/a">/);
  assert.match(a, /<meta name="twitter:card" content="summary_large_image">/);
  assert.match(a, /og:image" content="https:\/\/doc.test\/og.jpg"/);
  assert.ok(a.indexOf('og:title') < a.indexOf('</head>'));
  assert.match(m.render('a', { description: 'Fresh "numbers" <today>' }), /og:description" content="Fresh &quot;numbers&quot; &lt;today&gt;"/);
  assert.equal(m.render('b'), pages.b);
});

test('the Trust Index description has today\'s numbers, none while loading', () => {
  assert.equal(trustDescription(null), null);
  assert.equal(trustDescription({ services: {} }), null);
  assert.match(trustDescription({ services: { payable_endpoints: 39765, services: 18864, sellers: 1789 } }), /^39,765 payable x402 endpoints, but only 18,864 distinct services from 1,789 sellers\./);
});

test('GET /trust and the other pages carry link previews', async (t) => {
  const trustIndex = { lookup: async () => null, seller: async () => ({ resources: 0 }), summary: () => ({ services: { payable_endpoints: 100, services: 40, sellers: 7 } }), refresh: async () => {} };
  const app = createApp({ env: {}, trustIndex, status: { snapshot: async () => ({}) } });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const trust = await fetch(`${base}/trust`);
  assert.equal(trust.status, 200);
  assert.match(trust.headers.get('content-type'), /text\/html/);
  const html = await trust.text();
  assert.match(html, /og:description" content="100 payable x402 endpoints, but only 40 distinct services from 7 sellers/);
  assert.match(html, /og:url" content="https:\/\/x402-doctor.fizzl.eu\/trust"/);
  for (const p of ['/xrpl', '/algorand', '/settlement', '/status', '/sellers']) assert.match(await (await fetch(base + p)).text(), /property="og:title"/, p);
});
