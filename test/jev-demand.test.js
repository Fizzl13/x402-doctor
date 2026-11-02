'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { demandOf, windowOf } = require('../lib/onchain-payments');
const { createDemand, demandNote, labelOf } = require('../lib/jev-demand');

const quiet = { warn() {} };

// Three days: two wallets come back every day, and day 2 has 8 fresh wallets.
function entry() {
  return {
    since: '2026-10-30',
    d: {
      '2026-10-30': [20, 200000, ['aaaaaaaaaa', 'bbbbbbbbbb']],
      '2026-10-31': [300, 3000000, ['aaaaaaaaaa', 'bbbbbbbbbb', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8']],
      '2026-11-01': [40, 400000, ['aaaaaaaaaa', 'bbbbbbbbbb']],
    },
  };
}

test('demandOf: one-day share, returning wallets and payments per wallet per day', () => {
  const d = demandOf(entry(), ['2026-10-30', '2026-10-31', '2026-11-01']);
  assert.deepEqual(d, { paid_days: 3, payers_one_day_pct: 80, payers_every_day: 2, payments_per_payer_day: 25.7 });
  assert.equal(demandOf(entry(), ['2026-10-31']), null, 'one day says nothing about who comes back');
});

test('jev-demand: asks Jev once per window, maps the answer to a label, skips thin traffic', async () => {
  let calls = 0, sent = null;
  const fetch = async (url, opts) => { calls++; sent = JSON.parse(opts.body); return Response.json({ answers: { operators: { noul: 0.86 } } }); };
  const demand = createDemand({ apiKey: 'k', fetch, log: quiet });
  const w = { network: 'eip155:8453', pay_to: '0xabc', as_of: '2026-11-02', days: 7, payments: 479858, payers: 5629, usd: 9595.63, payers_wide: 3, demand: { paid_days: 7, payers_one_day_pct: 87, payers_every_day: 10, payments_per_payer_day: 85.2 } };
  assert.deepEqual(await demand.judge(w), { operators: 0.86, label: 'few_operators' });
  assert.deepEqual(await demand.judge(w), { operators: 0.86, label: 'few_operators' });
  assert.equal(calls, 1, 'cached per window');
  assert.equal(sent.state.payers_one_day_pct, 87);
  assert.ok(sent.questions.operators);
  assert.deepEqual(demand.known(w), { operators: 0.86, label: 'few_operators' });
  assert.equal(await demand.judge({ ...w, pay_to: '0xdef', payers: 3 }), null, 'too few payers to judge');
  assert.equal(calls, 1);
  assert.equal(labelOf(0.2), 'broad');
  assert.equal(labelOf(0.5), 'mixed');
  assert.equal(await createDemand({ apiKey: '', fetch, log: quiet }).judge(w), null, 'off without a key');
  const failing = createDemand({ apiKey: 'k', fetch: async () => new Response('', { status: 500 }), log: quiet });
  assert.equal(await failing.judge(w), null);
  assert.match(demandNote(w, { label: 'few_operators' }), /87% of these wallets paid on one day only, 10 paid every day, 85\.2 payments per wallet per day: this looks more like a few operators/);
  assert.equal(demandNote(w, null), '');
});

test('windowOf carries the demand shape for a multi-day window', () => {
  const state = { network: 'eip155:8453', updated: '2026-11-02T00:00:00Z', days: { '2026-10-30': { covered: 43200 }, '2026-10-31': { covered: 43200 }, '2026-11-01': { covered: 43200 } }, pay_tos: { '0xabc': entry() } };
  const w = windowOf(state, '0xabc');
  assert.equal(w.days, 3);
  assert.deepEqual(w.demand, { paid_days: 3, payers_one_day_pct: 80, payers_every_day: 2, payments_per_payer_day: 25.7 });
});
