const { test } = require('node:test');
const assert = require('node:assert');
const { receiptMemo, canonicalReceipt, receiptProblem, checkReceiptTx, receiptBacksReport, memoText, decodeReceiptParam, receiptCheckAnswer } = require('../lib/concordium-receipt');
const { createOutcomes } = require('../lib/outcomes');
const { createSigner } = require('../lib/receipt');

const MAINNET = 'ccd:9dd9ca4d19e9393877d2c44b70f89acb';
const TESTNET = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const PAY_TO = '45R4vB9JnXDUkYVNBrQE8yyg6o2qH32g7fX5N7i9yWxHxnFP7J';
const BUYER = '4qqrSf3Ca8SnbsxGDQSVritpBULxGPPRzB6bVFB3KNzLkeoVoq';
const SPONSOR = '4HxSuKYFJw4wZaDFt3buyTTX7kogz3SxWTnXwvBDAHbq9poqQJ';
const TX = '60d661e8538f564ed4743030176f16271b1e6b6797a924043d7ff51f84dac815';
const ENDPOINT = 'https://api.example.com/paid';
const receipt = (over = {}) => ({ kind: 'x402-concordium-receipt', v: 1, network: MAINNET, asset: 'CCD', amount: '1000', payTo: PAY_TO, resource: ENDPOINT, ticket: 'abcdefghijklmnop1234', ...over });

// A memo as the facilitator writes it: CBOR text, wrapped as an embedded CBOR item (tag 24 around a byte string).
function cborMemo(text) {
  const t = Buffer.from(text, 'utf8');
  const inner = Buffer.concat([Buffer.from([0x78, t.length]), t]);
  return Buffer.concat([Buffer.from([0xd8, 0x18, 0x58, inner.length]), inner]).toString('hex');
}
// Concordium's wallet proxy, answering /v0/submissionStatus/<tx> with `status`.
const walletProxy = (status, calls = []) => async (url) => {
  calls.push(String(url));
  return { status: 200, json: async () => status };
};
const finalized = (r, over = {}) => ({ status: 'finalized', outcome: 'success', sender: BUYER, sponsor: { cost: '5596757', sponsor: SPONSOR }, to: r.payTo, amount: r.amount, memo: cborMemo(receiptMemo(r)), cost: '0', transactionHash: TX, ...over });

test('the receipt\'s fingerprint is the facilitator\'s (concordium-facilitator/src/receipt.js), field order fixed', () => {
  // The same receipt through the facilitator's module gives this memo (Fizzl13/x402-examples).
  assert.strictEqual(receiptMemo(receipt({ resource: 'https://x.example/a' })), 'x402r:c018ab1065d75c485f43d96f16910feded2233672e65d7905f8856e8006cf0f6');
  const shuffled = Object.fromEntries(Object.entries(receipt()).reverse());
  assert.strictEqual(canonicalReceipt(shuffled), canonicalReceipt(receipt()));
  assert.strictEqual(receiptProblem(receipt()), null);
  assert.match(receiptProblem(receipt({ payTo: '0xabc' })), /payTo/);
  assert.match(receiptProblem(receipt({ resource: 'ftp://x' })), /resource/);
  assert.match(receiptProblem({ ...receipt(), v: 2 }), /v1/);
});

test('memos: the chain\'s CBOR (tag 24 or plain text) is read as text', () => {
  // A real mainnet payment's memo (wallet proxy, transaction 60d661e8…).
  assert.strictEqual(memoText('d81858477845783430323a31306334316363623038666233666665316632333666386436343036656464383566626163353263353566373263346161363364356666393832353537383636'), 'x402:10c41ccb08fb3ffe1f236f8d6406edd85fbac52c55f72c4aa63d5ff982557866');
  assert.strictEqual(memoText(Buffer.from([0x63, 0x61, 0x62, 0x63]).toString('hex')), 'abc');
  assert.strictEqual(memoText('01'), null);
  assert.strictEqual(memoText(undefined), null);
});

test('a CCD payment is checked against the chain: amount, payTo, memo, finalized', async () => {
  const r = receipt();
  const calls = [];
  const ok = await checkReceiptTx(r, TX, { fetchImpl: walletProxy(finalized(r), calls) });
  assert.deepStrictEqual(ok, { valid: true, payer: BUYER, sponsor: SPONSOR, time: null, network: 'mainnet', via: 'wallet-proxy' });
  assert.strictEqual(calls[0], `https://wallet-proxy.mainnet.concordium.software/v0/submissionStatus/${TX}`);
  // another resource in the receipt: another fingerprint
  assert.match((await checkReceiptTx(receipt({ resource: 'https://api.example.com/other' }), TX, { fetchImpl: walletProxy(finalized(r)) })).reason, /memo is not this receipt's/);
  assert.match((await checkReceiptTx(r, TX, { fetchImpl: walletProxy(finalized(r, { amount: '999' })) })).reason, /another amount/);
  assert.match((await checkReceiptTx(r, TX, { fetchImpl: walletProxy(finalized(r, { to: BUYER })) })).reason, /another account/);
  assert.match((await checkReceiptTx(r, TX, { fetchImpl: walletProxy({ status: 'absent' }) })).reason, /does not know/);
  assert.match((await checkReceiptTx(r, TX, { fetchImpl: walletProxy({ status: 'committed' }) })).reason, /not finalized/);
  assert.match((await checkReceiptTx(r, TX, { fetchImpl: walletProxy(finalized(r, { outcome: 'reject' })) })).reason, /rejected/);
  // a contract call or token update has no `to`: not one CCD transfer
  assert.match((await checkReceiptTx(r, TX, { fetchImpl: walletProxy(finalized(r, { to: undefined })) })).reason, /exactly one transfer/);
  const testnet = [];
  await checkReceiptTx(receipt({ network: TESTNET }), TX, { fetchImpl: walletProxy({ status: 'absent' }, testnet) });
  assert.match(testnet[0], /wallet-proxy\.testnet\.concordium\.com/);
  const down = await checkReceiptTx(r, TX, { fetchImpl: async () => { throw new Error('offline'); } });
  assert.strictEqual(down.notRead, true);
  assert.match((await checkReceiptTx(r, 'nothex', { fetchImpl: walletProxy(finalized(r)) })).reason, /transaction hash/);
  assert.match((await checkReceiptTx(receipt({ network: 'ccd:00000000000000000000000000000000' }), TX, { fetchImpl: walletProxy(finalized(r)) })).reason, /not Concordium mainnet or testnet/);
});

test('a token payment (USDR) is read through Fizzl\'s own facilitator, never without one', async () => {
  const r = receipt({ asset: 'USDR', amount: '50000' });
  const none = await checkReceiptTx(r, TX, { env: {}, fetchImpl: walletProxy({}) });
  assert.strictEqual(none.notRead, true);
  assert.match(none.reason, /POST \{ receipt, tx \}/);
  const asked = [];
  const facilitator = async (url, init) => { asked.push({ url: String(url), body: JSON.parse(init.body) }); return { status: 200, json: async () => ({ valid: true, payer: BUYER, sponsor: SPONSOR, time: '2026-11-11T20:00:00.000Z' }) }; };
  const ok = await checkReceiptTx(r, TX, { env: { CONCORDIUM_FACILITATOR_URL: 'https://ccd.example.org/' }, fetchImpl: facilitator });
  assert.deepStrictEqual(ok, { valid: true, payer: BUYER, sponsor: SPONSOR, time: '2026-11-11T20:00:00.000Z', via: 'facilitator', network: 'mainnet' });
  assert.strictEqual(asked[0].url, 'https://ccd.example.org/receipt');
  assert.deepStrictEqual(asked[0].body, { receipt: r, tx: TX });
});

test('a receipt backs a report only for a payTo the endpoint\'s own 402 offers, paid by someone else', async () => {
  const r = receipt();
  const offer = [{ scheme: 'exact', network: MAINNET, asset: 'CCD', amount: '1000', payTo: PAY_TO }];
  const opts = (accepts, status = finalized(r)) => ({ fetchImpl: walletProxy(status), readAccepts: async () => accepts });
  assert.strictEqual((await receiptBacksReport(r, TX, ENDPOINT, opts(offer))).valid, true);
  // a reporter that paid its own account, naming someone else's route
  const other = '3HFbRLEGSVUsebprTBmTvpdbTkHg4ncutEYWf4EEaQfgQae9v3';
  const self = receipt({ payTo: other });
  assert.match((await receiptBacksReport(self, TX, ENDPOINT, opts(offer, finalized(self)))).reason, /doesn't offer/);
  assert.match((await receiptBacksReport(self, TX, ENDPOINT, opts([{ ...offer[0], payTo: other }], finalized(self, { sender: other })))).reason, /its own account/);
  assert.match((await receiptBacksReport(r, TX, ENDPOINT, opts([{ ...offer[0], asset: 'USDR' }]))).reason, /doesn't offer/);
  assert.strictEqual((await receiptBacksReport(r, TX, ENDPOINT, opts(null))).notRead, true);
});

test('the free check\'s answer, and the wallet link\'s base64url receipt', async () => {
  const r = receipt();
  const { status, body } = await receiptCheckAnswer(r, TX, { fetchImpl: walletProxy(finalized(r)) });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.valid, true);
  assert.strictEqual(body.payer, BUYER);
  assert.deepStrictEqual(body.paid, { network: MAINNET, asset: 'CCD', amount: '1000', payTo: PAY_TO, resource: ENDPOINT });
  const bad = await receiptCheckAnswer({ kind: 'x' }, TX, { fetchImpl: walletProxy(finalized(r)) });
  assert.strictEqual(bad.status, 400);
  const down = await receiptCheckAnswer(r, TX, { fetchImpl: async () => { throw new Error('offline'); } });
  assert.strictEqual(down.status, 503);
  assert.strictEqual(down.body.not_read, true);
  // the wallet's link: btoa(JSON) with + / = made URL-safe
  const b64 = Buffer.from(JSON.stringify(r)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.deepStrictEqual(decodeReceiptParam(b64), r);
  assert.strictEqual(decodeReceiptParam('not base64!'), null);
});

// Outcome reports (lib/outcomes.js) with a payment receipt.
const signer = createSigner({ RECEIPT_SIGNER_SECRET: 'test-secret-for-outcome-reports-0123456789abcdef', RECEIPT_SIGNER_CERT: '' });
async function preflightFor(url = ENDPOINT, network = MAINNET) {
  const query = { url, method: 'GET', max_usd: '0.05', network };
  const body = await signer.sign({ url, method: 'GET', verdict: 'go', summary: 'OK', reasons: [] }, { route: 'GET /api/v1/preflight', input: query, payment: { network: 'eip155:8453', payer: '0xaaa', nonce: '0x1' } });
  return { preflight: body, query };
}
function makeOutcomes(check, events = []) {
  const recorded = [];
  const asked = [];
  const outcomes = createOutcomes({ usageReader: { load: async () => ({ events }) }, record: (e) => recorded.push(e), signers: () => signer.signers, checkPaymentReceipt: async (rc, tx, url) => { asked.push({ rc, tx, url }); return check(rc, tx, url); } });
  return { outcomes, recorded, asked };
}

test('outcome reports: a Concordium receipt backs a report on its own, by the paying account, once per transaction', async () => {
  const { outcomes, recorded, asked } = makeOutcomes(async () => ({ valid: true, payer: BUYER }));
  const r = await outcomes.report({ outcome: 'paid_error', status: 500, payment_receipt: { receipt: receipt(), tx: TX.toUpperCase() } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.backed, { by: 'concordium-receipt', payer: `ccd:${BUYER}`, tx: TX, network: MAINNET });
  assert.deepStrictEqual(r.body.endpoint, { url: ENDPOINT, reports: 1, failed: 1, failed_payers: 1, backed_by_receipt: 1 });
  assert.strictEqual(asked[0].url, ENDPOINT);
  assert.deepStrictEqual(recorded[0].input, { url: ENDPOINT, outcome: 'paid_error', status: 500, verdict: null, request_id: `ccd-tx:${TX}`, payer: `ccd:${BUYER}`, backed: 'concordium-receipt', tx: TX, network: MAINNET });
  assert.deepStrictEqual((await outcomes.report({ outcome: 'paid_ok', payment_receipt: { receipt: receipt(), tx: TX } })).body, { accepted: false, duplicate: true });
  assert.strictEqual(asked.length, 1, 'a transaction already counted is not read again');
});

test('outcome reports: a paid outcome on Concordium needs the receipt; a receipt must match the report and the chain', async () => {
  const { outcomes } = makeOutcomes(async () => ({ valid: false, reason: "the transaction's memo is not this receipt's" }));
  const ccd = await preflightFor(ENDPOINT, MAINNET);
  assert.match((await outcomes.report({ outcome: 'paid_error', ...ccd })).body.error, /counts only with its receipt/);
  // a refusal on Concordium is no payment: no receipt needed
  assert.strictEqual((await outcomes.report({ outcome: 'refused', reason: 'payee_mismatch', ...ccd })).status, 200);
  assert.match((await outcomes.report({ outcome: 'refused', reason: 'payee_mismatch', payment_receipt: { receipt: receipt(), tx: TX }, ...ccd })).body.error, /a refusal has no payment/);
  assert.match((await outcomes.report({ outcome: 'paid_error', payment_receipt: { receipt: receipt({ resource: 'https://api.example.com/other' }), tx: TX }, ...(await preflightFor(ENDPOINT, MAINNET)) })).body.error, /another resource/);
  const r = await outcomes.report({ outcome: 'paid_error', payment_receipt: { receipt: receipt(), tx: TX } });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /does not back this report: the transaction's memo/);
  assert.match((await outcomes.report({ outcome: 'paid_error', payment_receipt: { receipt: receipt({ resource: null }), tx: TX } })).body.error, /names no resource/);
  assert.match((await outcomes.report({ outcome: 'paid_error', payment_receipt: { receipt: receipt(), tx: 'abc' } })).body.error, /transaction hash/);
  const { outcomes: down } = makeOutcomes(async () => ({ valid: false, notRead: true, reason: 'offline' }));
  assert.strictEqual((await down.report({ outcome: 'paid_error', payment_receipt: { receipt: receipt(), tx: TX } })).status, 503);
  // other networks keep the preflight rule, receipts or not
  const base = await preflightFor(ENDPOINT, 'eip155:8453');
  assert.strictEqual((await outcomes.report({ outcome: 'paid_failed', ...base })).status, 200);
});

test('outcome reports: a receipt with its preflight counts once, also after a restart (usage log)', async () => {
  const { outcomes } = makeOutcomes(async () => ({ valid: true, payer: BUYER }));
  const ccd = await preflightFor(ENDPOINT, MAINNET);
  const r = await outcomes.report({ outcome: 'paid_failed', payment_receipt: { receipt: receipt(), tx: TX }, ...ccd });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.backed.payer, `ccd:${BUYER}`, 'the chain\'s payer, not the preflight\'s');
  // the same preflight with another receipt: already counted
  assert.deepStrictEqual((await outcomes.report({ outcome: 'paid_failed', payment_receipt: { receipt: receipt({ ticket: 'qrstuvwxyz0123456789' }), tx: 'f'.repeat(64) }, ...ccd })).body, { accepted: false, duplicate: true });
  const ev = { route: 'outcome', input: { url: ENDPOINT, outcome: 'paid_failed', request_id: `ccd-tx:${TX}`, payer: `ccd:${BUYER}`, backed: 'concordium-receipt', tx: TX, preflight_request_id: 'pf-1' }, result: { accepted: true } };
  const again = { route: 'outcome', input: { url: ENDPOINT, outcome: 'paid_failed', request_id: 'pf-1', payer: '0xaaa' }, result: { accepted: true } };
  const { outcomes: restarted } = makeOutcomes(async () => ({ valid: true, payer: BUYER }), [ev, again]);
  await restarted.refresh();
  assert.deepStrictEqual(restarted.lookup(ENDPOINT), { reports: 1, failed: 1, failed_payers: 1, backed_by_receipt: 1 });
});

test('GET and POST /api/v1/concordium/receipt on the app: free, open CORS, input checked before any read', async () => {
  const { createApp } = require('../server');
  const app = createApp({ env: { USAGE_LOG_TOKEN: '' }, usageReader: { load: async () => ({ events: [] }) } });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/v1/concordium/receipt`;
  try {
    const none = await fetch(base);
    assert.strictEqual(none.status, 400);
    assert.strictEqual(none.headers.get('access-control-allow-origin'), '*');
    assert.match((await none.json()).reason, /receipt and tx are required/);
    const b64 = Buffer.from(JSON.stringify(receipt())).toString('base64url');
    const badTx = await fetch(`${base}?tx=abc&receipt=${b64}`);
    assert.strictEqual(badTx.status, 400);
    assert.match((await badTx.json()).reason, /transaction hash/);
    const post = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ receipt: { ...receipt(), kind: 'other' }, tx: TX }) });
    assert.strictEqual(post.status, 400);
    assert.match((await post.json()).reason, /x402-concordium-receipt/);
    const pre = await fetch(base, { method: 'OPTIONS' });
    assert.strictEqual(pre.status, 204);
  } finally {
    server.close();
  }
});
