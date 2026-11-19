// The facilitator on the owner's usage page: lib/facilitator-usage.js counts settles (per network), sellers and refusals
// from the usage log, and the facilitator service reads its fee payer's SOL.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { facilitatorOf, summarizeFacilitator } = require('../lib/facilitator-usage');
const { parseKnown } = require('../lib/usage-payments');
const { createFacilitatorService } = require('../lib/facilitator-service');

const OURS = 'Ours1111111111111111111111111111111111111111';
const SELLER = 'Seller1111111111111111111111111111111111111';

const settle = (t, { payTo = SELLER, ok = true, via = 'free', reason, payer = 'Buyer1', amount = '10000', status = 200 } = {}) => ({
  t, route: 'facilitator settle', via, status, input: { network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', pay_to: payTo, amount },
  result: { status, ok, reason, payer: ok ? payer : undefined, tx: ok ? `tx${t}` : undefined },
});

test('per file: only facilitator calls, GET steps counted, verify/settle kept as rows; other services skipped', () => {
  const events = [
    { t: '2026-11-18T10:00:00Z', route: 'preflight', status: 200 },
    { t: '2026-11-18T10:00:01Z', route: 'facilitator supported', status: 200, count: 3 },
    { t: '2026-11-18T10:00:02Z', route: 'facilitator info', status: 200 },
    settle('2026-11-18T10:01:00Z'),
    { t: '2026-11-18T10:02:00Z', route: 'facilitator settle', via: 'api', status: 402, quote: true, input: { pay_to: SELLER, amount: '10000' } },
    { t: '2026-11-18T10:03:00Z', route: 'facilitator verify', via: 'api', status: 200, input: { pay_to: SELLER }, result: { ok: true } },
  ];
  const s = facilitatorOf(events, { service: 'doctor' });
  assert.deepEqual(s.calls, { supported: 3, info: 1, settle: 2, verify: 1 });
  assert.equal(s.rows.length, 3);
  assert.equal(s.rows[1].reason, 'facilitator_payment_required');
  assert.deepEqual(facilitatorOf(events, { service: 'presign' }), { calls: {}, rows: [] });
});

test('summary: settles, USDC moved, free vs credits, refusals by reason, our sellers apart from outside ones', () => {
  const files = [
    { summary: facilitatorOf([
      settle('2026-11-17T09:00:00Z', { payTo: OURS }),
      settle('2026-11-18T09:00:00Z', { amount: '20000', via: 'credits', payer: 'Buyer2' }),
      settle('2026-11-18T09:05:00Z'),
      settle('2026-11-18T09:06:00Z', { ok: false, reason: 'sanctioned_address' }),
      settle('2026-11-01T09:00:00Z'), // before the range
    ]) },
  ];
  const known = parseKnown(JSON.stringify({ own_wallets: [OURS] }));
  const f = summarizeFacilitator(files, { known, fromIso: '2026-11-10T00:00:00Z' });
  assert.equal(f.settles.ok, 3);
  assert.equal(f.settles.refused, 1);
  assert.equal(f.settles.usd, 0.04);
  assert.equal(f.settles.free, 2);
  assert.equal(f.settles.credits, 1);
  assert.equal(f.settles.payers, 2);
  assert.deepEqual(f.settles.refused_reasons, [{ reason: 'sanctioned_address', n: 1 }]);
  assert.equal(f.outside_sellers, 1);
  assert.equal(f.outside_settled, 2);
  const seller = f.sellers.find((s) => s.pay_to === SELLER);
  assert.equal(seller.own, false);
  assert.equal(seller.refused, 1);
  assert.equal(seller.usd, 0.03);
  assert.equal(f.sellers.find((s) => s.pay_to === OURS).own, true);
  assert.equal(f.recent[0].t, '2026-11-18T09:06:00Z', 'newest first');
  assert.equal(f.recent.at(-1).own, true);
});

test('fee payer balance: SOL and settles left from getBalance; null when the facilitator is off', async () => {
  const core = { feePayer: async () => 'FeePayer1', getSupported: async () => ({}), verify: async () => ({}), settle: async () => ({}) };
  let asked = null;
  const fetchImpl = async (url, opts) => { asked = { url, body: JSON.parse(opts.body) }; return { json: async () => ({ result: { value: 9500000 } }) }; };
  const svc = createFacilitatorService({ env: { SOLANA_FACILITATOR_RPC_URL: 'https://rpc.test' }, core, sanctions: {}, fetchImpl });
  assert.deepEqual(await svc.feePayerBalance(), { address: 'FeePayer1', sol: 0.0095, settles_left: 1900 });
  assert.equal(asked.url, 'https://rpc.test');
  assert.deepEqual(asked.body.params[0], 'FeePayer1');
  assert.equal(await createFacilitatorService({ env: {}, sanctions: {} }).feePayerBalance(), null);
});

test('per network: Solana and NEAR apart (both listed at zero), a seller per network, verifies counted per network', () => {
  const NEAR = 'near:mainnet';
  const nearSettle = (t, o = {}) => { const e = settle(t, { payTo: 'shop.near', payer: 'buyer.near', ...o }); e.input.network = NEAR; return e; };
  const empty = summarizeFacilitator([], {});
  assert.deepEqual(empty.by_network.map((n) => [n.label, n.ok, n.refused]), [['Solana', 0, 0], ['NEAR', 0, 0]]);
  const files = [{ summary: facilitatorOf([
    settle('2026-11-18T09:00:00Z'),
    nearSettle('2026-11-18T09:01:00Z', { amount: '50000' }),
    nearSettle('2026-11-18T09:02:00Z', { via: 'credits', payer: 'other.near' }),
    nearSettle('2026-11-18T09:03:00Z', { ok: false, reason: 'facilitator_relayer_low' }),
    { t: '2026-11-18T09:04:00Z', route: 'facilitator verify', via: 'api', status: 200, input: { network: NEAR, pay_to: 'shop.near' }, result: { ok: false } },
    { t: '2026-11-18T09:05:00Z', route: 'facilitator settle', via: 'api', status: 400, input: { network: 'eip155:8453', pay_to: '0xabc' }, result: { ok: false, reason: 'unsupported_network' } },
  ]) }];
  const f = summarizeFacilitator(files, {});
  const net = Object.fromEntries(f.by_network.map((n) => [n.label, n]));
  assert.deepEqual([net.Solana.ok, net.Solana.usd, net.Solana.sellers], [1, 0.01, 1]);
  assert.deepEqual([net.NEAR.ok, net.NEAR.refused, net.NEAR.usd, net.NEAR.free, net.NEAR.credits, net.NEAR.payers], [2, 1, 0.06, 1, 1, 2]);
  assert.deepEqual([net.NEAR.sellers, net.NEAR.outside_sellers, net.NEAR.outside_settled, net.NEAR.verify_ok, net.NEAR.verify_invalid], [1, 1, 2, 0, 1]);
  assert.equal(net['eip155:8453'].refused, 1, 'a network we do not serve gets its own row');
  assert.equal(f.sellers.find((s) => s.pay_to === 'shop.near').network, NEAR);
});

test('the live status carries the NEAR Builders Activity counts (null without a reporter that counts)', () => {
  const activity = { stats: () => ({ enabled: true, sent: 4, failed: 1 }), nearPaymentSettled: async () => [] };
  assert.deepEqual(createFacilitatorService({ env: {}, sanctions: {}, activity }).status().activity, { enabled: true, sent: 4, failed: 1 });
  assert.equal(createFacilitatorService({ env: {}, sanctions: {} }).status().activity.enabled, false);
  assert.equal(createFacilitatorService({ env: {}, sanctions: {}, activity: {} }).status().activity, null);
});
