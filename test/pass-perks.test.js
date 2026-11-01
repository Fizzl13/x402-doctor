// Fizzl Pass extras (lib/pass-perks.js): Silver 1 and Gold 3 free delivery checks a month, ordered with the
// X-Fizzl-Pass header and no payment; the check before payment first, a refused endpoint or an error uses none.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const express = require('express');
const { createPassVerifier } = require('../lib/fizzl-pass');
const { createPassPerks, memoryPerks, redisPerks, DELIVERY_CHECKS } = require('../lib/pass-perks');
const { createDelivery, memoryStore } = require('../lib/delivery-checks');

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const jwks = { keys: [{ kty: 'OKP', crv: 'Ed25519', kid: 'k', x: publicKey.export({ format: 'jwk' }).x }] };
const proof = (tier, wallet = '0x1111111111111111111111111111111111111111') => { const b = `fzp1.${Buffer.from(JSON.stringify({ kid: 'k', tier, until: Date.now() + 86400000, wallets: [wallet] })).toString('base64url')}`; return `${b}.${crypto.sign(null, Buffer.from(b), privateKey).toString('base64url')}`; };
const go = async () => ({ verdict: 'go', summary: 'OK to pay: $0.02', recommended_option: 0, options: [{ network: 'eip155:8453', usd: 0.02 }], reasons: [] });
const noGo = async () => ({ verdict: 'no_go', summary: 'Do not pay: the endpoint does not answer 402', recommended_option: null, options: [], reasons: [{ level: 'no_go', code: 'no_402', message: 'no 402' }] });

// Like lib/paid-api.js: the check before payment, the pass's free checks, a paywall (402 unless paid), the order.
async function app({ store = memoryStore(), perkStore = memoryPerks(), runPreflight = go, now } = {}) {
  const d = createDelivery({ express, store, results: null, runPreflight, publicUrl: 'https://doctor.test' });
  const perks = createPassPerks({ pass: createPassVerifier({ keys: jwks }), store: perkStore, ...(now ? { now } : {}) });
  const a = express();
  a.use(d.free);
  a.get('/api/v1/pass/perks', perks.status());
  a.get('/api/v1/delivery-check', d.validate);
  a.get('/api/v1/delivery-check', perks.deliveryChecks());
  a.use((req, res, next) => (req.fizzlCredits ? next() : res.status(402).json({ error: 'payment required' })));
  a.get('/api/v1/delivery-check', d.order);
  const server = await new Promise((ok) => { const s = a.listen(0, '127.0.0.1', () => ok(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const order = (target, headers = {}) => fetch(`${url}/api/v1/delivery-check?url=${encodeURIComponent(target)}`, { headers });
  return { url, order, store, close: () => server.close() };
}

test('Gold: three free checks a month, queued and released at once; the fourth gets the 402; Bronze gets none', async () => {
  const s = await app();
  try {
    const gold = { 'x-fizzl-pass': proof('gold') };
    for (let i = 1; i <= DELIVERY_CHECKS.gold; i++) {
      const r = await s.order(`https://a${i}.example/x`, gold);
      assert.equal(r.status, 200, `check ${i}`);
      assert.equal(r.headers.get('x-fizzl-pass-delivery-checks'), `${DELIVERY_CHECKS.gold - i} of 3 left this month`);
      const job = await r.json();
      await new Promise((ok) => setTimeout(ok, 30));
      const stored = await s.store.get(job.id);
      assert.deepEqual([stored.settled, stored.payment_tx], [true, 'fizzl-pass-gold'], 'released to the queue without a payment');
    }
    const fourth = await s.order('https://a4.example/x', gold);
    assert.equal(fourth.status, 402, 'none left: the normal payment');
    assert.equal(fourth.headers.get('x-fizzl-pass-delivery-checks'), '0 of 3 left this month');
    assert.equal((await s.order('https://b.example/x', { 'x-fizzl-pass': proof('bronze', '0x2222222222222222222222222222222222222222') })).status, 402, 'Bronze has no free checks');
    assert.equal((await s.order('https://b.example/x', { 'x-fizzl-pass': 'fzp1.bogus.bogus' })).status, 402, 'a bad proof pays normally');
    const left = await (await fetch(`${s.url}/api/v1/pass/perks`, { headers: gold })).json();
    assert.deepEqual(left.delivery_checks, { per_month: 3, used: 3, left: 0 });
  } finally { s.close(); }
});

test('Silver: one a month; a refused endpoint uses none; a new month starts again', async () => {
  let t = Date.parse('2026-11-30T12:00:00Z');
  const s = await app({ runPreflight: async (u) => (u.includes('broken') ? noGo() : go()), now: () => t });
  try {
    const silver = { 'x-fizzl-pass': proof('silver', '0x3333333333333333333333333333333333333333') };
    const refused = await s.order('https://broken.example/x', silver);
    assert.equal(refused.status, 400, 'the check before payment answers first');
    assert.equal((await s.order('https://ok.example/x', silver)).status, 200, 'the refused one used none');
    assert.equal((await s.order('https://ok2.example/x', silver)).status, 402);
    t = Date.parse('2026-12-01T00:00:05Z');
    assert.equal((await s.order('https://ok3.example/x', silver)).status, 200, 'December: one again');
  } finally { s.close(); }
});

// Needs redis-server on the machine (not on GitHub's runners): skipped without it.
const hasRedis = !spawnSync('redis-server', ['--version']).error;
test('the Redis counter: atomic, never above the month\'s checks, given back on an error', { skip: !hasRedis && 'redis-server not installed' }, async (t) => {
  const port = await new Promise((ok) => { const srv = net.createServer().listen(0, () => { const p = srv.address().port; srv.close(() => ok(p)); }); });
  const proc = spawn('redis-server', ['--port', String(port), '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
  proc.unref();
  t.after(() => proc.kill());
  const { createClient } = require('redis');
  const client = createClient({ url: `redis://127.0.0.1:${port}` });
  for (let i = 0; i < 50; i++) { try { await client.connect(); break; } catch { await new Promise((ok) => setTimeout(ok, 100)); } }
  const store = redisPerks(() => client);
  assert.equal(store.ready, true);
  const results = await Promise.all(Array.from({ length: 6 }, () => store.use('delivery:0xabc:2026-11', 3)));
  assert.equal(results.filter((r) => r.ok).length, 3, 'six at once, three granted');
  assert.equal(await store.used('delivery:0xabc:2026-11'), 3);
  await store.giveBack('delivery:0xabc:2026-11');
  assert.equal(await store.used('delivery:0xabc:2026-11'), 2);
  assert.ok(await client.ttl('fizzl-perks:delivery:0xabc:2026-11') > 30 * 86400, 'kept about 40 days');
  await client.quit();
});
