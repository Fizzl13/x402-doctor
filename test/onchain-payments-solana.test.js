// Real payments on Solana (lib/onchain-payments-solana.js) against a fake Solana node: USDC transfers into watched
// payout addresses whose fee a facilitator from the offers paid, counted per UTC day; plain transfers left out; USDC
// sent back out (closed loops); and the reader picking the right file per address. No network.

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeSolanaPayTos, collectSolana, transfersOf, createRpc, SOLANA, USDC_MINT } = require('../lib/onchain-payments-solana');
const { windowOf, totalsOf, createOnchainPayments } = require('../lib/onchain-payments');
const { payTosOf } = require('../lib/trust-scan');

// Real-looking base58 addresses (32 bytes each), so the address checks accept them.
const SELLER = 'ATWJ82T8nRdQwZnaysB68N5EpaSvLRsQP4h6eWmaJBH9';
const SELLER_ACCT = 'CLgJCXbmpJeL4v8KeXb6UGLHcVG4AkNDXKBWQjm1dupj';
const BUYER = '9NN5M9jSUv2opiU47huXeRunHvJa1DdEAtapLtrJbnG4';
const BUYER_ACCT = 'zWMVHbd4xN1UEZ8ssGY7aCmqhyRzPtZhKtR1LeLc3WC';
const BUYER2 = 'GVJJ7rdGiXr5xaYbRwRbjfaJL7fmwRygFi1H6aGqDveb';
const BUYER2_ACCT = 'BFK9TLC3edb13K6v4YyH3DwPb5DSUpkWvb7XnqCL9b4F';
const FACILITATOR = 'D6ZhtNQ5nT9ZnTHUbqXZsTx5MH2rPFiBBggX4hY1WePM';
const OTHER_FEE = 'BENrLoUbndxoNMUS5JXApGMtNykLjFXXixMtpDwDR9SP';
const DAY1 = '2026-10-22', DAY2 = '2026-10-23';
const ts = (iso) => Math.floor(Date.parse(iso) / 1000);

// A parsed transaction: fee payer first, one USDC transferChecked from `from` (owner fromOwner) to `to` (owner toOwner).
function tx({ feePayer, from, fromOwner, to, toOwner, amount, at, inner = false, mint = USDC_MINT }) {
  const keys = [feePayer, fromOwner, from, to, mint];
  const ix = { program: 'spl-token', parsed: { type: 'transferChecked', info: { source: from, destination: to, authority: fromOwner, mint, tokenAmount: { amount: String(amount), decimals: 6 } } } };
  return {
    blockTime: ts(at),
    transaction: { message: { accountKeys: keys.map((pubkey, i) => ({ pubkey, signer: i < 2 })), instructions: inner ? [{ program: 'compute-budget', parsed: null }] : [ix] } },
    meta: {
      err: null,
      innerInstructions: inner ? [{ index: 0, instructions: [ix] }] : [],
      postTokenBalances: [{ accountIndex: 2, owner: fromOwner, mint }, { accountIndex: 3, owner: toOwner, mint }],
    },
  };
}

// A node holding these transactions (by signature) on these token accounts. getSignaturesForAddress answers newest
// first and honours `until`, like the real one.
function fakeNode({ accounts, txs, onAccount = {} }) {
  const calls = [];
  const reply = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) });
  const fetchImpl = async (_url, { body }) => {
    const { method, params } = JSON.parse(body);
    calls.push(method);
    if (method === 'getTokenAccountsByOwner') return reply({ value: (accounts[params[0]] || []).map((pubkey) => ({ pubkey })) });
    if (method === 'getSignaturesForAddress') {
      const [acct, opts] = params;
      const list = Object.entries(txs).filter(([, t]) => JSON.stringify(t.transaction.message.accountKeys).includes(acct) || (onAccount[acct] || []).includes(t))
        .map(([signature, t]) => ({ signature, blockTime: t.blockTime, err: null })).sort((a, b) => b.blockTime - a.blockTime);
      const cut = opts.until ? list.findIndex((x) => x.signature === opts.until) : -1;
      return reply((cut >= 0 ? list.slice(0, cut) : list).slice(0, opts.limit));
    }
    if (method === 'getTransaction') return reply(txs[params[0]] || null);
    return reply(null);
  };
  return { fetchImpl, calls };
}

test('payTosOf: USDC payout addresses on Solana and the facilitators that pay their fees, apart from Base', () => {
  const out = payTosOf([
    { network: 'eip155:8453', pay_to: '0x1111111111111111111111111111111111111111' },
    { network: SOLANA, asset: USDC_MINT, pay_to: SELLER, fee_payer: FACILITATOR },
    { network: SOLANA, asset: 'So11111111111111111111111111111111111111112', pay_to: BUYER, fee_payer: OTHER_FEE },
    { network: SOLANA, asset: USDC_MINT, pay_to: 'not-an-address' },
  ]);
  assert.deepEqual(out, { pay_tos: ['0x1111111111111111111111111111111111111111'], sol_pay_tos: [SELLER], sol_fee_payers: [FACILITATOR] });
});

test('mergeSolanaPayTos: case kept, the day last seen, old ones dropped after 14 days', () => {
  let m = mergeSolanaPayTos(null, [{ sol_pay_tos: [SELLER, 'nope'], sol_fee_payers: [FACILITATOR] }], '2026-10-01');
  assert.deepEqual(m, { network: SOLANA, updated: '2026-10-01', pay_tos: { [SELLER]: '2026-10-01' }, fee_payers: { [FACILITATOR]: '2026-10-01' } });
  m = mergeSolanaPayTos(m, [{ sol_pay_tos: [BUYER] }], '2026-10-16');
  assert.deepEqual(Object.keys(m.pay_tos), [BUYER]);
  assert.deepEqual(m.fee_payers, {});
});

test('transfersOf: USDC transfers at the top level and inner, with the recipient\'s owner; other mints left out', () => {
  const t = transfersOf(tx({ feePayer: FACILITATOR, from: BUYER_ACCT, fromOwner: BUYER, to: SELLER_ACCT, toOwner: SELLER, amount: 10000, at: `${DAY1}T10:00:00Z`, inner: true }));
  assert.equal(t.feePayer, FACILITATOR);
  assert.deepEqual(t.transfers, [{ source: BUYER_ACCT, destination: SELLER_ACCT, authority: BUYER, amount: 10000, to: SELLER }]);
  assert.deepEqual(transfersOf(tx({ feePayer: FACILITATOR, from: BUYER_ACCT, fromOwner: BUYER, to: SELLER_ACCT, toOwner: SELLER, amount: 1, at: `${DAY1}T10:00:00Z`, mint: 'So11111111111111111111111111111111111111112' })).transfers, []);
});

test('collectSolana: facilitator-paid USDC payments counted per day; plain transfers and unknown fee payers not; sweeps back recorded', async () => {
  const txs = {
    s1: tx({ feePayer: FACILITATOR, from: BUYER_ACCT, fromOwner: BUYER, to: SELLER_ACCT, toOwner: SELLER, amount: 10000, at: `${DAY1}T09:00:00Z` }),
    s2: tx({ feePayer: FACILITATOR, from: BUYER2_ACCT, fromOwner: BUYER2, to: SELLER_ACCT, toOwner: SELLER, amount: 20000, at: `${DAY1}T10:00:00Z`, inner: true }),
    s3: tx({ feePayer: BUYER, from: BUYER_ACCT, fromOwner: BUYER, to: SELLER_ACCT, toOwner: SELLER, amount: 5000000, at: `${DAY1}T11:00:00Z` }), // plain transfer: buyer pays its own fee
    s4: tx({ feePayer: OTHER_FEE, from: BUYER_ACCT, fromOwner: BUYER, to: SELLER_ACCT, toOwner: SELLER, amount: 7000, at: `${DAY1}T12:00:00Z` }), // a fee payer no offer names
    s5: tx({ feePayer: SELLER, from: SELLER_ACCT, fromOwner: SELLER, to: BUYER_ACCT, toOwner: BUYER, amount: 9000, at: `${DAY1}T13:00:00Z` }), // sent back to a payer
  };
  const node = fakeNode({ accounts: { [SELLER]: [SELLER_ACCT] }, txs });
  const now = () => Date.parse(`${DAY1}T23:00:00Z`);
  const s = await collectSolana(null, { payTos: [SELLER], feePayers: [FACILITATOR], fetchImpl: node.fetchImpl, now, minGapMs: 0, wait: async () => {} });
  const d = s.pay_tos[SELLER].d[DAY1];
  assert.deepEqual(d.slice(0, 3), [2, 30000, [BUYER.slice(0, 10), BUYER2.slice(0, 10)]]);
  assert.deepEqual(d[3], { [BUYER.slice(0, 10)]: 9000 });
  assert.equal(s.pay_tos[SELLER].last[SELLER_ACCT], 's5', 'the newest signature read is remembered');
  assert.deepEqual(s.pay_tos[SELLER].accounts, [SELLER_ACCT]);

  // The next run reads only what is new.
  txs.s6 = tx({ feePayer: FACILITATOR, from: BUYER_ACCT, fromOwner: BUYER, to: SELLER_ACCT, toOwner: SELLER, amount: 10000, at: `${DAY2}T08:00:00Z` });
  node.calls.length = 0;
  const s2 = await collectSolana(s, { payTos: [SELLER], feePayers: [FACILITATOR], fetchImpl: node.fetchImpl, now: () => Date.parse(`${DAY2}T09:00:00Z`), minGapMs: 0, wait: async () => {} });
  assert.deepEqual(node.calls.filter((m) => m === 'getTransaction').length, 1, 'only the new transaction is read');
  assert.equal(node.calls.includes('getTokenAccountsByOwner'), false, 'the token accounts are known for a day');
  assert.deepEqual(s2.pay_tos[SELLER].d[DAY2].slice(0, 2), [1, 10000]);

  // The window: the complete days before the last update, counted like Base.
  const w = windowOf(s2, SELLER);
  assert.equal(w.network, SOLANA);
  assert.equal(w.pay_to, SELLER, 'the address keeps its case');
  assert.deepEqual([w.days, w.payments, w.payers, w.usd, w.coverage], [1, 2, 2, 0.03, 1]);
  assert.equal(w.payers_paid_back, 1);
  assert.equal(windowOf(s2, SELLER.toLowerCase()), null, 'base58 is case-sensitive');
  const tot = totalsOf(s2);
  assert.deepEqual([tot.network, tot.watched, tot.pay_tos_paid, tot.payments], [SOLANA, 1, 1, 2]);
});

test('collectSolana: on first sight only today is read; a quiet account remembers its newest signature', async () => {
  const txs = {
    old: tx({ feePayer: FACILITATOR, from: BUYER_ACCT, fromOwner: BUYER, to: SELLER_ACCT, toOwner: SELLER, amount: 10000, at: `${DAY1}T09:00:00Z` }),
  };
  const node = fakeNode({ accounts: { [SELLER]: [SELLER_ACCT], [BUYER2]: [] }, txs });
  const s = await collectSolana(null, { payTos: [SELLER, BUYER2], feePayers: [FACILITATOR], fetchImpl: node.fetchImpl, now: () => Date.parse(`${DAY2}T09:00:00Z`), minGapMs: 0, wait: async () => {} });
  assert.deepEqual(s.pay_tos[SELLER].d, {}, 'yesterday\'s payment is history, not counted');
  assert.equal(s.pay_tos[SELLER].last[SELLER_ACCT], 'old');
  assert.deepEqual(s.pay_tos[BUYER2].accounts, [], 'no USDC account yet: nothing to read');
  assert.equal(s.pay_tos[SELLER].since, DAY2);
});

test('collectSolana: a time budget stops the run; the next one goes on with the payout addresses not reached', async () => {
  const node = fakeNode({ accounts: { [SELLER]: [SELLER_ACCT], [BUYER]: [BUYER_ACCT] }, txs: {} });
  let t = Date.parse(`${DAY2}T09:00:00Z`);
  const now = () => (t += 60 * 1000); // every call to now() is a minute later
  const s = await collectSolana(null, { payTos: [SELLER, BUYER], feePayers: [FACILITATOR], fetchImpl: node.fetchImpl, now, budgetMs: 60 * 1000, minGapMs: 0, wait: async () => {} });
  assert.ok(s.backlog > 0, 'something left for the next run');
  assert.ok(s.cursor > 0, 'the next run starts where this one stopped');
});

test('createRpc: waits and retries on a rate limit, then hands over to the next node', async () => {
  const seen = [];
  let n = 0;
  const fetchImpl = async (url) => {
    seen.push(url);
    n++;
    if (url === 'a') return { ok: false, status: 429, json: async () => ({ error: { message: 'Too many requests for a specific RPC call' } }) };
    return { ok: true, status: 200, json: async () => ({ result: n }) };
  };
  const rpc = createRpc(['a', 'b'], { fetchImpl, minGapMs: 0, retries: 1, wait: async () => {} });
  assert.equal(await rpc('getSlot', []), 3);
  assert.deepEqual(seen, ['a', 'a', 'b']);
});

test('createOnchainPayments: Solana addresses are looked up in the Solana file, Base addresses in the Base file', async () => {
  const solana = { version: 1, network: SOLANA, per_day: 1, updated: `${DAY2}T09:00:00Z`, days: { [DAY1]: { covered: 1 } }, pay_tos: { [SELLER]: { since: DAY1, d: { [DAY1]: [3, 30000, ['a', 'b']] } } } };
  const base = { version: 1, network: 'eip155:8453', updated: `${DAY2}T09:00:00Z`, days: { [DAY1]: { covered: 43200 } }, pay_tos: { '0x1111111111111111111111111111111111111111': { since: DAY1, d: { [DAY1]: [1, 10000, ['c']] } } } };
  const fetchImpl = async (url) => ({ ok: true, json: async () => (url.includes('solana') ? solana : base) });
  const p = createOnchainPayments({ url: 'https://x/payments.json', solanaUrl: 'https://x/payments-solana.json', fetchImpl });
  await p.refresh();
  assert.deepEqual([(await p.lookup(SELLER)).network, (await p.lookup(SELLER)).payments], [SOLANA, 3]);
  assert.equal((await p.lookup('0x1111111111111111111111111111111111111111')).payments, 1);
  assert.equal((await p.totalsSolana()).payments, 3);
  assert.equal((await p.totals()).network, 'eip155:8453');
  assert.equal(p.loaded(SELLER), true);
  // No Solana file yet: Base still works, Solana addresses read as not loaded.
  const q = createOnchainPayments({ url: 'https://x/payments.json', solanaUrl: 'https://x/payments-solana.json', fetchImpl: async (url) => (url.includes('solana') ? { ok: false, status: 404 } : { ok: true, json: async () => base }) });
  await q.refresh();
  assert.equal(q.loaded(SELLER), false);
  assert.equal(q.loaded(), true);
  assert.equal(await q.totalsSolana(), null);
});
