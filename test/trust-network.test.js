// The per-network view of the Trust Index (/api/trust/network, the /xrpl page) and what the scan records for it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTrustIndex } = require('../lib/trust-index');
const { unpayableOf } = require('../lib/trust-scan');

test('unpayableOf: offered x402 networks that would not settle, with their first problem; none when all settle', () => {
  const out = unpayableOf([
    { protocol: 'x402', network: 'eip155:8453', payable: true, problems: [] },
    { protocol: 'x402', network: 'xrpl:0', payable: false, problems: ['payTo has no trust line for RLUSD'] },
    { protocol: 'x402', network: 'xrpl:0', payable: true, problems: [] },
    { protocol: 'x402', network: 'algorand:x', payable: false, problems: ['not opted in'] },
    { protocol: 'mpp', network: 'tempo', payable: false, problems: ['expired'] },
  ]);
  assert.deepEqual(out, { unpayable: { 'algorand:x': 'not opted in' } }, 'a network payable through another option is not unpayable; MPP is left out');
  assert.deepEqual(unpayableOf([{ protocol: 'x402', network: 'eip155:8453', payable: true }]), {});
});

test('byNetwork: endpoints offering XRPL, payable or not and why, grouped per seller site', async () => {
  const index = {
    updated: '2026-10-07T06:00:00Z', days: ['2026-10-06', '2026-10-07'],
    resources: {
      a: { url: 'https://pay.seller.ai/a', m: 'GET', h: 'gg', d: 'A', last: { verdict: 'go', price_usd: 0.01, networks: ['eip155:8453', 'xrpl:0'] } },
      b: { url: 'https://api.seller.ai/b', m: 'GET', h: 'gn', d: 'B', last: { verdict: 'go', price_usd: 0.02, networks: ['eip155:8453'], unpayable: { 'xrpl:0': 'payTo has no trust line for RLUSD' } } },
      c: { url: 'https://x.run.app/c', m: 'GET', h: 'g', last: { verdict: 'go', networks: ['xrpl:0'] } },
      d: { url: 'https://base.only/d', m: 'GET', h: 'g', last: { verdict: 'go', networks: ['eip155:8453'] } },
      e: { url: 'https://mpp.example/e', p: 'mpp', h: 'g', last: { verdict: 'go', networks: ['xrpl:0'] } },
    },
  };
  const ti = createTrustIndex({ url: 'http://index.test', fetchImpl: async () => new Response(JSON.stringify(index)) });
  const v = await ti.byNetwork('xrpl', { waitMs: 1000 });
  assert.equal(v.endpoints, 3);
  assert.equal(v.payable_now, 2);
  const b = v.resources.find((r) => r.url.endsWith('/b'));
  assert.equal(b.payable, false);
  assert.match(b.problem, /trust line/);
  assert.deepEqual(v.sellers.map((s) => [s.host, s.endpoints, s.payable]), [['seller.ai', 2, 1], ['x.run.app', 1, 1]]);
  assert.equal((await ti.byNetwork('xrpl:0')).endpoints, 3);
  assert.equal((await ti.byNetwork('algorand')).endpoints, 0);
});

test('GET /algorand and /xrpl: the per-network Trust Index pages, linked to each other', async (t) => {
  const { createApp } = require('../server.js');
  const app = createApp({ env: {}, status: { snapshot: async () => ({}) } });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const algo = await (await fetch(`${base}/algorand`)).text();
  assert.match(algo, /<title>x402 on Algorand/);
  assert.match(algo, /\/api\/trust\/network\?network=algorand/);
  assert.match(algo, /opted in to USDC|USDC opt-in/);
  assert.match(algo, /href="\/xrpl"/);
  assert.match(await (await fetch(`${base}/xrpl`)).text(), /href="\/algorand"/);
});
