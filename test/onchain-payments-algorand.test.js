// Real payments on Algorand (lib/onchain-payments-algorand.js) against a fake indexer: USDC transfers into watched
// payout addresses in an atomic group whose fee another transaction paid (fee pooling, as an x402 facilitator settles),
// counted per UTC day; transfers that paid their own fee, other assets and ungrouped transfers left out; USDC sent back
// out (closed loops); reading on from the last round; addresses found through the facilitator's fee payer; and the
// reader, preflight, web check and GET /api/trust/payments naming Algorand. No network.

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeAlgorandPayTos, collectAlgorand, paymentsOf, ALGORAND, USDC_ASA, FACILITATORS } = require('../lib/onchain-payments-algorand');
const { createOnchainPayments, totalsOf, sellersOf } = require('../lib/onchain-payments');
const { payTosOf } = require('../lib/trust-scan');
const { checkOnchainPayments } = require('../lib/diagnose');
const { createApp } = require('../server');

// Real Algorand addresses (valid checksums), so the address checks accept them.
const SELLER = 'LOYVFSQ6ZTS2YWUW4GQ5L6VPP2TPIOXWYDACK53CPOHQQHLDMEMKJDXAX4';
const BUYER = 'HVRJUKO2QDZW6UKADE7LYWQFMTT75537OPMYEWOTYIUFO4BB25TFL5IQMQ';
const BUYER2 = 'MRJ7DVB4ORS55GZUD5YIVT7Y22C5WAMT4TXYMDFMA3GMTOJ4YITFGOEJSU';
const UNLISTED = 'C7IIHG7SPLPZ5H7ZT6HW3UV2OQMQQE6Y2HBNGZXSLRJULE42BEE2OY2XIE';
const FEE = Object.keys(FACILITATORS)[0];
const DAY1 = '2026-10-22', DAY2 = '2026-10-23';
const at = (iso) => Date.parse(iso) / 1000;

let round = 1000, n = 0;
// An indexer transaction: a USDC asset transfer from → to, with its own fee (0 when another transaction in its group
// paid it) and a group id.
function axfer({ from, to, amount, fee = 0, group = `g${++n}`, time, asset = USDC_ASA }) {
  return { id: `tx${++n}`, 'tx-type': 'axfer', sender: from, fee, ...(group ? { group } : {}), 'confirmed-round': round++, 'round-time': at(time), 'asset-transfer-transaction': { 'asset-id': asset, amount, receiver: to } };
}
// The facilitator's own transaction in that group: a 0-ALGO payment to itself that pays the group's fees.
const feeTx = (t) => ({ id: `fee${++n}`, 'tx-type': 'pay', sender: FEE, fee: 2000, group: t.group, 'confirmed-round': t['confirmed-round'], 'round-time': t['round-time'], 'payment-transaction': { amount: 0, receiver: FEE } });

// An indexer holding transactions per address (newest first, as the real one gives them), honouring min-round,
// after-time and a page size with next tokens, and group-id lookups.
function fakeIndexer(byAddress, { current = () => round - 1 } = {}) {
  const calls = [];
  const all = () => Object.values(byAddress).flat();
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname + u.search);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    if (u.pathname === '/v2/transactions') {
      const g = u.searchParams.get('group-id');
      return ok({ transactions: [...new Map(all().filter((t) => t.group === g).map((t) => [t.id, t])).values()] });
    }
    const m = u.pathname.match(/^\/v2\/accounts\/([A-Z2-7]{58})\/transactions$/);
    if (!m) return { ok: false, status: 404, json: async () => ({}) };
    let list = (byAddress[m[1]] || []).slice().sort((a, b) => b['confirmed-round'] - a['confirmed-round']);
    const asset = u.searchParams.get('asset-id');
    if (asset) list = list.filter((t) => String(t['asset-transfer-transaction']?.['asset-id']) === asset);
    const min = u.searchParams.get('min-round');
    if (min) list = list.filter((t) => t['confirmed-round'] >= Number(min));
    const after = u.searchParams.get('after-time');
    if (after) list = list.filter((t) => t['round-time'] * 1000 >= Date.parse(after));
    const limit = Number(u.searchParams.get('limit'));
    const from = Number(u.searchParams.get('next') || 0);
    const page = list.slice(from, from + limit);
    return ok({ 'current-round': current(), transactions: page, ...(from + limit < list.length ? { 'next-token': String(from + limit) } : {}) });
  };
  return { fetchImpl, calls };
}

test('payTosOf: Algorand USDC payout addresses, on either form of the mainnet id; not testnet, other assets or bad addresses', () => {
  const options = [
    { network: ALGORAND, asset: '31566704', pay_to: SELLER },
    { network: 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k', asset: '31566704', pay_to: BUYER },
    { network: 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=', asset: '10458941', pay_to: BUYER2 },
    { network: ALGORAND, asset: '12345', pay_to: BUYER2 },
    { network: ALGORAND, asset: '31566704', pay_to: 'not-an-address' },
  ];
  assert.deepEqual(payTosOf(options), { algorand_pay_tos: [SELLER, BUYER] });
});

test('mergeAlgorandPayTos: the day last seen and the endpoints\' hosts, dropped after 14 days', () => {
  let m = mergeAlgorandPayTos(null, [{ url: 'https://api.example.com/a', algorand_pay_tos: [SELLER, 'nope'] }], DAY1);
  assert.deepEqual(m, { network: ALGORAND, updated: DAY1, pay_tos: { [SELLER]: DAY1 }, hosts: { [SELLER]: ['api.example.com'] } });
  m = mergeAlgorandPayTos(m, [], '2026-11-07');
  assert.deepEqual(m.pay_tos, {});
  assert.equal(m.hosts, undefined);
});

test('paymentsOf: a grouped USDC transfer with a fee of 0 is x402; one that paid its own fee, ungrouped, other assets and opt-ins are not', () => {
  const time = `${DAY1}T08:00:00Z`;
  assert.deepEqual(paymentsOf(axfer({ from: BUYER, to: SELLER, amount: 10000, time }), SELLER), [{ dir: 'in', x402: true, from: BUYER, micro: 10000 }]);
  assert.equal(paymentsOf(axfer({ from: BUYER, to: SELLER, amount: 10000, fee: 1000, time }), SELLER)[0].x402, false);
  assert.equal(paymentsOf(axfer({ from: BUYER, to: SELLER, amount: 10000, group: null, time }), SELLER)[0].x402, false);
  assert.deepEqual(paymentsOf(axfer({ from: BUYER, to: SELLER, amount: 10000, asset: 12345, time }), SELLER), []);
  assert.deepEqual(paymentsOf(axfer({ from: SELLER, to: SELLER, amount: 0, fee: 1000, time }), SELLER), [], 'an opt-in');
  assert.deepEqual(paymentsOf(axfer({ from: SELLER, to: BUYER, amount: 5000, fee: 1000, time }), SELLER), [{ dir: 'out', to: BUYER, micro: 5000 }]);
});

test('collectAlgorand: x402 payments counted per day from today on first sight; the next run reads from the last round', async () => {
  const txs = { [SELLER]: [
    axfer({ from: BUYER, to: SELLER, amount: 10000, time: '2026-10-21T23:00:00Z' }), // before the first day: not read
    axfer({ from: BUYER, to: SELLER, amount: 10000, time: `${DAY1}T08:00:00Z` }),
    axfer({ from: BUYER2, to: SELLER, amount: 20000, time: `${DAY1}T09:00:00Z` }),
    axfer({ from: BUYER, to: SELLER, amount: 5000000, fee: 1000, group: null, time: `${DAY1}T09:30:00Z` }), // paid its own fee
  ] };
  const idx = fakeIndexer(txs);
  const logs = [];
  let s = await collectAlgorand(null, { payTos: [SELLER], facilitators: {}, fetchImpl: idx.fetchImpl, now: () => Date.parse(`${DAY1}T12:00:00Z`), minGapMs: 0, log: (l) => logs.push(l) });
  assert.deepEqual(s.pay_tos[SELLER].d[DAY1], [2, 30000, [BUYER.slice(0, 10), BUYER2.slice(0, 10)]]);
  assert.match(idx.calls[0], /asset-id=31566704&after-time=2026-10-22T00:00:00Z/);
  assert.match(logs.at(-1), /2 x402 payments .*1 transfers that paid their own fee left out/);
  const firstRound = s.pay_tos[SELLER].round;
  // The next day: a new payment and USDC sent back to a payer; only rounds after the last one read are asked.
  txs[SELLER].push(axfer({ from: BUYER, to: SELLER, amount: 30000, time: `${DAY2}T01:00:00Z` }));
  txs[SELLER].push(axfer({ from: SELLER, to: BUYER, amount: 40000, fee: 1000, group: null, time: `${DAY2}T02:00:00Z` }));
  idx.calls.length = 0;
  s = await collectAlgorand(s, { payTos: [SELLER], facilitators: {}, fetchImpl: idx.fetchImpl, now: () => Date.parse(`${DAY2}T03:00:00Z`), minGapMs: 0 });
  assert.match(idx.calls[0], new RegExp(`min-round=${firstRound + 1}`));
  assert.deepEqual(s.pay_tos[SELLER].d[DAY2], [1, 30000, [BUYER.slice(0, 10)], { [BUYER.slice(0, 10)]: 40000 }]);
  assert.equal(s.pay_tos[SELLER].d[DAY1][0], 2, 'nothing counted twice');
  assert.deepEqual(Object.keys(s.days), [DAY1, DAY2]);
});

test('collectAlgorand: addresses the facilitator paid for are found, watched and counted in the same run, with whose facilitator', async () => {
  const time = `${DAY1}T08:00:00Z`;
  const paid = axfer({ from: BUYER, to: UNLISTED, amount: 5000, time });
  const earlier = axfer({ from: BUYER, to: BUYER2, amount: 1000, time: '2026-10-20T08:00:00Z' });
  const ownFee = axfer({ from: BUYER, to: SELLER, amount: 1000, fee: 1000, time }); // in a group, but paid its own fee
  const txs = {
    [FEE]: [feeTx(paid), feeTx(earlier), feeTx(ownFee)],
    [UNLISTED]: [paid],
    [BUYER2]: [earlier],
    [SELLER]: [],
    'group-only': [ownFee],
  };
  const idx = fakeIndexer(txs);
  const logs = [];
  const now = () => Date.parse(`${DAY1}T12:00:00Z`);
  let s = await collectAlgorand(null, { payTos: [SELLER], fetchImpl: idx.fetchImpl, now, minGapMs: 0, log: (l) => logs.push(l) });
  assert.deepEqual(Object.keys(s.found).sort(), [BUYER2, UNLISTED].sort());
  assert.deepEqual(s.found[UNLISTED], { via: 'GoPlausible', first: DAY1, seen: DAY1 });
  assert.equal(s.found[BUYER2].first, '2026-10-20');
  assert.deepEqual(s.pay_tos[UNLISTED].d[DAY1], [1, 5000, [BUYER.slice(0, 10)]], 'counted in the run that found it');
  assert.equal(s.pay_tos[BUYER2].since, DAY1, 'counted from the day it was found');
  assert.match(logs.find((l) => /facilitator groups/.test(l)), /3 facilitator groups read, 2 new payout addresses found/);
  // The next run asks the fee payer only for rounds after the last one read.
  idx.calls.length = 0;
  s = await collectAlgorand(s, { payTos: [SELLER], fetchImpl: idx.fetchImpl, now, minGapMs: 0 });
  assert.match(idx.calls.find((c) => c.includes(`/accounts/${FEE}/`)), /min-round=/);
  assert.ok(!idx.calls.some((c) => c.startsWith('/v2/transactions?')), 'no new groups to open');

  // The reader: totals say how many were found that way, the list names the facilitator for an address no scan lists.
  s.updated = `${DAY2}T01:00:00Z`;
  assert.equal(totalsOf(s).watched_found, 2);
  assert.deepEqual(sellersOf(s, { hosts: {} }).sellers.map((x) => [x.pay_to, x.found_via]), [[UNLISTED, 'GoPlausible']]);
  // Not paid through the facilitator for 14 days: no longer watched once its days are gone.
  const later = await collectAlgorand(s, { payTos: [SELLER], fetchImpl: fakeIndexer({}).fetchImpl, now: () => Date.parse('2026-11-07T12:00:00Z'), minGapMs: 0 });
  assert.equal(later.found[UNLISTED], undefined);
  assert.equal(later.pay_tos[UNLISTED], undefined);
});

function paymentsFile() {
  return {
    version: 1, network: ALGORAND, token: String(USDC_ASA), per_day: 1, updated: `${DAY2}T09:00:00Z`, days: { [DAY1]: { covered: 1 } },
    pay_tos: { [SELLER]: { since: DAY1, d: { [DAY1]: [6, 52000, [BUYER.slice(0, 10), BUYER2.slice(0, 10)]] }, round: 5 }, [BUYER]: { since: DAY1, d: {}, round: null } },
  };
}
const baseFile = { version: 1, network: 'eip155:8453', updated: `${DAY2}T09:00:00Z`, days: {}, pay_tos: {} };
const files = (info = {}) => async (url) => ({ ok: true, json: async () => (url.includes('paytos-algorand') ? info : url.includes('payments-algorand') ? paymentsFile() : url.includes('paytos') ? {} : baseFile) });
const reader = (fetchImpl) => createOnchainPayments({ url: 'https://x/payments.json', solanaUrl: '', xrplUrl: '', xrplPayTosUrl: '', stellarUrl: '', stellarPayTosUrl: '', algorandUrl: 'https://x/payments-algorand.json', algorandPayTosUrl: 'https://x/paytos-algorand.json', fetchImpl });

test('createOnchainPayments: Algorand addresses are looked up in the Algorand file; totals and sellers with hosts', async () => {
  const p = reader(files({ network: ALGORAND, pay_tos: { [SELLER]: DAY1 }, hosts: { [SELLER]: ['api.example.com'] } }));
  await p.refresh();
  const w = await p.lookup(SELLER);
  assert.deepEqual([w.network, w.payments, w.usd, w.payers], [ALGORAND, 6, 0.05, 2]);
  assert.equal((await p.totalsAlgorand()).pay_tos_paid, 1);
  assert.deepEqual((await p.sellersAlgorand()).sellers.map((s) => [s.pay_to, s.hosts]), [[SELLER, ['api.example.com']]]);
  assert.equal(p.loaded(SELLER), true);
});

test('web check: an Algorand USDC option without a Base, Solana, XRPL or Stellar one is looked up by its payout address', async () => {
  const asked = [];
  const checks = [];
  const found = { network: ALGORAND, days: 7, payments: 6, payers: 2, usd: 0.05, coverage: 1 };
  await checkOnchainPayments([{ scheme: 'exact', network: ALGORAND, asset: '31566704', payTo: SELLER }], { lookup: async (a) => { asked.push(a); return found; }, loaded: () => true }, checks);
  assert.deepEqual(asked, [SELLER]);
  assert.match(checks[0].message, /^Real payments on Algorand in the last 7 days: 2 different wallets paid this payout address \(.+\) 6 times, \$0\.05 in USDC in total\./);
  assert.match(checks[0].hint, /fee another transaction paid/);
});

test('GET /api/trust/payments?network=algorand: the list as JSON, 503 before a complete day; the summary has the totals', async () => {
  const trustIndex = { lookup: async () => null, refresh: () => Promise.resolve(), summary: () => null };
  const start = (app) => new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve({ s, base: `http://127.0.0.1:${s.address().port}` })); });
  const { s, base } = await start(createApp({ allowPrivate: true, env: {}, trustIndex, onchainPayments: reader(files()) }));
  try {
    const res = await fetch(`${base}/api/trust/payments?network=algorand`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.network, ALGORAND);
    assert.equal(body.sellers[0].pay_to, SELLER);
  } finally { s.close(); }
  const empty = reader(async (url) => ({ ok: true, json: async () => (url.includes('payments-algorand') ? { ...paymentsFile(), days: {} } : url.includes('paytos') ? {} : baseFile) }));
  const second = await start(createApp({ allowPrivate: true, env: {}, trustIndex, onchainPayments: empty }));
  try {
    const res = await fetch(`${second.base}/api/trust/payments?network=algorand`);
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /no complete day of Algorand payments/);
  } finally { second.s.close(); }
});
