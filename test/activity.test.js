// NEAR Builders Activity reports (lib/activity.js): what is sent, when nothing is sent, and that a failing report
// never breaks anything. The facilitator path (a real settle reporting both events) is in near-facilitator.test.js.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createActivityReporter, ACTIVITY_URL } = require('../lib/activity');

const quiet = { log() {}, error() {} };
const TX = 'GJ2rWJ6b5o3Qpt8ZJG9FVDdLzA5eJ8tR3W4aBk1C7nHx';
const pay = { payer: 'buyer.near', payTo: 'shop.near', transaction: TX, amount: '10000', asset: 'usdc', network: 'near:mainnet' };

function stand({ answers = [] } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const a = answers.length ? answers.shift() : 200;
    if (a instanceof Error) throw a;
    return { ok: a < 300, status: a, json: async () => ({ eventId: `ev${calls.length}` }), text: async () => 'nope' };
  };
  return { calls, fetchImpl };
}

test('a settled NEAR payment reports payment.settled for the buyer and payment.received for the payTo', async () => {
  const s = stand();
  const a = createActivityReporter({ env: { ACTIVITY_API_KEY: 'act_test' }, fetchImpl: s.fetchImpl, log: quiet });
  assert.deepEqual(await a.nearPaymentSettled(pay), ['ev1', 'ev2']);
  assert.equal(s.calls[0].url, ACTIVITY_URL);
  assert.equal(s.calls[0].headers.authorization, 'Bearer act_test');
  assert.deepEqual(s.calls.map((c) => [c.body.eventType, c.body.actor, c.body.idempotencyKey]), [
    ['payment.settled', 'buyer.near', `near:mainnet:${TX}:settled`],
    ['payment.received', 'shop.near', `near:mainnet:${TX}:received`],
  ]);
  assert.deepEqual(s.calls[0].body.payload, { network: 'near:mainnet', transaction: TX, asset: 'usdc', amount: '10000' });
  assert.deepEqual(a.stats(), { enabled: true, sent: 2, failed: 0 });
});

test('no key, no transaction, or no NEAR account: nothing is sent; paying yourself is one event', async () => {
  const s = stand();
  assert.deepEqual(await createActivityReporter({ env: {}, fetchImpl: s.fetchImpl, log: quiet }).nearPaymentSettled(pay), []);
  const a = createActivityReporter({ env: { ACTIVITY_API_KEY: 'k' }, fetchImpl: s.fetchImpl, log: quiet });
  await a.nearPaymentSettled({ ...pay, transaction: '' });
  await a.nearPaymentSettled({ ...pay, payer: 'Not Valid', payTo: '' });
  assert.equal(s.calls.length, 0);
  await a.nearPaymentSettled({ ...pay, payTo: 'buyer.near' });
  assert.deepEqual(s.calls.map((c) => c.body.eventType), ['payment.settled']);
});

test('a 503 or a network error is retried with the same body; a 401 or a third failure is logged, never thrown', async () => {
  const errors = [];
  const log = { log() {}, error: (m) => errors.push(m) };
  const s = stand({ answers: [503, new Error('reset'), 200, 401] });
  const a = createActivityReporter({ env: { ACTIVITY_API_KEY: 'act_secret' }, fetchImpl: s.fetchImpl, log, retryMs: [0, 0], sleep: async () => {} });
  const out = await a.nearPaymentSettled(pay);
  assert.deepEqual(out, ['ev3', null]);
  assert.deepEqual(s.calls[0].body, s.calls[2].body, 'the retry sends the same body');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /payment\.received for shop\.near not reported: 401/);
  assert.ok(!errors[0].includes('act_secret'), 'the key is never logged');
  const s2 = stand({ answers: [409] });
  assert.deepEqual(await createActivityReporter({ env: { ACTIVITY_API_KEY: 'k' }, fetchImpl: s2.fetchImpl, log: quiet }).nearPaymentSettled({ ...pay, payTo: 'buyer.near' }), [null]);
});
