// Real payments on X Layer (lib/onchain-payments-xlayer.js) against a fake X Layer node: 1-second blocks, getLogs at
// most 100 blocks wide, USD₮0 and USDC transfers the payer signed with EIP-3009 to watched payout addresses, counted per
// UTC day; and the reader and GET /api/trust/payments naming X Layer. No network.

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeXlayerPayTos, collectXlayer, XLAYER, TOKENS } = require('../lib/onchain-payments-xlayer');
const { createOnchainPayments, TRANSFER, AUTH_USED, USDC } = require('../lib/onchain-payments');
const { payTosOf } = require('../lib/trust-scan');
const { checkOnchainPayments } = require('../lib/diagnose');
const { createApp } = require('../server');

const USDT0 = '0x779ded0c9e1022225f8e0630b35a9b54be713736';
const XUSDC = '0x74b7f16337b8972027f6196a17a631ac6de26d22';
const P1 = '0x1111111111111111111111111111111111111111';
const P2 = '0x2222222222222222222222222222222222222222';
const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const pad = (a) => `0x${a.toLowerCase().slice(2).padStart(64, '0')}`;
const hex = (n) => `0x${n.toString(16)}`;

// A node whose tip is `tip` (1-second blocks, tip at headIso) that refuses getLogs wider than 100 blocks, as
// rpc.xlayer.tech does. transfers: [block, token, from, to, micro, signedOn] (signedOn: the token whose
// AuthorizationUsed the same transaction emitted, or null).
function fakeNode({ tip, headIso, transfers }) {
  const spans = [];
  const logs = transfers.map(([block, token, from, to, value, signedOn], i) => ({ block, token, from: from.toLowerCase(), to: to.toLowerCase(), value, signedOn, tx: `0x${String(i + 1).padStart(64, '0')}` }));
  const reply = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) });
  const fail = (message) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: -32000, message } }) });
  const fetchImpl = async (_url, { body }) => {
    const { method, params } = JSON.parse(body);
    if (method === 'eth_blockNumber') return reply(hex(tip));
    if (method === 'eth_getBlockByNumber') return reply({ number: params[0], timestamp: hex(Date.parse(headIso) / 1000 - (tip - parseInt(params[0], 16))) });
    if (method === 'eth_getLogs') {
      const f = params[0];
      const from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16);
      spans.push(to - from + 1);
      if (to - from + 1 > 100) return fail('block range is too large, max 100');
      const tokens = new Set([].concat(f.address).map((a) => a.toLowerCase()));
      const inRange = logs.filter((l) => l.block >= from && l.block <= to);
      if (f.topics[0] === TRANSFER) {
        const senders = f.topics[1] ? new Set(f.topics[1]) : null, targets = f.topics[2] ? new Set(f.topics[2]) : null;
        return reply(inRange.filter((l) => tokens.has(l.token) && (!senders || senders.has(pad(l.from))) && (!targets || targets.has(pad(l.to)))).map((l) => ({ address: l.token, topics: [TRANSFER, pad(l.from), pad(l.to)], data: hex(l.value), blockNumber: hex(l.block), transactionHash: l.tx })));
      }
      if (f.topics[0] === AUTH_USED) {
        const who = new Set(f.topics[1]);
        return reply(inRange.filter((l) => l.signedOn && tokens.has(l.signedOn) && who.has(pad(l.from))).map((l) => ({ address: l.signedOn, topics: [AUTH_USED, pad(l.from), pad('0x01')], data: '0x', blockNumber: hex(l.block), transactionHash: l.tx })));
      }
    }
    return fail(`unexpected ${method}`);
  };
  return { fetchImpl, spans };
}

test('payTosOf: X Layer payout addresses for USD₮0 or USDC, lowercase, once each; other tokens and placeholders left out', () => {
  const up = '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD';
  assert.deepEqual(payTosOf([
    { network: XLAYER, asset: USDT0.toUpperCase().replace('0X', '0x'), pay_to: up },
    { network: XLAYER, asset: XUSDC, pay_to: up.toLowerCase() },
    { network: XLAYER, asset: XUSDC, pay_to: P1 },
    { network: XLAYER, asset: '0x4ae46a509f6b1d9056937ba4500cb143933d2dc8', pay_to: P2 }, // USDG: not counted here
    { network: XLAYER, asset: USDT0, pay_to: '0x000000000000000000000000000000000000dEaD' },
    { network: 'eip155:8453', asset: USDC, pay_to: P2 },
  ]), { pay_tos: [P2], xlayer_pay_tos: [up.toLowerCase(), P1] });
  assert.deepEqual(TOKENS, [XUSDC, USDT0]);
});

test('mergeXlayerPayTos: lowercase, the day last seen and the endpoints\' hosts, dropped after 14 days', () => {
  let m = mergeXlayerPayTos(null, [{ url: 'https://a.example/x', xlayer_pay_tos: ['0xAbCd000000000000000000000000000000000001'] }, { url: 'https://b.example/y', xlayer_pay_tos: [P1, 'nope'] }, {}], '2026-10-28');
  const lower = '0xabcd000000000000000000000000000000000001';
  assert.deepEqual(m, { network: XLAYER, updated: '2026-10-28', pay_tos: { [lower]: '2026-10-28', [P1]: '2026-10-28' }, hosts: { [lower]: ['a.example'], [P1]: ['b.example'] } });
  m = mergeXlayerPayTos(m, [{ url: 'https://c.example/z', xlayer_pay_tos: [P2] }], '2026-11-12');
  assert.deepEqual(m.pay_tos, { [P2]: '2026-11-12' });
  assert.deepEqual(m.hosts, { [P2]: ['c.example'] });
});

test('collectXlayer: signed USD₮0 and USDC payments per payout address per day, 100 blocks per call; unsigned ones left out', async () => {
  // The tip (after 10 confirmations) is block 50000 at 00:10 UTC on 28 Oct: block 49400 is midnight.
  const node = fakeNode({
    tip: 50010,
    headIso: '2026-10-28T00:10:10Z',
    transfers: [
      [42000, USDT0, A, P1, 10000, USDT0], // 27 Oct, 22:06
      [43000, XUSDC, A, P1, 20000, XUSDC],
      [44000, USDT0, B, P1, 30000, null], // a plain transfer, not an x402 payment
      [45000, USDT0, B, P1, 30000, XUSDC], // the authorization was on another token: not this transfer's
      [49500, XUSDC, B, P2, 40000, XUSDC], // 28 Oct
      [49600, '0x4ae46a509f6b1d9056937ba4500cb143933d2dc8', A, P2, 50000, '0x4ae46a509f6b1d9056937ba4500cb143933d2dc8'], // a token not watched
    ],
  });
  const lines = [];
  const state = await collectXlayer(null, { payTos: [P1, P2], nodes: ['https://node.test'], fetchImpl: node.fetchImpl, now: () => Date.parse('2026-10-28T00:11:00Z'), log: (l) => lines.push(l) });
  assert.ok(Math.max(...node.spans) <= 100, 'never more than 100 blocks per getLogs');
  assert.equal(state.network, XLAYER);
  assert.equal(state.symbol, 'USD₮0 or USDC');
  assert.deepEqual(state.tokens, TOKENS);
  assert.equal(state.per_day, 86400);
  assert.equal(state.last_block, 50000);
  assert.deepEqual(state.pay_tos[P1].d['2026-10-27'], [2, 30000, [A.slice(2, 12)]]);
  assert.deepEqual(state.pay_tos[P2].d['2026-10-28'], [1, 40000, [B.slice(2, 12)]]);
  // First run: the last 9,000 blocks (2.5 hours of 1-second blocks), split at midnight.
  assert.deepEqual(state.days, { '2026-10-27': { covered: 8400 }, '2026-10-28': { covered: 601 } });
  assert.match(lines.at(-1), /3 signed payments and 0 outgoing transfers added, up to block 50000/);

  // A Base file is never continued as X Layer's (another chain's block numbers).
  const fromBase = await collectXlayer({ version: 1, network: 'eip155:8453', last_block: 1, days: {}, pay_tos: {} }, { payTos: [P1], nodes: ['https://node.test'], fetchImpl: node.fetchImpl, now: () => Date.parse('2026-10-28T00:11:00Z') });
  assert.equal(fromBase.network, XLAYER);
  assert.equal(fromBase.days['2026-10-27'].covered, 8400);
});

test('createOnchainPayments: X Layer totals and who gets paid, with the hosts from the scan', async () => {
  const data = { version: 1, network: XLAYER, symbol: 'USD₮0 or USDC', tokens: TOKENS, per_day: 86400, updated: '2026-10-29T05:00:00.000Z', last_block: 1, days: { '2026-10-28': { covered: 86400 } }, pay_tos: { [P1]: { since: '2026-10-28', d: { '2026-10-28': [3, 30000, ['aa', 'bb']] } }, [P2]: { since: '2026-10-28', d: {} } } };
  const base = { version: 1, updated: '2026-10-29T05:00:00.000Z', last_block: 1, days: {}, pay_tos: {} };
  const fetchImpl = async (url) => ({ ok: true, json: async () => (url.includes('payments-xlayer') ? data : url.includes('paytos-xlayer') ? { hosts: { [P1]: ['a.example'] } } : base) });
  const payments = createOnchainPayments({ url: 'https://x/payments.json', solanaUrl: '', xrplUrl: '', xrplPayTosUrl: '', stellarUrl: '', stellarPayTosUrl: '', algorandUrl: '', algorandPayTosUrl: '', xlayerUrl: 'https://x/payments-xlayer.json', xlayerPayTosUrl: 'https://x/paytos-xlayer.json', fetchImpl });
  const t = await payments.totalsXlayer({ waitMs: 1000 });
  assert.deepEqual([t.network, t.symbol, t.days, t.watched, t.pay_tos_paid, t.payments, t.payers, t.usd, t.coverage], [XLAYER, 'USD₮0 or USDC', 1, 2, 1, 3, 2, 0.03, 1]);
  const list = await payments.sellersXlayer();
  assert.deepEqual(list.sellers, [{ pay_to: P1, name: null, hosts: ['a.example'], payments: 3, usd: 0.03, payers: 2, payers_wide: 0 }]);
  assert.equal(await payments.lookup(P1), null, 'without a network an EVM address is looked up on Base');
  const w = await payments.lookup(P1.toUpperCase().replace('0X', '0x'), { network: XLAYER });
  assert.deepEqual([w.network, w.symbol, w.payments, w.usd, w.payers], [XLAYER, 'USD₮0 or USDC', 3, 0.03, 2]);
  assert.equal(payments.loaded(P1, XLAYER), true);
});

test('web check: an X Layer USD₮0 option without a Base one is looked up on X Layer and named so', async () => {
  const asked = [];
  const checks = [];
  const found = { network: XLAYER, symbol: 'USD₮0 or USDC', days: 7, payments: 4, payers: 2, usd: 0.04, coverage: 1 };
  await checkOnchainPayments([{ scheme: 'exact', network: XLAYER, asset: USDT0, payTo: P1 }], { lookup: async (a, o) => { asked.push([a, o.network]); return found; }, loaded: () => true }, checks);
  assert.deepEqual(asked, [[P1, XLAYER]]);
  assert.match(checks[0].message, /^Real payments on X Layer in the last 7 days: 2 different wallets paid this payout address \(.+\) 4 times, \$0\.04 in USD₮0 or USDC in total\./);
  assert.match(checks[0].hint, /USD₮0 and USDC payments the buyer signed with EIP-3009/);
  // An offer in another token on X Layer isn't counted: nothing said.
  const none = [];
  await checkOnchainPayments([{ scheme: 'exact', network: XLAYER, asset: '0x4ae46a509f6b1d9056937ba4500cb143933d2dc8', payTo: P1 }], { lookup: async () => found, loaded: () => true }, none);
  assert.deepEqual(none, []);
});

test('GET /api/trust/payments?network=xlayer: the list as JSON, 503 before a complete day', async () => {
  const file = (days) => ({ version: 1, network: XLAYER, updated: '2026-10-29T05:00:00.000Z', last_block: 1, per_day: 86400, days, pay_tos: { [P1]: { since: '2026-10-28', d: { '2026-10-28': [1, 10000, ['aa']] } } } });
  const base = { version: 1, updated: '2026-10-29T05:00:00.000Z', last_block: 1, days: {}, pay_tos: {} };
  const reader = (days) => createOnchainPayments({ url: 'https://x/payments.json', solanaUrl: '', xrplUrl: '', xrplPayTosUrl: '', stellarUrl: '', stellarPayTosUrl: '', algorandUrl: '', algorandPayTosUrl: '', xlayerUrl: 'https://x/payments-xlayer.json', xlayerPayTosUrl: '', fetchImpl: async (url) => ({ ok: true, json: async () => (url.includes('xlayer') ? file(days) : base) }) });
  const trustIndex = { lookup: async () => null, refresh: () => Promise.resolve(), summary: () => null };
  const start = (app) => new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve({ s, base: `http://127.0.0.1:${s.address().port}` })); });
  const first = await start(createApp({ allowPrivate: true, env: {}, trustIndex, onchainPayments: reader({ '2026-10-28': { covered: 86400 } }) }));
  try {
    const res = await fetch(`${first.base}/api/trust/payments?network=xlayer`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.network, XLAYER);
    assert.equal(body.sellers[0].pay_to, P1);
  } finally { first.s.close(); }
  const second = await start(createApp({ allowPrivate: true, env: {}, trustIndex, onchainPayments: reader({}) }));
  try {
    const res = await fetch(`${second.base}/api/trust/payments?network=xlayer`);
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /no complete day of X Layer payments/);
  } finally { second.s.close(); }
});
