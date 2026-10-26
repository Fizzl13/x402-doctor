// Real payments on Stellar (lib/onchain-payments-stellar.js) against a fake Horizon: USDC transfers into watched
// payout accounts that the payer authorized and another account sent (as an x402 facilitator does), counted per UTC
// day; transfers the payer sent itself, look-alike USDC and failures left out; USDC sent back out (closed loops);
// paging from a cursor; and the reader, preflight, web check and GET /api/trust/payments naming Stellar. No network.

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeStellarPayTos, collectStellar, paymentsOf, createHorizon, STELLAR, USDC_ISSUER, USDC_CONTRACT } = require('../lib/onchain-payments-stellar');
const { createOnchainPayments } = require('../lib/onchain-payments');
const { payTosOf } = require('../lib/trust-scan');
const { checkOnchainPayments } = require('../lib/diagnose');
const { createApp } = require('../server');

// Real Stellar account ids (valid checksums), so the address checks accept them.
const SELLER = 'GC7YFRC6WZ57HAWYYNP3C5SAGMA6JS4U5LSFOMTXASXI77MTVI6FAU3A';
const BUYER = 'GCKLPFPYNVZQ4ZUCTE7C5HADLH77FYSG2YSDEUYWEDT3HVVOB6HV6REN';
const BUYER2 = 'GAHNUKJ6MMZB5MB5PQXH4NBRHOBCYMS6O7GA7QXBGHSH6AOBEHWVHVOD';
const CHANNEL = 'GCOBV2AXOTEZLCTHYNIWCRRQEGIS76C6ZZ7G4QNDMXNBOTZNUQTSOTTL';
const FAKE_ISSUER = 'GAJ673OTK7GKKPH4BTISOH4LE2K3LU6QIHQY4BYBNOH444HRHLLGVESN';
const DAY1 = '2026-10-22', DAY2 = '2026-10-23';

let token = 1000;
// A Horizon operation joined with its transaction: a Soroban USDC transfer from → to, sent by `sender`.
function transfer({ from, to, amount, sender = CHANNEL, at, issuer = USDC_ISSUER, ok = true }) {
  return {
    paging_token: String(token++), type: 'invoke_host_function', created_at: at, transaction_successful: ok, source_account: sender,
    asset_balance_changes: [{ asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: issuer, type: 'transfer', from, to, amount }],
    transaction: { source_account: sender, fee_account: CHANNEL, successful: ok },
  };
}
const classic = ({ from, to, amount, at }) => ({ paging_token: String(token++), type: 'payment', created_at: at, transaction_successful: true, asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER, from, to, amount, transaction: { source_account: from } });

// A Horizon holding operations per account, oldest first. It honours order, limit and cursor like the real one.
function fakeHorizon(ops, { unknown = [] } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname + u.search);
    const m = u.pathname.match(/^\/accounts\/(G[A-Z2-7]{55})\/operations$/);
    if (!m || unknown.includes(m[1])) return { ok: false, status: 404, json: async () => ({}) };
    const asc = u.searchParams.get('order') !== 'desc';
    const limit = Number(u.searchParams.get('limit'));
    const cursor = u.searchParams.get('cursor');
    let list = (ops[m[1]] || []).slice();
    if (!asc) list.reverse();
    if (cursor) list = list.filter((op) => (asc ? Number(op.paging_token) > Number(cursor) : Number(op.paging_token) < Number(cursor)));
    return { ok: true, status: 200, json: async () => ({ _embedded: { records: list.slice(0, limit) } }) };
  };
  return { fetchImpl, calls };
}

test('payTosOf: Stellar USDC payout accounts (G…), not contracts, other assets or testnet', () => {
  const options = [
    { network: STELLAR, asset: USDC_CONTRACT, pay_to: SELLER },
    { network: STELLAR, asset: USDC_CONTRACT, pay_to: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75' },
    { network: STELLAR, asset: 'USDC', pay_to: BUYER },
    { network: 'stellar:testnet', asset: USDC_CONTRACT, pay_to: BUYER2 },
  ];
  assert.deepEqual(payTosOf(options), { stellar_pay_tos: [SELLER] });
});

test('mergeStellarPayTos: the day last seen and the endpoints\' hosts, dropped after 14 days', () => {
  let m = mergeStellarPayTos(null, [{ url: 'https://api.example.com/a', stellar_pay_tos: [SELLER, 'not-an-account'] }, { url: 'https://b.example.org/x', stellar_pay_tos: [BUYER] }], DAY1);
  assert.deepEqual(m.pay_tos, { [SELLER]: DAY1, [BUYER]: DAY1 });
  assert.deepEqual(m.hosts, { [SELLER]: ['api.example.com'], [BUYER]: ['b.example.org'] });
  m = mergeStellarPayTos(m, [{ url: 'https://api.example.com/b', stellar_pay_tos: [SELLER] }], '2026-11-06');
  assert.deepEqual(Object.keys(m.pay_tos), [SELLER]);
  assert.deepEqual(m.hosts, { [SELLER]: ['api.example.com'] });
});

test('paymentsOf: a transfer the payer authorized and another account sent is x402; the payer\'s own, fakes and failures are not', () => {
  const at = `${DAY1}T10:00:00Z`;
  assert.deepEqual(paymentsOf(transfer({ from: BUYER, to: SELLER, amount: '0.0100000', at }), SELLER), [{ dir: 'in', x402: true, from: BUYER, micro: 10000 }]);
  assert.deepEqual(paymentsOf(transfer({ from: BUYER, to: SELLER, amount: '0.0100000', sender: BUYER, at }), SELLER), [{ dir: 'in', x402: false, from: BUYER, micro: 10000 }]);
  assert.deepEqual(paymentsOf(transfer({ from: BUYER, to: SELLER, amount: '1', issuer: FAKE_ISSUER, at }), SELLER), []);
  // USDC the seller pulls in itself, from a swap or another contract: not a payment to it.
  const SWAP = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75';
  assert.deepEqual(paymentsOf(transfer({ from: SWAP, to: SELLER, amount: '0.5', sender: SELLER, at }), SELLER), [{ dir: 'in', x402: false, from: SWAP, micro: 500000 }]);
  assert.deepEqual(paymentsOf(transfer({ from: BUYER, to: SELLER, amount: '1', ok: false, at }), SELLER), []);
  assert.deepEqual(paymentsOf(classic({ from: BUYER, to: SELLER, amount: '2.5', at }), SELLER), [{ dir: 'in', x402: false, from: BUYER, micro: 2500000 }]);
  assert.deepEqual(paymentsOf(classic({ from: SELLER, to: BUYER, amount: '2.5', at }), SELLER), [{ dir: 'out', to: BUYER, micro: 2500000 }]);
  assert.deepEqual(paymentsOf(transfer({ from: SELLER, to: BUYER, amount: '0.5', sender: SELLER, at }), SELLER), [{ dir: 'out', to: BUYER, micro: 500000 }]);
});

test('collectStellar: x402 payments counted per day from today on first sight; the next run reads on from the cursor', async () => {
  const ops = { [SELLER]: [
    transfer({ from: BUYER, to: SELLER, amount: '0.0100000', at: '2026-10-21T23:00:00Z' }), // before the first day: not read
    transfer({ from: BUYER, to: SELLER, amount: '0.0100000', at: `${DAY1}T08:00:00Z` }),
    transfer({ from: BUYER2, to: SELLER, amount: '0.0200000', at: `${DAY1}T09:00:00Z` }),
    transfer({ from: BUYER, to: SELLER, amount: '5', sender: BUYER, at: `${DAY1}T09:30:00Z` }), // sent by the payer: plain
  ] };
  const horizon = fakeHorizon(ops);
  const logs = [];
  let s = await collectStellar(null, { payTos: [SELLER], fetchImpl: horizon.fetchImpl, now: () => Date.parse(`${DAY1}T12:00:00Z`), minGapMs: 0, log: (l) => logs.push(l) });
  assert.deepEqual(s.pay_tos[SELLER].d[DAY1], [2, 30000, [BUYER.slice(0, 10), BUYER2.slice(0, 10)]]);
  assert.match(horizon.calls[0], /order=desc/);
  assert.match(logs.at(-1), /2 x402 payments .*1 payments sent by the payer itself left out/);
  // The next day: a new payment and USDC sent back to a payer; only operations after the cursor are read.
  ops[SELLER].push(transfer({ from: BUYER, to: SELLER, amount: '0.0300000', at: `${DAY2}T01:00:00Z` }));
  ops[SELLER].push(classic({ from: SELLER, to: BUYER, amount: '0.0400000', at: `${DAY2}T02:00:00Z` }));
  horizon.calls.length = 0;
  s = await collectStellar(s, { payTos: [SELLER], fetchImpl: horizon.fetchImpl, now: () => Date.parse(`${DAY2}T03:00:00Z`), minGapMs: 0 });
  assert.match(horizon.calls[0], /order=asc.*cursor=/);
  assert.deepEqual(s.pay_tos[SELLER].d[DAY2], [1, 30000, [BUYER.slice(0, 10)], { [BUYER.slice(0, 10)]: 40000 }]);
  assert.deepEqual(s.pay_tos[SELLER].d[DAY1][0], 2, 'nothing counted twice');
  assert.deepEqual(Object.keys(s.days), [DAY1, DAY2]);
});

test('collectStellar: an account Horizon does not know is read without error; a time budget stops the run', async () => {
  const horizon = fakeHorizon({}, { unknown: [SELLER] });
  const s = await collectStellar(null, { payTos: [SELLER, BUYER], fetchImpl: horizon.fetchImpl, now: () => Date.parse(`${DAY1}T12:00:00Z`), minGapMs: 0 });
  assert.equal(s.backlog, 0);
  assert.equal(s.pay_tos[SELLER].last, null);
  let t = Date.parse(`${DAY1}T12:00:00Z`);
  const cut = await collectStellar(null, { payTos: [SELLER, BUYER], fetchImpl: horizon.fetchImpl, now: () => (t += 60_000), budgetMs: 90_000, minGapMs: 0 });
  assert.equal(cut.backlog, 1);
  assert.equal(cut.cursor, 1);
});

test('createHorizon: waits out a 429 for its Retry-After, hands over to the next node, gives up after the deadline', async () => {
  const waits = [];
  let n = 0;
  const fetchImpl = async (url) => {
    n++;
    if (url.startsWith('https://busy') && n < 2) return { ok: false, status: 429, headers: { get: (h) => (h === 'retry-after' ? '7' : null) } };
    if (url.startsWith('https://down')) throw new Error('ECONNRESET');
    return { ok: true, status: 200, json: async () => ({ ok: url }) };
  };
  const get = createHorizon(['https://busy.example'], { fetchImpl, minGapMs: 0, wait: async (ms) => { waits.push(ms); } });
  assert.deepEqual(await get('/x'), { ok: 'https://busy.example/x' });
  assert.deepEqual(waits, [7000]);
  const next = createHorizon(['https://down.example', 'https://good.example'], { fetchImpl, minGapMs: 0, retries: 1, wait: async () => {} });
  assert.deepEqual(await next('/y'), { ok: 'https://good.example/y' });
  const late = createHorizon(['https://busy2.example'], { fetchImpl: async () => ({ ok: false, status: 429, headers: { get: () => '30' } }), minGapMs: 0, deadline: Date.now() + 1000, wait: async () => {} });
  await assert.rejects(late('/z'), /429/);
});

// One complete day: SELLER paid by two wallets, BUYER (as a seller) by nobody.
function paymentsFile() {
  return {
    version: 1, network: STELLAR, token: USDC_CONTRACT, per_day: 1, updated: `${DAY2}T09:00:00Z`, days: { [DAY1]: { covered: 1 } },
    pay_tos: { [SELLER]: { since: DAY1, d: { [DAY1]: [6, 52000, ['GCKLPFPYNV', 'GAHNUKJ6MM']] }, last: '5' }, [BUYER]: { since: DAY1, d: {}, last: null } },
  };
}
const baseFile = { version: 1, network: 'eip155:8453', updated: `${DAY2}T09:00:00Z`, days: {}, pay_tos: {} };

test('createOnchainPayments: Stellar accounts are looked up in the Stellar file; totals and sellers with hosts', async () => {
  const info = { network: STELLAR, pay_tos: { [SELLER]: DAY1 }, hosts: { [SELLER]: ['api.example.com'] } };
  const fetchImpl = async (url) => ({ ok: true, json: async () => (url.includes('paytos-stellar') ? info : url.includes('payments-stellar') ? paymentsFile() : baseFile) });
  const p = createOnchainPayments({ url: 'https://x/payments.json', solanaUrl: '', xrplUrl: '', xrplPayTosUrl: '', stellarUrl: 'https://x/payments-stellar.json', stellarPayTosUrl: 'https://x/paytos-stellar.json', fetchImpl });
  await p.refresh();
  const w = await p.lookup(SELLER);
  assert.deepEqual([w.network, w.payments, w.usd, w.payers], [STELLAR, 6, 0.05, 2]);
  assert.equal((await p.totalsStellar()).pay_tos_paid, 1);
  const list = await p.sellersStellar();
  assert.deepEqual(list.sellers.map((s) => [s.pay_to, s.hosts]), [[SELLER, ['api.example.com']]]);
  assert.equal(p.loaded(SELLER), true);
});

test('web check: a Stellar USDC option without a Base, Solana or XRPL one is looked up by its payout account', async () => {
  const asked = [];
  const checks = [];
  const found = { network: STELLAR, days: 7, payments: 6, payers: 2, usd: 0.05, coverage: 1 };
  await checkOnchainPayments([{ scheme: 'exact', network: STELLAR, asset: USDC_CONTRACT, payTo: SELLER }], { lookup: async (a) => { asked.push(a); return found; }, loaded: () => true }, checks);
  assert.deepEqual(asked, [SELLER]);
  assert.match(checks[0].message, /^Real payments on Stellar in the last 7 days: 2 different wallets paid this payout address \(.+\) 6 times, \$0\.05 in USDC in total\./);
  assert.match(checks[0].hint, /another account sent/);
});

test('GET /api/trust/payments?network=stellar: the list as JSON, 503 before a complete day', async () => {
  const fetchImpl = async (url) => ({ ok: true, json: async () => (url.includes('payments-stellar') ? paymentsFile() : url.includes('paytos') ? {} : baseFile) });
  const onchainPayments = createOnchainPayments({ url: 'https://x/payments.json', solanaUrl: '', xrplUrl: '', xrplPayTosUrl: '', stellarUrl: 'https://x/payments-stellar.json', stellarPayTosUrl: '', fetchImpl });
  const trustIndex = { lookup: async () => null, refresh: () => Promise.resolve(), summary: () => null };
  const start = (app) => new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve({ s, base: `http://127.0.0.1:${s.address().port}` })); });
  const { s, base } = await start(createApp({ allowPrivate: true, env: {}, trustIndex, onchainPayments }));
  try {
    const res = await fetch(`${base}/api/trust/payments?network=stellar`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.network, STELLAR);
    assert.equal(body.sellers[0].pay_to, SELLER);
    assert.equal(body.paid, 1);
  } finally { s.close(); }
  const empty = createOnchainPayments({ url: 'https://x/payments.json', solanaUrl: '', xrplUrl: '', xrplPayTosUrl: '', stellarUrl: 'https://x/payments-stellar.json', stellarPayTosUrl: '', fetchImpl: async (url) => ({ ok: true, json: async () => (url.includes('stellar') ? { ...paymentsFile(), days: {} } : baseFile) }) });
  const second = await start(createApp({ allowPrivate: true, env: {}, trustIndex, onchainPayments: empty }));
  try {
    const res = await fetch(`${second.base}/api/trust/payments?network=stellar`);
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /no complete day of Stellar payments/);
  } finally { second.s.close(); }
});
