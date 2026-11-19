// The NEAR facilitator (lib/near-facilitator.js) behind /facilitator (lib/facilitator-service.js): a buyer signs a
// real NEP-366 SignedDelegate with @x402/near's own client, a seller's resource server sends it to Doctor over HTTP,
// and Doctor verifies and settles it through its relayer against a stand-in chain (no network, no money). Also:
// each payment settles once, settles go one at a time, a relayer low on NEAR stops settling, NEAR settles have their
// own free tier and cost 2 credits, and /supported lists Solana and NEAR together.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { KeyPair } = require('@near-js/crypto');
const { x402ResourceServer } = require('@x402/core/server');
const { ExactNearScheme: NearServer } = require('@x402/near/exact/server');
const { ExactNearScheme: NearClient } = require('@x402/near/exact/client');
const { ExactNearScheme: NearFacilitatorScheme } = require('@x402/near/exact/facilitator');
const { createClientNearSigner } = require('@x402/near');
const credits = require('../lib/credits');
const { createNearFacilitator, nearConfig, NEAR_MAINNET, NEAR_USDC } = require('../lib/near-facilitator');
const { createFacilitatorService, USDC_MINT } = require('../lib/facilitator-service');

const RELAYER = 'relay.fizzl.near';
const SELLER = 'shop.near';
const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const quiet = { log() {}, error() {} };

const sanctions = (listed = []) => ({ enabled: true, ready: async () => ({ published: '2026-11-19' }), check: (a) => ({ listed: listed.includes(a), entries: [] }) });

// A stand-in NEAR chain for the relayer (what it reads, what it submitted) and a JSON-RPC server for the buyer's client.
function chain({ registered = true, slowMs = 0 } = {}) {
  const state = { height: 200_000_000n, nonce: 41n, submitted: [], inFlight: 0, maxInFlight: 0 };
  const signer = {
    getRelayerIds: () => [RELAYER],
    getCurrentBlockHeight: async () => state.height,
    viewAccount: async ({ accountId }) => (accountId === NEAR_USDC ? { codeHash: '9xEfaCt' } : { codeHash: '11111111111111111111111111111111' }),
    viewAccessKey: async () => ({ nonce: state.nonce, permissionKind: 'FullAccess' }),
    ftBalanceOf: async () => 1_000_000n,
    storageBalanceOf: async () => ({ supported: true, registered }),
    submitSignedDelegateAction: async (input) => {
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      await new Promise((r) => setTimeout(r, slowMs));
      state.inFlight--;
      state.submitted.push(input);
      return { transaction: `NearTx${state.submitted.length}`, innerReceipt: { kind: 'success', value: '' } };
    },
  };
  const rpc = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const { id, method, params } = JSON.parse(raw);
      const hash = 'GJ2rWJ6b5o3Qpt8ZJG9FVDdLzA5eJ8tR3W4aBk1C7nHx';
      const result = method === 'block'
        ? { header: { height: Number(state.height), hash } }
        : params?.request_type === 'view_access_key'
          ? { nonce: Number(state.nonce), permission: 'FullAccess', block_height: Number(state.height), block_hash: hash }
          : null;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  return { state, signer, rpc };
}

// The relayer's balance as FastNEAR would answer view_account.
const balanceFetch = (near) => async () => ({ json: async () => ({ jsonrpc: '2.0', id: 1, result: { amount: (BigInt(Math.round(near * 10000)) * 10n ** 20n).toString() } }) });

async function serve(service) {
  const app = express();
  app.use(service.router(express));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (path, b, headers = {}) => fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(b) });
  return { url, post, close: () => server.close() };
}

// The $0.01 requirement a seller's resource server builds for USDC on NEAR, and a buyer's signed payment for it.
async function signedPayment(rpcUrl, { price = '$0.01', payTo = SELLER } = {}) {
  const resource = new x402ResourceServer([{ getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: 'exact', network: NEAR_MAINNET }], extensions: [], signers: {} }) }]).register(NEAR_MAINNET, new NearServer());
  await resource.initialize();
  const [req] = await resource.buildPaymentRequirements({ scheme: 'exact', price, network: NEAR_MAINNET, payTo });
  const buyer = createClientNearSigner({ accountId: 'buyer.near', secretKey: KeyPair.fromRandom('ed25519').toString(), rpcUrls: { [NEAR_MAINNET]: rpcUrl } });
  const partial = await new NearClient(buyer).createPaymentPayload(2, req);
  return { x402Version: 2, paymentPayload: { x402Version: 2, accepted: req, payload: partial.payload }, paymentRequirements: req };
}

async function setup({ registered, slowMs, near = 0.5, ...opts } = {}) {
  const c = chain({ registered, slowMs });
  await new Promise((r) => c.rpc.listen(0, '127.0.0.1', r));
  const rpcUrl = `http://127.0.0.1:${c.rpc.address().port}`;
  const nearCore = createNearFacilitator({ accountId: RELAYER, secretKey: KeyPair.fromRandom('ed25519').toString(), scheme: new NearFacilitatorScheme(c.signer), fetchImpl: balanceFetch(near), log: quiet });
  const svc = createFacilitatorService({ env: {}, nearCore, sanctions: sanctions(opts.listed), log: quiet, ...opts });
  const s = await serve(svc);
  return { ...c, rpcUrl, svc, s, close: () => { s.close(); c.rpc.close(); } };
}

test('nearConfig: on only with a relayer account and key; a malformed one throws', () => {
  const key = KeyPair.fromRandom('ed25519').toString();
  assert.equal(nearConfig({}), null);
  assert.equal(nearConfig({ NEAR_FACILITATOR_ACCOUNT: RELAYER }), null);
  assert.deepEqual(nearConfig({ NEAR_FACILITATOR_ACCOUNT: RELAYER, NEAR_FACILITATOR_KEY: key }), { accountId: RELAYER, secretKey: key, rpcUrl: 'https://rpc.mainnet.fastnear.com' });
  assert.throws(() => nearConfig({ NEAR_FACILITATOR_ACCOUNT: 'Not An Account', NEAR_FACILITATOR_KEY: key }), /not a NEAR account id/);
  assert.throws(() => nearConfig({ NEAR_FACILITATOR_ACCOUNT: RELAYER, NEAR_FACILITATOR_KEY: 'hunter2' }), /secret key like ed25519/);
});

test('a buyer\'s signed delegate for $0.01 verifies and settles over HTTP through our relayer, once', async () => {
  const t = await setup();
  try {
    const pay = await signedPayment(t.rpcUrl);
    assert.equal(pay.paymentRequirements.asset, NEAR_USDC);
    assert.equal(pay.paymentRequirements.amount, '10000');
    const v = await (await t.s.post('/facilitator/verify', pay)).json();
    assert.equal(v.isValid, true, JSON.stringify(v));
    assert.equal(v.payer, 'buyer.near');
    const r = await t.s.post('/facilitator/settle', pay);
    const out = await r.json();
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(out.transaction, 'NearTx1');
    assert.equal(r.headers.get('x-facilitator-billing'), 'free');
    assert.equal(t.state.submitted[0].relayerId, RELAYER);
    const again = await (await t.s.post('/facilitator/settle', pay)).json();
    assert.equal(again.success, false);
    assert.equal(again.errorReason, 'duplicate_settlement', 'the same payment does not settle twice');
    assert.equal(t.state.submitted.length, 1);
    assert.equal(t.svc.status().near.settled, 1);
  } finally { t.close(); }
});

test('a payTo not registered on USDC, or a listed buyer, is refused before anything is sent; the free settle comes back', async () => {
  const t = await setup({ registered: false, nearFreePerDay: 1 });
  try {
    const out = await (await t.s.post('/facilitator/settle', await signedPayment(t.rpcUrl))).json();
    assert.equal(out.success, false);
    assert.equal(t.state.submitted.length, 0);
  } finally { t.close(); }
  const l = await setup({ listed: ['buyer.near'] });
  try {
    const out = await (await l.s.post('/facilitator/settle', await signedPayment(l.rpcUrl))).json();
    assert.equal(out.errorReason, 'sanctioned_address');
    assert.equal(l.state.submitted.length, 0);
  } finally { l.close(); }
});

test('a relayer low on NEAR stops settling before anything is sent', async () => {
  const t = await setup({ near: 0.01 });
  try {
    const out = await (await t.s.post('/facilitator/settle', await signedPayment(t.rpcUrl))).json();
    assert.equal(out.success, false);
    assert.equal(out.errorReason, 'facilitator_relayer_low');
    assert.equal(t.state.submitted.length, 0);
    assert.deepEqual(await t.svc.relayerBalance(), { account: RELAYER, near: 0.01 });
  } finally { t.close(); }
});

test('settles go one at a time (the relayer\'s nonce)', async () => {
  const t = await setup({ slowMs: 40 });
  try {
    const pays = await Promise.all([1, 2, 3].map(() => signedPayment(t.rpcUrl)));
    const outs = await Promise.all(pays.map(async (p) => (await t.s.post('/facilitator/settle', p)).json()));
    assert.deepEqual(outs.map((o) => o.success), [true, true, true]);
    assert.equal(t.state.maxInFlight, 1);
  } finally { t.close(); }
});

test('NEAR has its own free settles per payTo, then 2 credits a settle', async () => {
  const store = credits.memoryStore();
  const key = credits.newKey();
  await store.issue(credits.hashKey(key), 3, 365);
  const t = await setup({ nearFreePerDay: 1, creditStore: store });
  try {
    assert.equal((await t.s.post('/facilitator/settle', await signedPayment(t.rpcUrl))).status, 200);
    const over = await t.s.post('/facilitator/settle', await signedPayment(t.rpcUrl));
    assert.equal(over.status, 402);
    assert.match((await over.json()).errorMessage, /2 credits \(\$0\.002\) a settle/);
    const paid = await t.s.post('/facilitator/settle', await signedPayment(t.rpcUrl), { 'x-credit-key': key });
    assert.equal(paid.status, 200);
    assert.equal(paid.headers.get('x-facilitator-billing'), 'credits');
    assert.equal((await store.balance(credits.hashKey(key))).credits, 1);
    const short = await (await t.s.post('/facilitator/settle', await signedPayment(t.rpcUrl), { 'x-credit-key': key })).json();
    assert.equal(short.errorReason, 'facilitator_credits_insufficient');
  } finally { t.close(); }
});

test('NEAR alone: Solana and other assets are refused; with both, /supported lists both and info names the relayer', async () => {
  const t = await setup();
  try {
    const sol = { x402Version: 2, paymentPayload: { x402Version: 2, payload: {} }, paymentRequirements: { scheme: 'exact', network: SOLANA, asset: USDC_MINT, amount: '1', payTo: 'x' } };
    assert.equal((await (await t.s.post('/facilitator/settle', sol)).json()).errorReason, 'unsupported_network');
    const pay = await signedPayment(t.rpcUrl);
    pay.paymentRequirements = { ...pay.paymentRequirements, asset: 'wrap.near' };
    assert.equal((await (await t.s.post('/facilitator/settle', pay)).json()).errorReason, 'unsupported_asset');
  } finally { t.close(); }

  const solanaCore = {
    network: SOLANA,
    feePayer: async () => 'FeePayer11111111111111111111111111111111111',
    getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: 'exact', network: SOLANA, extra: { feePayer: 'FeePayer11111111111111111111111111111111111' } }], extensions: [], signers: { 'solana:*': ['FeePayer11111111111111111111111111111111111'] } }),
    verify: async () => ({ isValid: true, payer: 'Buyer' }),
    settle: async () => ({ success: true, transaction: 'soltx', network: SOLANA, payer: 'Buyer' }),
  };
  const c = chain();
  const nearCore = createNearFacilitator({ accountId: RELAYER, secretKey: KeyPair.fromRandom('ed25519').toString(), scheme: new NearFacilitatorScheme(c.signer), fetchImpl: balanceFetch(0.5), log: quiet });
  const both = await serve(createFacilitatorService({ env: {}, core: solanaCore, nearCore, sanctions: sanctions(), log: quiet }));
  try {
    const sup = await (await fetch(`${both.url}/facilitator/supported`)).json();
    assert.deepEqual(sup.kinds.map((k) => k.network).sort(), [NEAR_MAINNET, SOLANA].sort());
    const info = await (await fetch(`${both.url}/facilitator`)).json();
    assert.deepEqual(info.networks, [SOLANA, NEAR_MAINNET]);
    assert.equal(info.near.relayer, RELAYER);
    assert.match(info.pricing.settle_near, /5 free a day per payTo, then 2 credits/);
    assert.match(info.fee_payer, /^FeePayer/);
  } finally { both.close(); }
});

test('a NEAR settle is reported to NEAR Builders Activity after the answer; a refused one is not', async () => {
  const sent = [];
  const activity = { nearPaymentSettled: async (e) => { sent.push(e); throw new Error('Activity down'); } };
  const t = await setup({ activity });
  try {
    const pay = await signedPayment(t.rpcUrl);
    const out = await (await t.s.post('/facilitator/settle', pay)).json();
    assert.equal(out.success, true, 'a failing report does not break the settle');
    assert.deepEqual(sent, [{ payer: 'buyer.near', payTo: SELLER, transaction: 'NearTx1', amount: '10000', asset: NEAR_USDC, network: NEAR_MAINNET }]);
    await (await t.s.post('/facilitator/settle', pay)).json(); // duplicate: refused
    assert.equal(sent.length, 1);
  } finally { t.close(); }
});
