// Real payments on the XRP Ledger (lib/onchain-payments-xrpl.js) against a fake rippled: RLUSD and USDC payments into
// watched payout addresses that an x402 client marked (SourceTag 804681468 or an InvoiceID), counted per UTC day;
// unmarked payments, XRP and look-alike tokens left out; payments sent back out (closed loops); paging that stops
// between ledgers; and the reader, preflight and web check naming the XRP Ledger. No network.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { mergeXrplPayTos, collectXrpl, paymentOf, createXrplRpc, XRPL, X402_SOURCE_TAG } = require('../lib/onchain-payments-xrpl');
const { windowOf, totalsOf, paidBackNote, createOnchainPayments } = require('../lib/onchain-payments');
const { payTosOf } = require('../lib/trust-scan');
const { preflight } = require('../lib/preflight');
const { checkOnchainPayments } = require('../lib/diagnose');
const { createSafeFetch } = require('../lib/safe-fetch');

// Real XRPL addresses (valid checksums), so the address checks accept them.
const SELLER = 'rMnHeutYALco8RYFVcmuU4BCgSzBpPEh32';
const BUYER = 'rfryheo6yzFdLWj8qUQtZc7zG9MKkBkUEy';
const BUYER2 = 'r3FbirL83RAB2CwnUdxE5pCohMkuo6LQcf';
const OTHER = 'rhFHztjS63h6fs5vXgTotuL7jsuryUvDSF';
const RLUSD = { currency: '524C555344000000000000000000000000000000', issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' };
const USDC = { currency: '5553444300000000000000000000000000000000', issuer: 'rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE' };
const DAY1 = '2026-10-22', DAY2 = '2026-10-23';
const INVOICE = 'AB'.repeat(32);
const rippleTime = (iso) => Math.floor(Date.parse(iso) / 1000) - 946684800;

// An account_tx entry (API v1): a Payment from `from` to `to` that delivered `value` of `token` (XRP in drops when
// token is null).
function pay({ from, to, value, token = RLUSD, at, ledger, tag, invoice, result = 'tesSUCCESS', type = 'Payment' }) {
  const delivered = token ? { ...token, value: String(value) } : String(value);
  return {
    tx: { TransactionType: type, Account: from, Destination: to, Amount: delivered, date: rippleTime(at), ledger_index: ledger, ...(tag !== undefined ? { SourceTag: tag } : {}), ...(invoice ? { InvoiceID: invoice } : {}) },
    meta: { TransactionResult: result, delivered_amount: delivered },
    validated: true,
  };
}

// A rippled holding these transactions. account_tx honours ledger_index_min/max, forward, limit and a marker (the
// index of the next one), like the real one; `ledgers.validated` is the newest validated ledger.
function fakeNode({ txs, validated, unknown = [] }) {
  const calls = [], ledgers = { validated };
  const reply = (result) => ({ ok: true, status: 200, json: async () => ({ result }) });
  const fetchImpl = async (_url, { body }) => {
    const { method, params: [p] } = JSON.parse(body);
    calls.push({ method, ...p });
    if (unknown.includes(p.account)) return reply({ status: 'error', error: 'actNotFound' });
    const max = p.ledger_index_max === -1 ? ledgers.validated : p.ledger_index_max;
    const min = p.ledger_index_min === -1 ? 0 : p.ledger_index_min;
    const mine = txs.filter((t) => (t.tx.Account === p.account || t.tx.Destination === p.account) && t.tx.ledger_index >= min && t.tx.ledger_index <= max)
      .sort((a, b) => (p.forward ? a.tx.ledger_index - b.tx.ledger_index : b.tx.ledger_index - a.tx.ledger_index));
    const start = p.marker ? p.marker.i : 0;
    const page = mine.slice(start, start + p.limit);
    return reply({ status: 'success', account: p.account, ledger_index_min: min, ledger_index_max: max, transactions: page, ...(start + p.limit < mine.length ? { marker: { i: start + p.limit } } : {}) });
  };
  return { fetchImpl, calls, ledgers };
}
const quick = { minGapMs: 0, wait: async () => {} };

test('payTosOf: XRPL payout addresses, apart from Base and Solana', () => {
  const out = payTosOf([
    { network: 'eip155:8453', pay_to: '0x1111111111111111111111111111111111111111' },
    { network: XRPL, asset: RLUSD.currency, pay_to: SELLER },
    { network: XRPL, asset: 'XRP', pay_to: SELLER },
    { network: XRPL, pay_to: 'rNotAnAddress' },
    { network: 'xrpl:1', pay_to: OTHER },
  ]);
  assert.deepEqual(out, { pay_tos: ['0x1111111111111111111111111111111111111111'], xrpl_pay_tos: [SELLER] });
});

test('mergeXrplPayTos: the day last seen, old ones dropped after 14 days', () => {
  let m = mergeXrplPayTos(null, [{ xrpl_pay_tos: [SELLER, 'nope'] }], '2026-10-01');
  assert.deepEqual(m, { network: XRPL, updated: '2026-10-01', pay_tos: { [SELLER]: '2026-10-01' } });
  m = mergeXrplPayTos(m, [{ xrpl_pay_tos: [OTHER] }], '2026-10-16');
  assert.deepEqual(Object.keys(m.pay_tos), [OTHER]);
});

test('paymentOf: marked RLUSD and USDC in, in micro-dollars; unmarked, XRP, look-alikes, failures and others are not', () => {
  const at = `${DAY1}T10:00:00Z`;
  assert.deepEqual(paymentOf(pay({ from: BUYER, to: SELLER, value: '0.005', at, ledger: 1, tag: X402_SOURCE_TAG }), SELLER), { dir: 'in', x402: true, from: BUYER, micro: 5000 });
  assert.deepEqual(paymentOf(pay({ from: BUYER, to: SELLER, value: '1.25', token: USDC, at, ledger: 1, invoice: INVOICE }), SELLER), { dir: 'in', x402: true, from: BUYER, micro: 1250000 });
  assert.equal(paymentOf(pay({ from: BUYER, to: SELLER, value: '2', at, ledger: 1 }), SELLER).x402, false, 'no SourceTag or InvoiceID: a plain payment');
  assert.equal(paymentOf(pay({ from: BUYER, to: SELLER, value: '2', at, ledger: 1, tag: 12345 }), SELLER).x402, false, 'another SourceTag');
  assert.equal(paymentOf(pay({ from: BUYER, to: SELLER, value: '10000', token: null, at, ledger: 1, tag: X402_SOURCE_TAG }), SELLER), null, 'XRP has no dollar amount');
  assert.equal(paymentOf(pay({ from: BUYER, to: SELLER, value: '1', token: { ...RLUSD, issuer: OTHER }, at, ledger: 1, tag: X402_SOURCE_TAG }), SELLER), null, 'RLUSD from another issuer');
  assert.equal(paymentOf(pay({ from: BUYER, to: SELLER, value: '1', at, ledger: 1, tag: X402_SOURCE_TAG, result: 'tecPATH_DRY' }), SELLER), null, 'failed');
  assert.equal(paymentOf(pay({ from: BUYER, to: SELLER, value: '1', at, ledger: 1, type: 'TrustSet' }), SELLER), null);
  assert.deepEqual(paymentOf(pay({ from: SELLER, to: BUYER, value: '0.5', at, ledger: 1 }), SELLER), { dir: 'out', to: BUYER, micro: 500000 });
  assert.equal(paymentOf(pay({ from: BUYER, to: OTHER, value: '1', at, ledger: 1, tag: X402_SOURCE_TAG }), SELLER), null, 'not this payout address');
});

test('collectXrpl: marked payments counted per day from today on first sight; the next run reads only new ledgers', async () => {
  const txs = [
    pay({ from: BUYER, to: SELLER, value: '9', at: `${DAY1}T08:00:00Z`, ledger: 90, tag: X402_SOURCE_TAG }), // yesterday: history on first sight
    pay({ from: BUYER, to: SELLER, value: '0.01', at: `${DAY2}T01:00:00Z`, ledger: 100, tag: X402_SOURCE_TAG }),
    pay({ from: BUYER2, to: SELLER, value: '0.02', token: USDC, at: `${DAY2}T02:00:00Z`, ledger: 101, invoice: INVOICE }),
    pay({ from: BUYER, to: SELLER, value: '5', at: `${DAY2}T03:00:00Z`, ledger: 102 }), // unmarked
    pay({ from: SELLER, to: BUYER, value: '0.009', at: `${DAY2}T04:00:00Z`, ledger: 103 }), // sent back to a payer
  ];
  const node = fakeNode({ txs, validated: 110 });
  const s = await collectXrpl(null, { payTos: [SELLER], fetchImpl: node.fetchImpl, now: () => Date.parse(`${DAY2}T09:00:00Z`), ...quick });
  const entry = s.pay_tos[SELLER];
  assert.deepEqual(entry.d[DAY1], undefined, 'yesterday is history, not counted');
  assert.deepEqual(entry.d[DAY2].slice(0, 3), [2, 30000, [BUYER.slice(0, 10), BUYER2.slice(0, 10)]]);
  assert.deepEqual(entry.d[DAY2][3], { [BUYER.slice(0, 10)]: 9000 });
  assert.equal(entry.ledger, 110, 'read up to the validated ledger');
  assert.equal(entry.since, DAY2);
  assert.equal(node.calls[0].forward, false, 'first sight: newest first');

  // New ledgers: only those are asked for, oldest first.
  txs.push(pay({ from: BUYER2, to: SELLER, value: '0.03', at: `${DAY2}T10:00:00Z`, ledger: 111, tag: X402_SOURCE_TAG }));
  node.ledgers.validated = 120;
  node.calls.length = 0;
  const s2 = await collectXrpl(s, { payTos: [SELLER], fetchImpl: node.fetchImpl, now: () => Date.parse(`${DAY2}T11:00:00Z`), ...quick });
  assert.deepEqual([node.calls[0].forward, node.calls[0].ledger_index_min], [true, 111]);
  assert.deepEqual(s2.pay_tos[SELLER].d[DAY2].slice(0, 2), [3, 60000]);

  // The window, the totals and the closed-loop note speak of RLUSD or USDC.
  const s3 = await collectXrpl(s2, { payTos: [SELLER], fetchImpl: node.fetchImpl, now: () => Date.parse('2026-10-24T09:00:00Z'), ...quick });
  const w = windowOf(s3, SELLER);
  assert.deepEqual([w.network, w.symbol, w.days, w.payments, w.payers, w.usd], [XRPL, 'RLUSD or USDC', 1, 3, 2, 0.06]);
  assert.equal(w.payers_paid_back, 1);
  assert.match(paidBackNote(w), /also received RLUSD or USDC from this payout address/);
  const tot = totalsOf(s3);
  assert.deepEqual([tot.network, tot.symbol, tot.watched, tot.pay_tos_paid, tot.payments], [XRPL, 'RLUSD or USDC', 1, 1, 3]);
});

test('collectXrpl: a run cut short by the page limit keeps the last ledger whole for the next run', async () => {
  const txs = [];
  // 1,200 marked payments over ledgers 201..: more than one run's pages (5 x 200), two per ledger.
  for (let i = 0; i < 1200; i++) txs.push(pay({ from: i % 2 ? BUYER : BUYER2, to: SELLER, value: '0.001', at: `${DAY2}T05:00:00Z`, ledger: 201 + Math.floor(i / 2), tag: X402_SOURCE_TAG }));
  const node = fakeNode({ txs, validated: 900 });
  const state = { version: 1, network: XRPL, per_day: 1, updated: null, cursor: 0, days: {}, pay_tos: { [SELLER]: { since: DAY2, d: {}, ledger: 200 } } };
  const s = await collectXrpl(state, { payTos: [SELLER], fetchImpl: node.fetchImpl, now: () => Date.parse(`${DAY2}T09:00:00Z`), ...quick });
  assert.equal(node.calls.length, 5);
  assert.ok(node.calls.slice(1).every((c) => c.ledger_index_max === 900), 'later pages keep the first page\'s newest ledger');
  const first = s.pay_tos[SELLER].d[DAY2][0];
  assert.ok(first < 1000 && first % 2 === 0, `only whole ledgers counted (${first})`);
  assert.equal(s.pay_tos[SELLER].ledger, 200 + first / 2);
  const s2 = await collectXrpl(s, { payTos: [SELLER], fetchImpl: node.fetchImpl, now: () => Date.parse(`${DAY2}T10:00:00Z`), ...quick });
  assert.equal(s2.pay_tos[SELLER].d[DAY2][0], 1200, 'every payment counted once over the two runs');
  assert.equal(s2.pay_tos[SELLER].ledger, 900);
});

test('collectXrpl: an account that does not exist yet is skipped without error; a time budget stops the run', async () => {
  const node = fakeNode({ txs: [], validated: 50, unknown: [OTHER] });
  const lines = [];
  const s = await collectXrpl(null, { payTos: [OTHER, SELLER], fetchImpl: node.fetchImpl, now: () => Date.parse(`${DAY2}T09:00:00Z`), log: (l) => lines.push(l), ...quick });
  assert.equal(s.pay_tos[OTHER].ledger, null, 'asked again next run');
  assert.equal(s.pay_tos[SELLER].ledger, 50);
  assert.match(lines.at(-1), /2 of 2 payout addresses read/);
  let t = Date.parse(`${DAY2}T09:00:00Z`);
  const s2 = await collectXrpl(null, { payTos: [SELLER, BUYER], fetchImpl: node.fetchImpl, now: () => (t += 60 * 1000), budgetMs: 60 * 1000, ...quick });
  assert.ok(s2.backlog > 0 && s2.cursor > 0, 'the next run starts where this one stopped');
});

test('createXrplRpc: waits and retries when a node is busy, hands over to the next, and throws account errors at once', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url === 'a') return { ok: false, status: 503, json: async () => ({ result: { status: 'error', error: 'tooBusy' } }) };
    return { ok: true, status: 200, json: async () => ({ result: { status: 'success', n: seen.length } }) };
  };
  const rpc = createXrplRpc(['a', 'b'], { fetchImpl, minGapMs: 0, retries: 1, wait: async () => {} });
  assert.equal((await rpc('account_tx', {})).n, 3);
  assert.deepEqual(seen, ['a', 'a', 'b']);
  const missing = createXrplRpc(['a', 'b'], { fetchImpl: async (url) => { seen.push(url); return { ok: true, status: 200, json: async () => ({ result: { status: 'error', error: 'actNotFound' } }) }; }, minGapMs: 0 });
  seen.length = 0;
  await assert.rejects(missing('account_tx', {}), (err) => err.code === 'actNotFound');
  assert.deepEqual(seen, ['a'], 'the same answer on every node: not asked again');
});

test('createOnchainPayments: XRPL addresses are looked up in the XRPL file; the totals come apart', async () => {
  const xrpl = { version: 1, network: XRPL, symbol: 'RLUSD or USDC', per_day: 1, updated: `${DAY2}T09:00:00Z`, days: { [DAY1]: { covered: 1 } }, pay_tos: { [SELLER]: { since: DAY1, d: { [DAY1]: [4, 40000, ['a', 'b']] }, ledger: 5 } } };
  const base = { version: 1, network: 'eip155:8453', updated: `${DAY2}T09:00:00Z`, days: { [DAY1]: { covered: 43200 } }, pay_tos: {} };
  const fetchImpl = async (url) => (url.includes('solana') ? { ok: false, status: 404 } : { ok: true, json: async () => (url.includes('xrpl') ? xrpl : base) });
  const p = createOnchainPayments({ url: 'https://x/payments.json', solanaUrl: 'https://x/payments-solana.json', xrplUrl: 'https://x/payments-xrpl.json', fetchImpl });
  await p.refresh();
  const w = await p.lookup(SELLER);
  assert.deepEqual([w.network, w.payments, w.usd, w.symbol], [XRPL, 4, 0.04, 'RLUSD or USDC']);
  assert.equal((await p.totalsXrpl()).payments, 4);
  assert.equal(p.loaded(SELLER), true);
  assert.equal(await p.totalsSolana(), null);
  // No XRPL file yet: XRPL addresses read as not loaded.
  const q = createOnchainPayments({ url: 'https://x/payments.json', solanaUrl: '', xrplUrl: 'https://x/payments-xrpl.json', fetchImpl: async (url) => (url.includes('xrpl') ? { ok: false, status: 404 } : { ok: true, json: async () => base }) });
  await q.refresh();
  assert.equal(q.loaded(SELLER), false);
  assert.equal(await q.totalsXrpl(), null);
});

// A seller whose only option is RLUSD on the XRP Ledger.
function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    server.unref();
  });
}
async function xrplSeller() {
  let origin;
  origin = await listen((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/openapi.json') { res.statusCode = 404; return res.end('{}'); }
    const challenge = { x402Version: 2, resource: { url: `${origin}/paid`, mimeType: 'application/json', description: 'x' }, accepts: [{ scheme: 'exact', network: XRPL, amount: '0.01', asset: RLUSD.currency, payTo: SELLER, maxTimeoutSeconds: 60, extra: { issuer: RLUSD.issuer, sourceTag: X402_SOURCE_TAG } }] };
    res.statusCode = 402;
    res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(challenge)).toString('base64'));
    res.end(JSON.stringify(challenge));
  });
  return `${origin}/paid`;
}

test('preflight: a seller paid only on the XRP Ledger is looked up by its XRPL payout address', async () => {
  const url = await xrplSeller();
  const asked = [];
  const stats = { network: XRPL, symbol: 'RLUSD or USDC', days: 7, payments: 29, payers: 3, usd: 0.15, coverage: 1 };
  const xrplFetch = async () => { throw new Error('offline'); };
  let r = await preflight(url, { safeFetch: createSafeFetch({ allowPrivate: true }), xrplFetch, payments: { lookup: async (payTo) => { asked.push(payTo); return { ...stats, pay_to: payTo }; } } });
  assert.deepEqual(asked, [SELLER]);
  assert.match(r.reasons.find((x) => x.code === 'onchain_payments').message, /^3 different wallets paid this seller's payout address on the XRP Ledger in the last 7 days: 29 x402 payments, \$0\.15 in total \(in RLUSD or USDC, each marked by the x402 client that signed it\)\.$/);
  r = await preflight(url, { safeFetch: createSafeFetch({ allowPrivate: true }), xrplFetch, payments: { lookup: async () => ({ ...stats, days: 1, payments: 0, payers: 0, usd: 0 }) } });
  assert.match(r.reasons.find((x) => x.code === 'onchain_payments').message, /^No x402 payments reached this seller's payout address on the XRP Ledger yesterday\./);
});

test('web check: an XRPL option without a Base or Solana one is looked up by its XRPL payout address', async () => {
  const asked = [];
  const found = { network: XRPL, symbol: 'RLUSD or USDC', days: 7, payments: 12, payers: 3, usd: 0.24, coverage: 1 };
  const checks = [];
  await checkOnchainPayments([{ scheme: 'exact', network: XRPL, asset: RLUSD.currency, payTo: SELLER }], { lookup: async (a) => { asked.push(a); return found; }, loaded: () => true }, checks);
  assert.deepEqual(asked, [SELLER]);
  assert.match(checks[0].message, /^Real payments on the XRP Ledger in the last 7 days: 3 different wallets paid this payout address \(.+\) 12 times, \$0\.24 in RLUSD or USDC in total\./);
  assert.match(checks[0].hint, /SourceTag 804681468/);
  const empty = [];
  await checkOnchainPayments([{ scheme: 'exact', network: XRPL, asset: RLUSD.currency, payTo: SELLER }], { lookup: async () => null, loaded: () => true }, empty);
  assert.match(empty[0].message, /counts the payout addresses on the XRP Ledger/);
});
