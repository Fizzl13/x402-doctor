// XRP next to RLUSD on the XRP Ledger (Doctor and Fizzl Buy): drops at the pool's rate, none without a rate, not over MCP.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createXrpRate, dropsFor, rateOfPool, sharedXrpRate, RLUSD_HEX, RLUSD_ISSUER } = require('../lib/xrp-rate');
const { usdOf } = require('../lib/usage-log');
const { paymentConfig } = require('../lib/paid-api');

const quiet = { warn() {} };
const PROD = { DOCTOR_PAYOUT_WALLET: '0x6B0F4651eD42893ab58139938175E4a69f175F25', XRPL_PAY_TO: 'r9xmBsRr8Ao7jRgjjxreMiAwGiCK2FGwqw' };

test('dropsFor and rateOfPool', () => {
  assert.equal(dropsFor('$0.001', 0.92), '1090');
  assert.equal(dropsFor('$0.25', 0.92), '272000');
  assert.equal(rateOfPool({ amount: '2000000000', amount2: { currency: RLUSD_HEX, issuer: RLUSD_ISSUER, value: '1840' } }), 0.92);
  assert.equal(rateOfPool({ amount: '2000000000', amount2: { currency: RLUSD_HEX, issuer: 'rOther', value: '1840' } }), null);
});

test('the rate holds within 2% and the price function gives drops, or null without a rate', async () => {
  let pool = null;
  let t = 0;
  const rate = createXrpRate({ read: async () => pool, now: () => t, log: quiet });
  assert.equal(rate.price('$0.001')(), null);
  await new Promise((r) => setImmediate(r)); // the reading that call started (no pool yet)
  pool = 0.92;
  t += 11 * 60 * 1000;
  await rate.refresh();
  assert.deepEqual(rate.price('$0.001')(), { amount: '1090', asset: 'XRP' });
  pool = 0.93; // +1.1%: kept
  t += 11 * 60 * 1000;
  await rate.refresh();
  assert.equal(rate.usdPerXrp(), 0.92);
  t += 61 * 60 * 1000; // stale: no XRP option
  rate.refresh = () => {};
  assert.equal(rate.price('$0.001')(), null);
});

test('paymentConfig: an XRP option after RLUSD, off with XRPL_XRP=off', () => {
  const xrpl = paymentConfig(PROD).accepts.filter((a) => a.network === 'xrpl:0');
  assert.equal(xrpl.length, 2);
  assert.equal(xrpl[0].price, '$0.01');
  assert.equal(typeof xrpl[1].price, 'function');
  assert.equal(xrpl[1].extra.invoiceId, 'x402-doctor.fizzl.eu');
  assert.equal(paymentConfig({ ...PROD, XRPL_XRP: 'off' }).accepts.filter((a) => a.network === 'xrpl:0').length, 1);
});

test('usage log: XRP in dollars only with a rate', () => {
  assert.equal(usdOf({ network: 'xrpl:0', asset: RLUSD_HEX, amount: '0.001' }), 0.001);
  assert.equal(sharedXrpRate().usdOfDrops('1090'), null);
  assert.equal(usdOf({ network: 'xrpl:0', asset: 'XRP', amount: '1090' }), null);
});
