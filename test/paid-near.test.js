// The Doctor's own paid routes in USDC on NEAR next to the other networks, paid to x402fizzl.near (NEAR_PAY_TO) and
// settled by Doctor's own NEAR facilitator: the same instance /facilitator uses, so one relayer nonce queue and one
// settle-once guard. Off without a relayer, or with NEAR_PAY_TO=off.

process.env.BASE_RPC_URL = 'http://127.0.0.1:1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { KeyPair } = require('@near-js/crypto');
const { createApp } = require('../server');
const { paymentConfig, NEAR } = require('../lib/paid-api');

const NEAR_USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const PAY_TO_BASE = '0x6B0F4651eD42893ab58139938175E4a69f175F25';
const near = { getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: 'exact', network: NEAR }], extensions: [], signers: {} }), verify: async () => ({}), settle: async () => ({}) };

const servers = [];
test.after(() => servers.forEach((s) => s.close()));

test('paymentConfig: USDC on NEAR to x402fizzl.near only with a NEAR facilitator; NEAR_PAY_TO or "off"', () => {
  const env = { AGENT_PAYOUT_WALLET: PAY_TO_BASE };
  assert.equal(NEAR, 'near:mainnet');
  assert.equal(paymentConfig(env).accepts.some((a) => a.network === NEAR), false, 'no relayer: no NEAR option');
  const n = paymentConfig(env, { near }).preflightAccepts.at(-1);
  assert.deepEqual(n, { scheme: 'exact', price: '$0.001', network: NEAR, payTo: 'x402fizzl.near' });
  assert.equal(paymentConfig({ ...env, NEAR_PAY_TO: 'shop.near' }, { near }).accepts.at(-1).payTo, 'shop.near');
  assert.equal(paymentConfig({ ...env, NEAR_PAY_TO: 'off' }, { near }).accepts.some((a) => a.network === NEAR), false);
  assert.equal(paymentConfig(env, { near }).accepts[0].network, 'eip155:8453', 'Base stays first (the paywall offers it)');
});

test('with a relayer configured, the 402 offers USDC on NEAR and /facilitator settles NEAR with the same relayer', async () => {
  const env = { AGENT_PAYOUT_WALLET: PAY_TO_BASE, NEAR_FACILITATOR_ACCOUNT: 'doctorrelay.near', NEAR_FACILITATOR_KEY: KeyPair.fromRandom('ed25519').toString() };
  const app = createApp({ allowPrivate: true, env, bazaarIndex: { lookup: async () => ({ resource: false, origin: false }) } });
  const api = await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    servers.push(server);
  });
  const res = await fetch(`${api}/api/v1/preflight?url=${encodeURIComponent('https://example.com/')}`);
  assert.equal(res.status, 402);
  const challenge = JSON.parse(Buffer.from(res.headers.get('payment-required'), 'base64').toString('utf8'));
  const n = challenge.accepts.find((a) => a.network === NEAR);
  assert.ok(n, `no NEAR option in ${JSON.stringify(challenge.accepts.map((a) => a.network))}`);
  assert.equal(n.asset, NEAR_USDC);
  assert.equal(n.amount, '1000', '$0.001 at 6 decimals');
  assert.equal(n.payTo, 'x402fizzl.near');
  assert.ok(res.headers.get('payment-required').length < 16000, 'the header stays under 16 KB');
  const supported = await (await fetch(`${api}/facilitator/supported`)).json();
  assert.ok(supported.kinds.some((k) => k.network === NEAR), 'the public facilitator still settles NEAR');
});
