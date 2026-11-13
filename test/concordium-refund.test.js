const { test } = require('node:test');
const assert = require('node:assert');
const { receiptMemo } = require('../lib/concordium-receipt');
const { refundMemo, refundAmount, termsOf, checkRefund, checkRefundTx, findCcdRefund, createRefunds } = require('../lib/concordium-refund');
const { createOutcomes } = require('../lib/outcomes');

const MAINNET = 'ccd:9dd9ca4d19e9393877d2c44b70f89acb';
const SELLER = '45R4vB9JnXDUkYVNBrQE8yyg6o2qH32g7fX5N7i9yWxHxnFP7J';
const BUYER = '4qqrSf3Ca8SnbsxGDQSVritpBULxGPPRzB6bVFB3KNzLkeoVoq';
const OTHER = '4HxSuKYFJw4wZaDFt3buyTTX7kogz3SxWTnXwvBDAHbq9poqQJ';
const TX = '60d661e8538f564ed4743030176f16271b1e6b6797a924043d7ff51f84dac815';
const BACK = 'a5b1a6170e3e1ae01f9e8413ad2760ba2daac682e6a434697b4403b33a947ecf';
const ENDPOINT = 'https://api.example.com/paid';
const receipt = (over = {}) => ({ kind: 'x402-concordium-receipt', v: 1, network: MAINNET, asset: 'CCD', amount: '16000000', payTo: SELLER, resource: ENDPOINT, ticket: 'abcdefghijklmnop1234', ...over });
const transfer = (over = {}, t = {}) => ({ finalized: true, success: true, sender: SELLER, transfers: [{ asset: 'CCD', to: BUYER, amount: '16000000', memo: null, ...t }], ...over });

// A memo as Concordium wallets write it: CBOR text, wrapped as an embedded CBOR item (tag 24 around a byte string).
function cborMemo(text) {
  const t = Buffer.from(text, 'utf8');
  const inner = Buffer.concat([Buffer.from([0x78, t.length]), t]);
  return Buffer.concat([Buffer.from([0xd8, 0x18, 0x58, inner.length]), inner]).toString('hex');
}

test('the refund memo commits to the same fingerprint as the payment memo, under its own prefix', () => {
  const r = receipt({ resource: 'https://x.example/a', amount: '1000', payTo: SELLER });
  // the same receipt as concordium-facilitator/src/receipt.js refundMemo (Fizzl13/x402-examples) and its payment memo
  assert.strictEqual(receiptMemo(r).slice('x402r:'.length), refundMemo(r).slice('x402refund:'.length));
  assert.match(refundMemo(r), /^x402refund:[0-9a-f]{64}$/);
  assert.deepStrictEqual(termsOf(r), { network: MAINNET, asset: 'CCD', amount: '1000', payTo: SELLER, memo: refundMemo(r) });
});

test('the amount to send back reads as whole CCD; a PLT stays in its smallest unit', () => {
  assert.strictEqual(refundAmount('16000000', 'CCD'), '16 CCD (16000000 microCCD)');
  assert.strictEqual(refundAmount('1000', 'CCD'), '0.001 CCD (1000 microCCD)');
  assert.strictEqual(refundAmount('1500000', 'ccd'), '1.5 CCD (1500000 microCCD)');
  assert.strictEqual(refundAmount('50000', 'USDR'), "50000 in USDR's smallest unit");
});

test('a refund: from the account paid, to the account that paid, same asset, at least the amount; one memo names one purchase', () => {
  const r = receipt();
  assert.deepStrictEqual(checkRefund(r, BUYER, transfer({}, { memo: refundMemo(r) })), { valid: true, matchedBy: 'memo', amount: '16000000', time: null });
  assert.strictEqual(checkRefund(r, BUYER, transfer()).matchedBy, 'amount', 'without the memo, the amount back counts too');
  assert.strictEqual(checkRefund(r, BUYER, transfer({}, { amount: '20000000' })).valid, true, 'more back is a refund');
  assert.match(checkRefund(r, BUYER, transfer({}, { amount: '15999999' })).reason, /less than was paid/);
  assert.match(checkRefund(r, BUYER, transfer({}, { amount: '32000001' })).reason, /more than twice what was paid/, 'far more back without the memo is something else (a top-up)');
  assert.strictEqual(checkRefund(r, BUYER, transfer({}, { amount: '1000000000', memo: refundMemo(r) })).matchedBy, 'memo', 'with the memo, any amount from the price up');
  assert.match(checkRefund(r, BUYER, transfer({ sender: OTHER })).reason, /not sent by the account that was paid/);
  assert.match(checkRefund(r, BUYER, transfer({}, { to: OTHER })).reason, /another account than the one that paid/);
  assert.match(checkRefund(r, BUYER, transfer({}, { asset: 'USDR' })).reason, /another asset/);
  assert.match(checkRefund(r, BUYER, transfer({}, { memo: refundMemo(receipt({ ticket: 'zzzzzzzzzzzzzzzzzzzz' })) })).reason, /another purchase/);
  assert.match(checkRefund(r, BUYER, transfer({ success: false })).reason, /rejected/);
  assert.match(checkRefund(r, BUYER, transfer({ finalized: false })).reason, /not finalized/);
  assert.match(checkRefund(r, 'nobody', transfer()).reason, /paying account/);
  assert.match(checkRefund(receipt({ payTo: '0xabc' }), BUYER, transfer()).reason, /payTo/);
});

test('checkRefundTx: the payment against its receipt first, then the refund against its payer (CCD, wallet proxy)', async () => {
  const r = receipt();
  const statuses = {
    [TX]: { status: 'finalized', outcome: 'success', sender: BUYER, to: SELLER, amount: r.amount, memo: cborMemo(receiptMemo(r)) },
    [BACK]: { status: 'finalized', outcome: 'success', sender: SELLER, to: BUYER, amount: r.amount, memo: cborMemo(refundMemo(r)) },
  };
  const calls = [];
  const fetchImpl = async (url) => { calls.push(String(url)); return { status: 200, json: async () => statuses[String(url).split('/').pop()] ?? { status: 'absent' } }; };
  const ok = await checkRefundTx(r, TX, BACK.toUpperCase(), { fetchImpl, env: {} });
  assert.strictEqual(ok.valid, true, JSON.stringify(ok));
  assert.strictEqual(ok.matchedBy, 'memo');
  assert.strictEqual(ok.payer, BUYER);
  assert.ok(calls.every((u) => u.startsWith('https://wallet-proxy.mainnet.concordium.software/v0/submissionStatus/')));
  assert.match((await checkRefundTx(r, TX, TX, { fetchImpl, env: {} })).reason, /the payment itself/);
  statuses[BACK].sender = OTHER;
  assert.match((await checkRefundTx(r, TX, BACK, { fetchImpl, env: {} })).reason, /not sent by the account that was paid/);
  const unpaid = await checkRefundTx(receipt({ amount: '1' }), TX, BACK, { fetchImpl, env: {} });
  assert.match(unpaid.reason, /the payment does not hold/);
  // tokens go through Fizzl's facilitator, never the seller's
  const asked = [];
  const facilitator = async (url, init) => { asked.push({ url: String(url), body: JSON.parse(init.body) }); return { status: 200, json: async () => ({ valid: true, matchedBy: 'memo', amount: '50000', payer: BUYER }) }; };
  const t = await checkRefundTx(receipt({ asset: 'USDR', amount: '50000' }), TX, BACK, { fetchImpl: facilitator, env: { CONCORDIUM_FACILITATOR_URL: 'https://ccd.fizzl.example/' } });
  assert.strictEqual(t.valid, true);
  assert.deepStrictEqual(asked[0], { url: 'https://ccd.fizzl.example/refund', body: { receipt: receipt({ asset: 'USDR', amount: '50000' }), tx: TX, refund_tx: BACK } });
  assert.strictEqual((await checkRefundTx(receipt({ asset: 'USDR' }), TX, BACK, { fetchImpl: facilitator, env: {} })).notRead, true);
});

// The paying account's transactions as the wallet proxy lists them, newest first.
const accTx = (hash, d, blockTime = 1794463874.682) => ({ transactionHash: hash, blockTime, id: Math.floor(Math.random() * 1e9), details: { outcome: 'success', type: d.memo ? 'transferWithMemo' : 'transfer', transferSource: d.from, transferDestination: d.to, transferAmount: d.amount, ...(d.memo ? { memo: cborMemo(d.memo) } : {}) } });
const proxyList = (list, calls = []) => async (url) => { calls.push(String(url)); return { status: 200, json: async () => ({ count: list.length, limit: 100, order: 'descending', transactions: list }) }; };
const hex = (c) => c.repeat(64);

test('findCcdRefund: in the paying account\'s own transactions, after the payment; the purchase\'s memo wins', async () => {
  const r = receipt();
  const terms = termsOf(r);
  const calls = [];
  const list = [
    accTx(hex('d'), { from: SELLER, to: BUYER, amount: r.amount }), // newest: a plain transfer back
    accTx(hex('c'), { from: SELLER, to: BUYER, amount: r.amount, memo: refundMemo(r) }), // the refund with the memo
    accTx(hex('b'), { from: OTHER, to: BUYER, amount: r.amount }), // someone else
    accTx(TX, { from: BUYER, to: SELLER, amount: r.amount, memo: receiptMemo(r) }), // the payment
    accTx(hex('a'), { from: SELLER, to: BUYER, amount: r.amount, memo: refundMemo(r) }), // before the payment: not a refund of it
  ];
  const f = await findCcdRefund(terms, TX, BUYER, { fetchImpl: proxyList(list, calls) });
  assert.deepStrictEqual(f, { refundTx: hex('c'), matchedBy: 'memo', amount: r.amount, time: 1794463874682 });
  assert.match(calls[0], /\/v3\/accTransactions\/4qqr.*order=descending&limit=100/);
  // the memo one already counted for another purchase: the plain transfer back of the amount
  assert.strictEqual((await findCcdRefund(terms, TX, BUYER, { fetchImpl: proxyList(list), used: new Set([hex('c')]) })).refundTx, hex('d'));
  // the payment not among the transactions read: only a transfer with this purchase's memo counts
  assert.strictEqual((await findCcdRefund(terms, TX, BUYER, { fetchImpl: proxyList([list[0]]) })), null);
  assert.strictEqual((await findCcdRefund(terms, TX, BUYER, { fetchImpl: proxyList([list[1]]) })).refundTx, hex('c'));
  assert.strictEqual(await findCcdRefund({ ...terms, asset: 'USDR' }, TX, BUYER, { fetchImpl: proxyList(list) }), null, 'tokens are not looked for this way');
  assert.strictEqual((await findCcdRefund(terms, TX, BUYER, { fetchImpl: async () => ({ status: 503, json: async () => ({}) }) })).notRead, true);
});

function setup({ found = null, check = null, events = [] } = {}) {
  let t = Date.parse('2026-12-08T10:00:00Z');
  const now = () => t;
  const recorded = [];
  const record = (e) => recorded.push(e);
  const finds = [];
  const refunds = createRefunds({ usageReader: { load: async () => ({ events }) }, record, now, find: async (...a) => { finds.push(a); return typeof found === 'function' ? found(...a) : found; }, check: check || (async () => ({ valid: false, reason: 'no' })) });
  const outcomes = createOutcomes({ usageReader: { load: async () => ({ events }) }, record, now, checkPaymentReceipt: async () => ({ valid: true, payer: BUYER }), refunds });
  return { refunds, outcomes, recorded, finds, tick: (ms) => { t += ms; } };
}

test('a refund request rides on a payment-backed outcome report; Doctor finds the CCD refund on chain and counts it for the seller', async () => {
  const r = receipt();
  const { refunds, outcomes, recorded, finds, tick } = setup({ found: { refundTx: hex('c'), matchedBy: 'memo', amount: r.amount, time: Date.parse('2026-12-08T13:00:00Z') } });
  const rep = await outcomes.report({ outcome: 'paid_error', status: 500, payment_receipt: { receipt: r, tx: TX }, refund: 'error_after_payment' });
  assert.strictEqual(rep.status, 200, JSON.stringify(rep.body));
  assert.strictEqual(rep.body.refund.asked, 'error_after_payment');
  assert.strictEqual(rep.body.refund.refund_memo, refundMemo(r));
  assert.strictEqual(rep.body.refund.status, `/api/v1/concordium/refund?tx=${TX}`);
  // the usage log keeps what a refund must match, each field short
  const input = recorded[0].input;
  assert.deepStrictEqual({ refund: input.refund, refund_memo: input.refund_memo, pay_to: input.pay_to, asset: input.asset, amount: input.amount }, { refund: 'error_after_payment', refund_memo: refundMemo(r), pay_to: SELLER, asset: 'CCD', amount: r.amount });
  assert.ok(Object.values(input).every((v) => String(v).length <= 300));
  assert.deepStrictEqual(refunds.ofSeller(SELLER), { days: 30, asked: 1, refunded: 0, open: 1, median_hours: null });

  tick(4 * 3600e3);
  const s = await refunds.status(TX);
  assert.strictEqual(finds.length, 1);
  assert.deepStrictEqual(finds[0].slice(1, 3), [TX, BUYER]);
  assert.deepStrictEqual(s.asked, { reason: 'error_after_payment', at: '2026-12-08T10:00:00.000Z' });
  assert.deepStrictEqual(s.refunded, { refund_tx: hex('c'), matched_by: 'memo', amount: r.amount, at: '2026-12-08T13:00:00.000Z', found_by: 'chain' });
  assert.deepStrictEqual(refunds.ofSeller(SELLER), { days: 30, asked: 1, refunded: 1, open: 0, median_hours: 3 });
  assert.deepStrictEqual(recorded.at(-1), { route: 'refund', via: 'refund', status: 200, paid: false, agent: 'none', input: { tx: TX, refund_tx: hex('c'), pay_to: SELLER, by: 'chain' }, result: { valid: true, matched_by: 'memo', amount: r.amount, at: Date.parse('2026-12-08T13:00:00Z') } });
  assert.strictEqual(refunds.ofSeller(OTHER), null);
});

test('refund requests: only with a paid outcome and its receipt, one of three reasons; an open one shows how to refund', async () => {
  const { outcomes, refunds, finds, tick } = setup();
  assert.match((await outcomes.report({ outcome: 'paid_error', payment_receipt: { receipt: receipt(), tx: TX }, refund: 'please' })).body.error, /refund must be one of payment_not_accepted, error_after_payment, not_delivered/);
  assert.match((await outcomes.report({ outcome: 'refused', reason: 'payee_mismatch', refund: 'not_delivered', query: { url: ENDPOINT }, preflight: { receipt: {} } })).body.error, /refund request needs payment_receipt/);
  const ok = await outcomes.report({ outcome: 'paid_ok', status: 200, payment_receipt: { receipt: receipt(), tx: TX }, refund: 'not_delivered' });
  assert.strictEqual(ok.status, 200, 'answered 200 but not what was paid for: still a request');
  const s = await refunds.status(TX);
  assert.strictEqual(finds.length, 1);
  assert.strictEqual(s.refunded, null);
  assert.match(s.how_to_refund, new RegExp(`from ${SELLER} back to ${BUYER} with the memo ${refundMemo(receipt())}`));
  // looked for again only after 2 minutes
  await refunds.status(TX);
  assert.strictEqual(finds.length, 1);
  tick(3 * 60 * 1000);
  await refunds.status(TX);
  assert.strictEqual(finds.length, 2);
  assert.strictEqual(await refunds.status(hex('e')), null);
});

test('a refund sent in (a token refund, by the seller or the wallet): checked on chain, one transaction refunds one purchase', async () => {
  const r = receipt({ asset: 'USDR', amount: '50000' });
  const r2 = receipt({ asset: 'USDR', amount: '50000', ticket: 'zzzzzzzzzzzzzzzzzzzz' });
  const TX2 = hex('f');
  const { outcomes, refunds, recorded } = setup({ check: async (rc, tx, back) => ({ valid: true, matchedBy: 'memo', amount: rc.amount, payer: BUYER, time: '2026-12-09T10:00:00Z' }) });
  await outcomes.report({ outcome: 'paid_failed', status: 402, payment_receipt: { receipt: r, tx: TX }, refund: 'payment_not_accepted' });
  const p = await refunds.prove({ receipt: r, tx: TX, refund_tx: BACK });
  assert.strictEqual(p.status, 200, JSON.stringify(p.body));
  assert.strictEqual(p.body.refund.found_by, 'sender');
  assert.deepStrictEqual(p.body.seller, { days: 30, asked: 1, refunded: 1, open: 0, median_hours: 24 });
  assert.strictEqual(recorded.at(-1).route, 'refund');
  assert.strictEqual((await refunds.prove({ receipt: r, tx: TX, refund_tx: BACK })).body.already, true);
  assert.match((await refunds.prove({ receipt: r2, tx: TX2, refund_tx: BACK })).body.reason, /already refunds another purchase/);
  // a refund nobody asked for still counts for the seller, apart from the requests
  const unasked = await refunds.prove({ receipt: r2, tx: TX2, refund_tx: hex('9') });
  assert.deepStrictEqual(unasked.body.seller, { days: 30, asked: 1, refunded: 1, open: 0, refunded_unasked: 1, median_hours: 24 });
  assert.match((await refunds.prove({ receipt: { kind: 'x' }, tx: TX, refund_tx: BACK })).body.reason, /receipt/);
});

test('requests and refunds come back from the usage log after a restart', async () => {
  const r = receipt();
  const events = [
    { t: '2026-12-08T10:00:00.000Z', route: 'outcome', result: { accepted: true }, input: { url: ENDPOINT, outcome: 'paid_error', request_id: `ccd-tx:${TX}`, payer: `ccd:${BUYER}`, backed: 'concordium-receipt', tx: TX, network: MAINNET, refund: 'error_after_payment', refund_memo: refundMemo(r), pay_to: SELLER, asset: 'CCD', amount: r.amount } },
    { t: '2026-12-08T12:00:00.000Z', route: 'refund', result: { valid: true, matched_by: 'amount', amount: r.amount, at: Date.parse('2026-12-08T12:00:00Z') }, input: { tx: TX, refund_tx: BACK, pay_to: SELLER, by: 'chain' } },
    { t: '2026-12-08T11:00:00.000Z', route: 'outcome', result: { accepted: true }, input: { url: ENDPOINT, outcome: 'paid_error', tx: hex('1'), payer: `ccd:${BUYER}`, network: MAINNET, refund: 'not_delivered', refund_memo: 'x402r:nope', pay_to: SELLER, asset: 'CCD', amount: '1' } },
  ];
  const { refunds } = setup({ events });
  await refunds.refresh();
  assert.deepStrictEqual(refunds.ofSeller(SELLER), { days: 30, asked: 1, refunded: 1, open: 0, median_hours: 2 }, 'a request without a refund memo is not one');
  assert.strictEqual((await refunds.status(TX)).refunded.refund_tx, BACK);
});

test('GET and POST /api/v1/concordium/refund on the app: free, open CORS, input checked before any read', async () => {
  const { createApp } = require('../server');
  const usageReader = { load: async () => ({ events: [] }) };
  const absent = async () => ({ status: 200, json: async () => ({ status: 'absent' }) }); // no network in tests
  const app = createApp({ env: { USAGE_LOG_TOKEN: '' }, usageReader, refunds: createRefunds({ usageReader, env: {}, fetchImpl: absent }) });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/v1/concordium/refund`;
  try {
    const none = await fetch(base);
    assert.strictEqual(none.status, 400);
    assert.strictEqual(none.headers.get('access-control-allow-origin'), '*');
    const unknown = await fetch(`${base}?tx=${TX}`);
    assert.strictEqual(unknown.status, 404);
    assert.strictEqual((await unknown.json()).asked, null);
    const seller = await (await fetch(`${base}?pay_to=${SELLER}`)).json();
    assert.deepStrictEqual(seller.refunds, { days: 30, asked: 0, refunded: 0, open: 0, median_hours: null });
    const post = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ receipt: receipt(), tx: TX, refund_tx: 'abc' }) });
    assert.strictEqual(post.status, 400);
    assert.match((await post.json()).reason, /transaction hashes/);
    assert.strictEqual((await fetch(base, { method: 'OPTIONS' })).status, 204);
  } finally {
    server.close();
  }
});

test('a payment no refund was asked for: read from the chain, its x402r memo names the refund; only a refund with that memo counts', async () => {
  const r = receipt({ amount: '1000' });
  const memo = receiptMemo(r);
  const statuses = { [TX]: { status: 'finalized', outcome: 'success', sender: BUYER, to: SELLER, amount: 1000, memo: cborMemo(memo) } };
  let list = [
    accTx(hex('e'), { from: SELLER, to: BUYER, amount: '1000000000' }), // a top-up later: no memo, far more
    accTx(hex('d'), { from: SELLER, to: BUYER, amount: '1000' }), // the amount back, no memo
    accTx(TX, { from: BUYER, to: SELLER, amount: '1000', memo }),
  ];
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/v0/submissionStatus/')) return { status: 200, json: async () => statuses[String(url).split('/').pop()] ?? { status: 'absent' } };
    return { status: 200, json: async () => ({ count: list.length, limit: 100, order: 'descending', transactions: list }) };
  };
  let clock = 1e12;
  const refunds = createRefunds({ usageReader: null, env: {}, fetchImpl, now: () => clock });
  const none = await refunds.status(TX);
  assert.deepStrictEqual([none.from, none.asked, none.refunded, none.payer, none.pay_to, none.amount], ['chain', null, null, BUYER, SELLER, '1000'], 'an amount alone, without a request, is no refund');
  assert.strictEqual(none.refund_memo, refundMemo(r), 'the refund memo comes from the payment memo alone');
  list = [accTx(hex('c'), { from: SELLER, to: BUYER, amount: '1000', memo: refundMemo(r) }), ...list];
  assert.strictEqual((await refunds.status(TX)).refunded, null, 'cached for a while');
  clock += 11 * 60 * 1000;
  const back = await refunds.status(TX);
  assert.deepStrictEqual(back.refunded && [back.refunded.refund_tx, back.refunded.matched_by, back.refunded.amount], [hex('c'), 'memo', '1000']);
  assert.strictEqual(await refunds.status(hex('9')), null, 'not on chain');
  statuses[hex('8')] = { status: 'finalized', outcome: 'success', sender: BUYER, to: SELLER, amount: 1000, memo: cborMemo('hello') };
  assert.strictEqual(await refunds.status(hex('8')), null, 'no receipt memo: nothing to go by');
  const down = createRefunds({ usageReader: null, env: {}, fetchImpl: async () => ({ status: 503, json: async () => ({}) }) });
  assert.match((await down.status(TX)).not_read, /503/);
  assert.ok(calls.every((u) => u.startsWith('https://wallet-proxy.mainnet.concordium.software/')));
});

test('agents see the record: an info line in the preflight (never the verdict), and the free MCP tool', async () => {
  const http = require('node:http');
  const { preflight } = require('../lib/preflight');
  const { createSafeFetch } = require('../lib/safe-fetch');
  const { createMcpRouter } = require('../lib/mcp');
  const r = receipt();
  const { outcomes, refunds } = setup({ found: { refundTx: hex('c'), matchedBy: 'memo', amount: r.amount, time: Date.parse('2026-12-08T14:00:00Z') } });
  await outcomes.report({ outcome: 'paid_error', status: 500, payment_receipt: { receipt: r, tx: TX }, refund: 'error_after_payment' });
  await outcomes.report({ outcome: 'paid_error', status: 500, payment_receipt: { receipt: receipt({ ticket: 'zzzzzzzzzzzzzzzzzzzz' }), tx: hex('2') }, refund: 'not_delivered' });
  await refunds.status(TX); // the first is refunded on chain, the second still open
  const challenge = { x402Version: 2, resource: { url: ENDPOINT }, accepts: [{ scheme: 'exact', network: MAINNET, amount: '16000000', asset: 'CCD', payTo: SELLER, maxTimeoutSeconds: 120 }] };
  const server = http.createServer((req, res) => { res.statusCode = 402; res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(challenge)).toString('base64')); res.end('{}'); });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  try {
    const url = `http://127.0.0.1:${server.address().port}/paid`;
    const pf = await preflight(url, { safeFetch: createSafeFetch({ allowPrivate: true }), refunds, testnetOk: true });
    assert.deepStrictEqual(pf.signals.concordium_refunds, [{ pay_to: SELLER, asked: 2, refunded: 1, open: 1, median_hours: 4 }]);
    const line = pf.reasons.find((x) => x.code === 'concordium_refunds');
    assert.strictEqual(line.level, 'info');
    assert.match(line.message, /asked .*: 2; refunded on chain: 1 \(median 4 h\); still open: 1/);
    const without = await preflight(url, { safeFetch: createSafeFetch({ allowPrivate: true }), testnetOk: true });
    assert.strictEqual(without.verdict, pf.verdict, 'the record never changes the verdict');
    assert.strictEqual(without.signals.concordium_refunds, undefined);
  } finally { server.close(); }

  // the MCP tool, on its own router
  const express = require('express');
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const app = express();
  app.use(createMcpRouter({ resourceServer: null, config: {}, diagnose: async () => ({}), runPreflight: async () => ({}), buildFixes: () => [], concordiumRefunds: refunds }));
  const s = await new Promise((ok) => { const x = app.listen(0, '127.0.0.1', () => ok(x)); });
  const client = new Client({ name: 'test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${s.address().port}/mcp/free`)));
    const bySeller = await client.callTool({ name: 'concordium_refund_record', arguments: { pay_to: SELLER } });
    assert.deepStrictEqual(bySeller.structuredContent.refunds, { days: 30, asked: 2, refunded: 1, open: 1, median_hours: 4 });
    const byTx = await client.callTool({ name: 'concordium_refund_record', arguments: { tx: TX } });
    assert.strictEqual(byTx.structuredContent.found, true);
    assert.strictEqual(byTx.structuredContent.refunded.refund_tx, hex('c'));
    const none = await client.callTool({ name: 'concordium_refund_record', arguments: {} });
    assert.ok(none.isError);
  } finally { await client.close(); s.close(); }
});
