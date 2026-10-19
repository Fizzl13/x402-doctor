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
  for (const p of ['/xrpl', '/algorand', '/stellar', '/settlement', '/status', '/sellers']) assert.match(await (await fetch(base + p)).text(), /property="og:title"/, p);
});

test('today\'s numbers in the HTML of /trust and the network pages, for crawlers that don\'t run scripts', async (t) => {
  const { trustFill, networkFill, scanDate } = require('../lib/page-meta');
  assert.equal(scanDate('2026-10-08'), '8 Oct 2026');
  assert.deepEqual(trustFill(null), []);
  assert.deepEqual(networkFill({ endpoints: 0, days: ['2026-10-18'] }), []);
  const summary = { latest: { go: 600, caution: 40, no_go: 350, unreachable: 10 }, daily: [{ date: '2026-10-17' }, { date: '2026-10-18' }], services: { payable_endpoints: 640, services: 300, sellers: 20 } };
  const [[placeholder, headline]] = trustFill(summary);
  assert.equal(placeholder, "Loading today's scan…");
  assert.equal(headline, 'In the scan of 18 Oct 2026, an agent could pay <strong>64%</strong> of the <strong>1,000</strong> paid services checked (x402 and MPP) without a failed payment.');
  // One seller with a large share of the scan: the share without it, in the headline and the FAQ answer.
  const farm = { ...summary, latest: { go: 600, caution: 40, no_go: 1350, unreachable: 10 }, largest_host: { endpoints: 1000, share_pct: 50, down: true, latest_without: { go: 600, caution: 40, no_go: 350, unreachable: 10 } } };
  const farmFill = trustFill(farm);
  assert.equal(farmFill[0][1], 'In the scan of 18 Oct 2026, an agent could pay <strong>32%</strong> of the <strong>2,000</strong> paid services checked (x402 and MPP) without a failed payment. One seller with 1,000 of them (50%) could not be paid in this scan; without it, an agent could pay 64% of the other 1,000.');
  assert.match(farmFill.find(([k]) => k === '<!--trust-faq-->')[1], /One seller with 1,000 of them \(50%\) could not be paid in this scan; without it, an agent could pay 64% of the other 1,000\./);
  assert.match(trustFill({ ...farm, largest_host: { ...farm.largest_host, down: false } })[0][1], /One seller has 1,000 of them \(50%\); without it/);
  const m = createPageMeta({ read: () => '<div class="v">…</div><div class="v">…</div><p>…</p>' });
  assert.equal(m.render('x', { fill: [['<div class="v">…</div>', '<div class="v">1</div>'], ['<div class="v">…</div>', '<div class="v">$2</div>']] }).split('<meta')[0], '<div class="v">1</div><div class="v">$2</div><p>…</p>');

  const view = { endpoints: 1631, payable_now: 1584, sellers: [{}, {}, {}], services: 599, days: ['2026-10-18'] };
  let networkCalls = 0;
  const trustIndex = { lookup: async () => null, seller: async () => ({ resources: 0 }), summary: () => summary, refresh: async () => {}, updated: () => '2026-10-18T03:40:00Z', byNetwork: async (network) => { networkCalls++; return network === 'stellar' ? view : null; } };
  const app = createApp({ env: {}, trustIndex, status: { snapshot: async () => ({}) } });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const trust = await (await fetch(`${base}/trust`)).text();
  assert.ok(trust.includes(headline));
  assert.ok(!trust.includes("Loading today's scan…"));
  const blocks = [...trust.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
  assert.deepEqual([blocks[0]['@type'], blocks[0].dateModified, blocks[0].temporalCoverage], ['Dataset', '2026-10-18', '2026-10-17/2026-10-18']);
  // The FAQ: today's numbers, and the visible questions and answers are the FAQPage JSON-LD's, word for word.
  assert.equal(blocks[1]['@type'], 'FAQPage');
  const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const visible = [...trust.matchAll(/<h3>([^<]*)<\/h3>\s*<p>([^<]*)<\/p>/g)].map((m) => [unesc(m[1]), unesc(m[2])]);
  assert.deepEqual(visible, blocks[1].mainEntity.map((q) => [q.name, q.acceptedAnswer.text]));
  assert.match(visible[0][1], /^In the scan of 18 Oct 2026, x402 Doctor checked 1,000 paid API endpoints listed in .*The 640 payable ones are 300 distinct services from 20 sellers/);
  assert.match(visible[1][1], /^64% in the scan of 18 Oct 2026: 640 of 1,000 endpoints/);
  assert.ok(!trust.includes('<!--trust-faq'));
  const stellar = await (await fetch(`${base}/stellar`)).text();
  assert.match(stellar, /<div class="k">Endpoints<\/div><div class="v">1,631<\/div>.*Payable on Stellar now<\/div><div class="v">1,584<\/div>.*Sellers<\/div><div class="v">3<\/div>.*Distinct services<\/div><div class="v">599<\/div>/s);
  assert.match(stellar, /<p class="note" id="updated">From the daily scan of 2026-10-18\.<\/p>/);
  await fetch(`${base}/stellar`);
  assert.equal(networkCalls, 1, 'once per index update');
  const xrpl = await (await fetch(`${base}/xrpl`)).text();
  assert.match(xrpl, /<div class="v">…<\/div>/, 'no numbers yet: the placeholders stay');
});
