// Real payments on Polygon and Arbitrum (lib/onchain-payments-evm.js): the chains, the scan's payout addresses, the
// merge, a count against a fake node, and the reader, web check and API naming them. No network.

const test = require('node:test');
const assert = require('node:assert/strict');
const { CHAINS, KEYS, keyOf, isEvmUsdc, mergeEvmPayTos, evmPayTosOf, collectEvm } = require('../lib/onchain-payments-evm');
const { createOnchainPayments, TRANSFER, AUTH_USED, USDC: BASE_USDC } = require('../lib/onchain-payments');
const { payTosOf } = require('../lib/trust-scan');
const { checkOnchainPayments } = require('../lib/diagnose');

const P1 = '0x1111111111111111111111111111111111111111';
const P2 = '0x2222222222222222222222222222222222222222';
const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const OTHER = '0x3333333333333333333333333333333333333333';
const POLY_USDC = CHAINS.polygon.usdc;
const ARB_USDC = CHAINS.arbitrum.usdc;
const pad = (a) => `0x${a.toLowerCase().slice(2).padStart(64, '0')}`;
const hex = (n) => `0x${n.toString(16)}`;

test('Polygon and Arbitrum: Circle\'s USDC, their CAIP-2 ids and public nodes', () => {
  assert.deepEqual(KEYS, ['polygon', 'arbitrum']);
  assert.equal(CHAINS.polygon.network, 'eip155:137');
  assert.equal(POLY_USDC, '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359');
  assert.equal(CHAINS.arbitrum.network, 'eip155:42161');
  assert.equal(ARB_USDC, '0xaf88d065e77c8cc2239327c5edb3a432268e5831');
  assert.equal(keyOf('eip155:137'), 'polygon');
  assert.equal(keyOf('eip155:8453'), null);
  assert.equal(isEvmUsdc('eip155:42161', '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'), true);
  assert.equal(isEvmUsdc('eip155:42161', POLY_USDC), false, 'Polygon\'s USDC is not Arbitrum\'s');
  assert.equal(isEvmUsdc('eip155:8453', BASE_USDC), false);
});

test('payTosOf: polygon_pay_tos and arbitrum_pay_tos for USDC, lowercase, once; other tokens and placeholders left out', () => {
  const up = '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD';
  const options = [
    { network: 'eip155:137', asset: POLY_USDC, pay_to: up },
    { network: 'eip155:137', asset: POLY_USDC, pay_to: up.toLowerCase() },
    { network: 'eip155:137', asset: OTHER, pay_to: P1 },
    { network: 'eip155:42161', asset: ARB_USDC, pay_to: P2 },
    { network: 'eip155:42161', asset: ARB_USDC, pay_to: '0x000000000000000000000000000000000000dEaD' },
  ];
  assert.deepEqual(evmPayTosOf(options), { polygon_pay_tos: [up.toLowerCase()], arbitrum_pay_tos: [P2] });
  const all = payTosOf(options);
  assert.deepEqual(all.polygon_pay_tos, [up.toLowerCase()]);
  assert.deepEqual(all.arbitrum_pay_tos, [P2]);
});

test('mergeEvmPayTos: per network, the day last seen and the hosts, dropped after 14 days', () => {
  let m = mergeEvmPayTos('polygon', null, [{ url: 'https://a.example/x', polygon_pay_tos: [P1], arbitrum_pay_tos: [P2] }, { url: 'https://b.example/y', polygon_pay_tos: ['nope'] }], '2026-11-05');
  assert.deepEqual(m, { network: 'eip155:137', updated: '2026-11-05', pay_tos: { [P1]: '2026-11-05' }, hosts: { [P1]: ['a.example'] } });
  m = mergeEvmPayTos('polygon', m, [{ url: 'https://c.example/z', polygon_pay_tos: [P2] }], '2026-11-20');
  assert.deepEqual(m.pay_tos, { [P2]: '2026-11-20' });
  assert.equal(mergeEvmPayTos('arbitrum', null, [{ arbitrum_pay_tos: [P2] }], '2026-11-05').network, 'eip155:42161');
});

// A node with 2-second blocks (Polygon) whose tip is `tip` at headIso; transfers: [block, token, from, to, micro, signed].
function fakeNode({ tip, headIso, transfers, blockSeconds = 2 }) {
  const logs = transfers.map(([block, token, from, to, value, signed], i) => ({ block, token, from: from.toLowerCase(), to: to.toLowerCase(), value, signed, tx: `0x${String(i + 1).padStart(64, '0')}` }));
  const reply = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) });
  return async (_url, { body }) => {
    const { method, params } = JSON.parse(body);
    if (method === 'eth_blockNumber') return reply(hex(tip));
    if (method === 'eth_getBlockByNumber') return reply({ number: params[0], timestamp: hex(Math.round(Date.parse(headIso) / 1000 - blockSeconds * (tip - parseInt(params[0], 16)))) });
    const f = params[0];
    const from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16);
    const tokens = new Set([].concat(f.address).map((a) => a.toLowerCase()));
    const inRange = logs.filter((l) => l.block >= from && l.block <= to && tokens.has(l.token));
    if (f.topics[0] === TRANSFER) {
      const senders = f.topics[1] ? new Set(f.topics[1]) : null, targets = f.topics[2] ? new Set(f.topics[2]) : null;
      return reply(inRange.filter((l) => (!senders || senders.has(pad(l.from))) && (!targets || targets.has(pad(l.to)))).map((l) => ({ address: l.token, topics: [TRANSFER, pad(l.from), pad(l.to)], data: hex(l.value), blockNumber: hex(l.block), transactionHash: l.tx })));
    }
    const who = new Set(f.topics[1]);
    return reply(inRange.filter((l) => l.signed && who.has(pad(l.from))).map((l) => ({ address: l.token, topics: [AUTH_USED, pad(l.from), pad('0x01')], data: '0x', blockNumber: hex(l.block), transactionHash: l.tx })));
  };
}

test('collectEvm: signed USDC payments on Polygon per payout address per day; unsigned and other tokens left out', async () => {
  // Tip after 10 confirmations: block 100000 at 03:00 UTC on 5 Nov (2-second blocks: midnight is block 94600).
  const fetchImpl = fakeNode({
    tip: 100010,
    headIso: '2026-11-05T03:00:20Z',
    transfers: [
      [96000, POLY_USDC, A, P1, 10000, true],
      [97000, POLY_USDC, B, P1, 20000, true],
      [98000, POLY_USDC, A, P1, 30000, false], // a plain transfer: not an x402 payment
      [99000, OTHER, A, P1, 40000, true], // another token
    ],
  });
  const state = await collectEvm('polygon', null, { payTos: [P1], nodes: ['https://node.test'], fetchImpl, now: () => Date.parse('2026-11-05T03:00:30Z') });
  assert.equal(state.network, 'eip155:137');
  const day = state.days['2026-11-05'];
  assert.ok(day.covered > 0);
  const counts = Object.values(state.pay_tos[P1]?.d || {});
  assert.equal(counts.reduce((n, d) => n + d[0], 0), 2, JSON.stringify(state.pay_tos));
  assert.equal(counts.reduce((n, d) => n + d[1], 0), 30000);
});

test('reader, web check and API: an Arbitrum USDC option is looked up in payments-arbitrum.json and named Arbitrum', async () => {
  const arb = { version: 1, network: 'eip155:42161', symbol: 'USDC', token: ARB_USDC, per_day: 345600, updated: '2026-11-05T05:00:00.000Z', last_block: 1, days: { '2026-11-04': { covered: 345600 } }, pay_tos: { [P2]: { since: '2026-11-04', d: { '2026-11-04': [3, 30000, ['aa', 'bb']] } } } };
  const base = { version: 1, updated: '2026-11-05T05:00:00.000Z', last_block: 1, days: {}, pay_tos: {} };
  const fetchImpl = async (url) => ({ ok: true, json: async () => (url.includes('payments-arbitrum') ? arb : url.includes('paytos-arbitrum') ? { hosts: { [P2]: ['arb.example'] } } : base) });
  const payments = createOnchainPayments({ url: 'https://x/payments.json', solanaUrl: '', xrplUrl: '', xrplPayTosUrl: '', stellarUrl: '', stellarPayTosUrl: '', algorandUrl: '', algorandPayTosUrl: '', xlayerUrl: '', xlayerPayTosUrl: '', monadUrl: '', monadPayTosUrl: '', evmUrls: { polygon: {}, arbitrum: { data: 'https://x/payments-arbitrum.json', paytos: 'https://x/paytos-arbitrum.json' } }, fetchImpl });
  const t = await payments.totalsEvm('arbitrum', { waitMs: 1000 });
  assert.deepEqual([t.network, t.payments, t.payers, t.usd], ['eip155:42161', 3, 2, 0.03]);
  assert.equal(await payments.totalsEvm('polygon'), null, 'no Polygon file yet');
  const list = await payments.sellersEvm('arbitrum');
  assert.deepEqual(list.sellers[0].hosts, ['arb.example']);
  assert.equal(await payments.lookup(P2), null, 'without a network an EVM address is looked up on Base');
  const w = await payments.lookup(P2, { network: 'eip155:42161' });
  assert.equal(w.payments, 3);

  const checks = [];
  await checkOnchainPayments([{ scheme: 'exact', network: 'eip155:42161', asset: ARB_USDC, payTo: P2 }], { lookup: async (a, o) => (o.network === 'eip155:42161' ? { network: o.network, symbol: 'USDC', days: 7, payments: 3, payers: 2, usd: 0.03, coverage: 1 } : null), loaded: () => true }, checks);
  assert.match(checks[0].message, /^Real payments on Arbitrum in the last 7 days/);
  assert.match(checks[0].hint, /USDC payments the buyer signed with EIP-3009/);

  const { createApp } = require('../server');
  const trustIndex = { lookup: async () => null, refresh: () => Promise.resolve(), summary: () => null };
  const app = createApp({ allowPrivate: true, env: {}, trustIndex, onchainPayments: payments });
  const srv = await new Promise((resolve) => { const x = app.listen(0, '127.0.0.1', () => resolve(x)); });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/trust/payments?network=arbitrum`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).sellers[0].pay_to, P2);
    const none = await fetch(`http://127.0.0.1:${srv.address().port}/api/trust/payments?network=polygon`);
    assert.equal(none.status, 503);
    assert.match((await none.json()).error, /no complete day of Polygon payments/);
  } finally { srv.close(); }
});
