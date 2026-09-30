const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { createSigner } = require('../lib/receipt');
const { createOutcomes, outcomeReason, parseReport } = require('../lib/outcomes');

const env = { RECEIPT_SIGNER_SECRET: 'test-secret-for-outcome-reports-0123456789abcdef', RECEIPT_SIGNER_CERT: '' };
const signer = createSigner(env);
const other = createSigner({ RECEIPT_SIGNER_SECRET: 'another-secret-that-is-not-doctors-0123456789abcd' });
const ENDPOINT = 'https://api.example.com/paid';

// A paid preflight as Doctor signs it, bought by `payer`.
async function preflightFor(url = ENDPOINT, { verdict = 'go', payer = '0xaaa', by = signer } = {}) {
  const query = { url, method: 'GET', max_usd: '0.05', network: 'eip155:8453' };
  const body = await by.sign({ url, method: 'GET', verdict, summary: 'OK', reasons: [] }, { route: 'GET /api/v1/preflight', input: query, payment: { network: 'eip155:8453', payer, nonce: '0x1' } });
  return { preflight: body, query };
}

function make({ events = [] } = {}) {
  const recorded = [];
  const outcomes = createOutcomes({ usageReader: { load: async () => ({ events }) }, record: (e) => recorded.push(e), signers: () => signer.signers });
  return { outcomes, recorded };
}

test('a report with a valid signed preflight is counted once and logged without secrets', async () => {
  const { outcomes, recorded } = make();
  const { preflight, query } = await preflightFor();
  const r = await outcomes.report({ outcome: 'paid_failed', status: 402, preflight, query }, { agent: 'x402-safe-fetch/0.5.0' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.accepted, true);
  assert.deepStrictEqual(r.body.endpoint, { url: ENDPOINT, reports: 1, failed: 1, failed_payers: 1 });
  assert.strictEqual(recorded.length, 1);
  assert.deepStrictEqual(recorded[0].input, { url: ENDPOINT, outcome: 'paid_failed', status: 402, verdict: 'go', request_id: preflight.receipt.request_id, payer: '0xaaa' });
  assert.strictEqual(recorded[0].route, 'outcome');
  const again = await outcomes.report({ outcome: 'paid_failed', status: 402, preflight, query });
  assert.deepStrictEqual(again.body, { accepted: false, duplicate: true });
  assert.deepStrictEqual(outcomes.lookup(ENDPOINT), { reports: 1, failed: 1, failed_payers: 1 });
});

test('reports that are not backed by a real preflight for that endpoint are refused', async () => {
  const { outcomes } = make();
  const forged = await preflightFor(ENDPOINT, { by: other });
  assert.strictEqual((await outcomes.report({ outcome: 'paid_failed', ...forged })).status, 400);
  const real = await preflightFor();
  // the query must be the one the receipt covers
  assert.strictEqual((await outcomes.report({ outcome: 'paid_failed', preflight: real.preflight, query: { ...real.query, url: 'https://other.example.com/x' } })).status, 400);
  // a flipped verdict breaks the signature
  assert.strictEqual((await outcomes.report({ outcome: 'paid_ok', preflight: { ...real.preflight, verdict: 'caution' }, query: real.query })).status, 400);
  const noGo = await preflightFor(ENDPOINT, { verdict: 'no_go' });
  assert.match((await outcomes.report({ outcome: 'paid_ok', ...noGo })).body.error, /go or caution/);
  assert.match(parseReport({ outcome: 'lost', preflight: {}, query: {} }).error, /outcome must be/);
  assert.deepStrictEqual(outcomes.lookup(ENDPOINT), null);
});

test('the caution needs failed payments from at least three different wallets, and a failing majority', async () => {
  const { outcomes } = make();
  for (const payer of ['0x1', '0x1', '0x1', '0x1']) {
    await outcomes.report({ outcome: 'paid_failed', ...(await preflightFor(ENDPOINT, { payer })) });
  }
  assert.strictEqual(outcomeReason(outcomes.lookup(ENDPOINT)), null); // one wallet alone
  for (const payer of ['0x2', '0x3']) await outcomes.report({ outcome: 'paid_error', ...(await preflightFor(ENDPOINT, { payer })) });
  const reason = outcomeReason(outcomes.lookup(ENDPOINT));
  assert.strictEqual(reason.level, 'caution');
  assert.strictEqual(reason.code, 'payments_fail_after_preflight');
  assert.match(reason.message, /6 of 6 payments .* \(3 different wallets\)/);
  for (let i = 0; i < 7; i++) await outcomes.report({ outcome: 'paid_ok', ...(await preflightFor(ENDPOINT, { payer: `0xok${i}` })) });
  assert.strictEqual(outcomeReason(outcomes.lookup(ENDPOINT)), null); // most payments work
});

test('counts are rebuilt from the usage log (30 days), deduplicated by preflight', async () => {
  const ev = (id, outcome, payer) => ({ route: 'outcome', input: { url: ENDPOINT, outcome, request_id: id, payer }, result: { accepted: true } });
  const { outcomes } = make({ events: [ev('a', 'paid_failed', '0x1'), ev('a', 'paid_failed', '0x1'), ev('b', 'paid_failed', '0x2'), ev('c', 'paid_ok', '0x3'), { route: 'preflight', input: { url: ENDPOINT } }] });
  await outcomes.refresh();
  assert.deepStrictEqual(outcomes.lookup(ENDPOINT), { reports: 3, failed: 2, failed_payers: 2 });
});

test('POST /api/v1/outcome on the app: a signed report is accepted, a bare one refused', async () => {
  const { createApp } = require('../server');
  const app = createApp({ env: { ...env, USAGE_LOG_TOKEN: '' }, usageReader: { load: async () => ({ events: [] }) } });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { preflight, query } = await preflightFor();
    const res = await fetch(`${base}/api/v1/outcome`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'x402-safe-fetch/0.5.0' }, body: JSON.stringify({ outcome: 'paid_ok', status: 200, preflight, query }) });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).accepted, true);
    const bad = await fetch(`${base}/api/v1/outcome`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ outcome: 'paid_ok' }) });
    assert.strictEqual(bad.status, 400);
  } finally { server.close(); }
});
