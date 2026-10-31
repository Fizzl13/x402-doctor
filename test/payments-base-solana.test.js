// GET /api/trust/payments?network=base|solana: the payout addresses paid in the window, most money first, from the
// Base and Solana files the reader already loads (no names or hosts for them). No network.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOnchainPayments } = require('../lib/onchain-payments');

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const C = '0xcccccccccccccccccccccccccccccccccccccccc';
const S = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const day = '2026-10-30';
const base = { version: 1, updated: '2026-10-31T05:00:00.000Z', last_block: 1, days: { [day]: { covered: 43200 } }, pay_tos: {
  [A]: { since: day, d: { [day]: [2, 10000, ['p1', 'p2']] } },
  [B]: { since: day, d: { [day]: [5, 500000, ['p1']] } },
  [C]: { since: day, d: {} },
} };
const solana = { version: 1, network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', updated: base.updated, last_slot: 1, days: { [day]: { covered: 216000 } }, pay_tos: { [S]: { since: day, d: { [day]: [1, 20000, ['p9']] } } } };

function reader() {
  let reads = 0;
  const fetchImpl = async (url) => { reads += 1; return { ok: true, json: async () => (url.includes('solana') ? solana : base) }; };
  const p = createOnchainPayments({ url: 'https://x/payments.json', solanaUrl: 'https://x/payments-solana.json', xrplUrl: '', xrplPayTosUrl: '', stellarUrl: '', stellarPayTosUrl: '', algorandUrl: '', algorandPayTosUrl: '', xlayerUrl: '', xlayerPayTosUrl: '', fetchImpl });
  return { p, reads: () => reads };
}

test('sellersBase: paid payout addresses only, most money first, limited', async () => {
  const { p } = reader();
  const list = await p.sellersBase({ waitMs: 1000 });
  assert.equal(list.watched, 3);
  assert.equal(list.paid, 2);
  assert.deepEqual(list.total, { payments: 7, usd: 0.51, payers: 2, usd_paid_back: 0 });
  assert.deepEqual(list.sellers.map((s) => [s.pay_to, s.payments, s.usd, s.payers, s.hosts]), [[B, 5, 0.5, 1, []], [A, 2, 0.01, 2, []]]);
  assert.deepEqual((await p.sellersBase({ limit: 1 })).sellers.map((s) => s.pay_to), [B]);
  assert.equal(await p.sellersBase({ limit: 1 }), await p.sellersBase({ limit: 1 }), 'one list per loaded file and limit');
});

test('sellersSolana: the Solana file, with its network', async () => {
  const { p } = reader();
  const list = await p.sellersSolana({ waitMs: 1000 });
  assert.equal(list.network, solana.network);
  assert.deepEqual(list.sellers.map((s) => [s.pay_to, s.payments, s.usd]), [[S, 1, 0.02]]);
});

test('GET /api/trust/payments?network=base: at most 100, CORS for any page', async () => {
  const { createApp } = require('../server');
  const many = { ...base, pay_tos: Object.fromEntries(Array.from({ length: 130 }, (_, i) => [`0x${String(i).padStart(40, '0')}`, { since: day, d: { [day]: [1, 1000 * (i + 1), ['p1']] } }])) };
  const onchainPayments = createOnchainPayments({ url: 'https://x/payments.json', solanaUrl: '', xrplUrl: '', xrplPayTosUrl: '', stellarUrl: '', stellarPayTosUrl: '', algorandUrl: '', algorandPayTosUrl: '', xlayerUrl: '', xlayerPayTosUrl: '', fetchImpl: async () => ({ ok: true, json: async () => many }) });
  const trustIndex = { lookup: async () => null, refresh: () => Promise.resolve(), summary: () => null };
  const app = createApp({ allowPrivate: true, env: {}, trustIndex, onchainPayments });
  const s = await new Promise((resolve) => { const srv = app.listen(0, '127.0.0.1', () => resolve(srv)); });
  try {
    const res = await fetch(`http://127.0.0.1:${s.address().port}/api/trust/payments?network=base`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    const body = await res.json();
    assert.equal(body.paid, 130);
    assert.equal(body.sellers.length, 100);
    assert.equal(body.sellers[0].usd, 0.13);
  } finally { s.close(); }
});
