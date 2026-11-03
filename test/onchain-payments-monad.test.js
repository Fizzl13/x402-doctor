// Real payments on Monad (lib/onchain-payments-monad.js) against a fake Monad node: 0.3-second blocks, getLogs at most
// 100 blocks wide, USDC transfers the payer signed with EIP-3009 to watched payout addresses, counted per UTC day; and
// the reader, the web check, the preflight's choice and GET /api/trust/payments naming Monad. No network.

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeMonadPayTos, collectMonad, isMonadUsdc, MONAD, USDC, TOKENS, PUBLIC_RPC } = require('../lib/onchain-payments-monad');
const { createOnchainPayments, TRANSFER, AUTH_USED, USDC: BASE_USDC } = require('../lib/onchain-payments');
const { payTosOf } = require('../lib/trust-scan');
const { checkOnchainPayments } = require('../lib/diagnose');
const { createApp } = require('../server');

const P1 = '0x1111111111111111111111111111111111111111';
const P2 = '0x2222222222222222222222222222222222222222';
const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const OTHER_TOKEN = '0x3333333333333333333333333333333333333333';
const pad = (a) => `0x${a.toLowerCase().slice(2).padStart(64, '0')}`;
const hex = (n) => `0x${n.toString(16)}`;

// A node whose tip is `tip` (0.3-second blocks, tip at headIso) that refuses getLogs wider than 100 blocks, as
// rpc.monad.xyz does. transfers: [block, token, from, to, micro, signedOn].
function fakeNode({ tip, headIso, transfers }) {
  const spans = [];
  const logs = transfers.map(([block, token, from, to, value, signedOn], i) => ({ block, token, from: from.toLowerCase(), to: to.toLowerCase(), value, signedOn, tx: `0x${String(i + 1).padStart(64, '0')}` }));
  const reply = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) });
  const fail = (message) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: -32614, message } }) });
  const fetchImpl = async (_url, { body }) => {
    const { method, params } = JSON.parse(body);
    if (method === 'eth_blockNumber') return reply(hex(tip));
    if (method === 'eth_getBlockByNumber') return reply({ number: params[0], timestamp: hex(Math.round(Date.parse(headIso) / 1000 - 0.3 * (tip - parseInt(params[0], 16)))) });
    if (method === 'eth_getLogs') {
      const f = params[0];
      const from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16);
      spans.push(to - from + 1);
      if (to - from + 1 > 100) return fail('eth_getLogs is limited to a 100 range');
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

test('Monad: Circle\'s USDC on chain 143, read from rpc.monad.xyz', () => {
  assert.equal(MONAD, 'eip155:143');
  assert.equal(USDC, '0x754704bc059f8c67012fed69bc8a327a5aafb603');
  assert.deepEqual(TOKENS, [USDC]);
  assert.equal(PUBLIC_RPC, 'https://rpc.monad.xyz');
  assert.equal(isMonadUsdc(MONAD, '0x754704Bc059F8C67012fEd69BC8A327a5aafb603'), true);
  assert.equal(isMonadUsdc(MONAD, OTHER_TOKEN), false);
  assert.equal(isMonadUsdc('eip155:8453', USDC), false);
});

test('payTosOf: Monad payout addresses for USDC, lowercase, once each; other tokens and placeholders left out', () => {
  const up = '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD';
  assert.deepEqual(payTosOf([
    { network: MONAD, asset: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', pay_to: up },
    { network: MONAD, asset: USDC, pay_to: up.toLowerCase() },
    { network: MONAD, asset: USDC, pay_to: P1 },
    { network: MONAD, asset: OTHER_TOKEN, pay_to: P2 },
    { network: MONAD, asset: USDC, pay_to: '0x000000000000000000000000000000000000dEaD' },
    { network: 'eip155:8453', asset: BASE_USDC, pay_to: P2 },
  ]), { pay_tos: [P2], monad_pay_tos: [up.toLowerCase(), P1] });
});

test('mergeMonadPayTos: lowercase, the day last seen and the endpoints\' hosts, dropped after 14 days', () => {
  let m = mergeMonadPayTos(null, [{ url: 'https://a.example/x', monad_pay_tos: ['0xAbCd000000000000000000000000000000000001'] }, { url: 'https://b.example/y', monad_pay_tos: [P1, 'nope'] }, {}], '2026-11-03');
  const lower = '0xabcd000000000000000000000000000000000001';
  assert.deepEqual(m, { network: MONAD, updated: '2026-11-03', pay_tos: { [lower]: '2026-11-03', [P1]: '2026-11-03' }, hosts: { [lower]: ['a.example'], [P1]: ['b.example'] } });
  m = mergeMonadPayTos(m, [{ url: 'https://c.example/z', monad_pay_tos: [P2] }], '2026-11-18');
  assert.deepEqual(m.pay_tos, { [P2]: '2026-11-18' });
  assert.deepEqual(m.hosts, { [P2]: ['c.example'] });
});

test('collectMonad: signed USDC payments per payout address per day, 100 blocks per call; unsigned ones left out', async () => {
  // The tip (after 10 confirmations) is block 100000 at 00:30 UTC on 4 Nov: 6,000 blocks after midnight (block 94000).
  const node = fakeNode({
    tip: 100010,
    headIso: '2026-11-04T00:30:03Z',
    transfers: [
      [80000, USDC, A, P1, 10000, USDC], // 3 Nov, 23:20
      [85000, USDC, B, P1, 20000, USDC],
      [86000, USDC, B, P1, 30000, null], // a plain transfer, not an x402 payment
      [87000, USDC, A, P1, 30000, OTHER_TOKEN], // the authorization was on another token: not this transfer's
      [95000, USDC, B, P2, 40000, USDC], // 4 Nov
      [96000, OTHER_TOKEN, A, P2, 50000, OTHER_TOKEN], // a token not watched
    ],
  });
  const lines = [];
  const state = await collectMonad(null, { payTos: [P1, P2], nodes: ['https://node.test'], fetchImpl: node.fetchImpl, now: () => Date.parse('2026-11-04T00:31:00Z'), log: (l) => lines.push(l) });
  assert.ok(Math.max(...node.spans) <= 100, 'never more than 100 blocks per getLogs');
  assert.equal(state.network, MONAD);
  assert.equal(state.symbol, 'USDC');
  assert.equal(state.token, USDC);
  assert.equal(state.per_day, 288000);
  assert.equal(state.last_block, 100000);
  assert.deepEqual(state.pay_tos[P1].d['2026-11-03'], [2, 30000, [A.slice(2, 12), B.slice(2, 12)]]);
  assert.deepEqual(state.pay_tos[P2].d['2026-11-04'], [1, 40000, [B.slice(2, 12)]]);
  // First run: the last 30,000 blocks (2.5 hours of 0.3-second blocks), split at midnight.
  const covered = Object.values(state.days).reduce((n, d) => n + d.covered, 0);
  assert.equal(covered, 30001);
  assert.deepEqual(Object.keys(state.days), ['2026-11-03', '2026-11-04']);
  assert.ok(Math.abs(state.days['2026-11-04'].covered - 6001) <= 1, JSON.stringify(state.days));
  assert.match(lines.at(-1), /3 signed payments and 0 outgoing transfers added, up to block 100000/);

  // The next hourly run continues from the last block.
  const next = await collectMonad(state, { payTos: [P1, P2], nodes: ['https://node.test'], fetchImpl: fakeNode({ tip: 112010, headIso: '2026-11-04T01:30:03Z', transfers: [[105000, USDC, A, P2, 5000, USDC]] }).fetchImpl, now: () => Date.parse('2026-11-04T01:31:00Z') });
  assert.equal(next.last_block, 112000);
  assert.deepEqual(next.pay_tos[P2].d['2026-11-04'], [2, 45000, [B.slice(2, 12), A.slice(2, 12)]]);

  // A Base or X Layer file is never continued as Monad's (another chain's block numbers).
  const fromBase = await collectMonad({ version: 1, network: 'eip155:8453', last_block: 1, days: {}, pay_tos: {} }, { payTos: [P1], nodes: ['https://node.test'], fetchImpl: node.fetchImpl, now: () => Date.parse('2026-11-04T00:31:00Z') });
  assert.equal(fromBase.network, MONAD);
  assert.equal(fromBase.last_block, 100000);
});

test('createOnchainPayments: Monad totals and who gets paid, with the hosts from the scan; the same address on Base stays apart', async () => {
  const data = { version: 1, network: MONAD, symbol: 'USDC', token: USDC, per_day: 288000, updated: '2026-11-05T05:00:00.000Z', last_block: 1, days: { '2026-11-04': { covered: 288000 } }, pay_tos: { [P1]: { since: '2026-11-04', d: { '2026-11-04': [3, 30000, ['aa', 'bb']] } }, [P2]: { since: '2026-11-04', d: {} } } };
  const base = { version: 1, updated: '2026-11-05T05:00:00.000Z', last_block: 1, days: {}, pay_tos: {} };
  const fetchImpl = async (url) => ({ ok: true, json: async () => (url.includes('payments-monad') ? data : url.includes('paytos-monad') ? { hosts: { [P1]: ['a.example'] } } : base) });
  const payments = createOnchainPayments({ url: 'https://x/payments.json', solanaUrl: '', xrplUrl: '', xrplPayTosUrl: '', stellarUrl: '', stellarPayTosUrl: '', algorandUrl: '', algorandPayTosUrl: '', xlayerUrl: '', xlayerPayTosUrl: '', monadUrl: 'https://x/payments-monad.json', monadPayTosUrl: 'https://x/paytos-monad.json', fetchImpl });
  const t = await payments.totalsMonad({ waitMs: 1000 });
  assert.deepEqual([t.network, t.days, t.watched, t.pay_tos_paid, t.payments, t.payers, t.usd, t.coverage], [MONAD, 1, 2, 1, 3, 2, 0.03, 1]);
  const list = await payments.sellersMonad();
  assert.deepEqual(list.sellers, [{ pay_to: P1, name: null, hosts: ['a.example'], payments: 3, usd: 0.03, payers: 2, payers_wide: 0 }]);
  assert.equal(await payments.lookup(P1), null, 'without a network an EVM address is looked up on Base');
  assert.equal(await payments.lookup(P1, { network: 'eip155:196' }), null, 'nor on X Layer');
  const w = await payments.lookup(P1.toUpperCase().replace('0X', '0x'), { network: MONAD });
  assert.deepEqual([w.network, w.payments, w.usd, w.payers], [MONAD, 3, 0.03, 2]);
  assert.equal(payments.loaded(P1, MONAD), true);
});

test('web check: a Monad USDC option without a Base one is looked up on Monad and named so', async () => {
  const asked = [];
  const checks = [];
  const found = { network: MONAD, symbol: 'USDC', days: 7, payments: 4, payers: 2, usd: 0.04, coverage: 0.99 };
  await checkOnchainPayments([{ scheme: 'exact', network: MONAD, asset: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', payTo: P1 }], { lookup: async (a, o) => { asked.push([a, o.network]); return found; }, loaded: () => true }, checks);
  assert.deepEqual(asked, [[P1, MONAD]]);
  assert.match(checks[0].message, /^Real payments on Monad in the last 7 days: 2 different wallets paid this payout address \(.+\) 4 times, \$0\.04 in USDC in total\.$/);
  assert.match(checks[0].hint, /USDC payments the buyer signed with EIP-3009/);
  // With a Base option too, Base is the one counted.
  const both = [];
  await checkOnchainPayments([{ scheme: 'exact', network: MONAD, asset: USDC, payTo: P1 }, { scheme: 'exact', network: 'eip155:8453', asset: BASE_USDC, payTo: P2 }], { lookup: async (a, o) => { both.push([a, o.network]); return null; }, loaded: () => false }, []);
  assert.deepEqual(both, [[P2, 'eip155:8453']]);
  // An offer in another token on Monad isn't counted: nothing said.
  const none = [];
  await checkOnchainPayments([{ scheme: 'exact', network: MONAD, asset: OTHER_TOKEN, payTo: P1 }], { lookup: async () => found, loaded: () => true }, none);
  assert.deepEqual(none, []);
});

test('GET /api/trust/payments?network=monad and /api/trust/summary: the list and totals, 503 before a complete day', async () => {
  const file = (days) => ({ version: 1, network: MONAD, updated: '2026-11-05T05:00:00.000Z', last_block: 1, per_day: 288000, days, pay_tos: { [P1]: { since: '2026-11-04', d: { '2026-11-04': [1, 10000, ['aa']] } } } });
  const base = { version: 1, updated: '2026-11-05T05:00:00.000Z', last_block: 1, days: {}, pay_tos: {} };
  const reader = (days) => createOnchainPayments({ url: 'https://x/payments.json', solanaUrl: '', xrplUrl: '', xrplPayTosUrl: '', stellarUrl: '', stellarPayTosUrl: '', algorandUrl: '', algorandPayTosUrl: '', xlayerUrl: '', xlayerPayTosUrl: '', monadUrl: 'https://x/payments-monad.json', monadPayTosUrl: '', fetchImpl: async (url) => ({ ok: true, json: async () => (url.includes('monad') ? file(days) : base) }) });
  const trustIndex = { lookup: async () => null, refresh: () => Promise.resolve(), summary: () => null };
  const start = (app) => new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve({ s, base: `http://127.0.0.1:${s.address().port}` })); });
  const first = await start(createApp({ allowPrivate: true, env: {}, trustIndex, onchainPayments: reader({ '2026-11-04': { covered: 288000 } }) }));
  try {
    const res = await fetch(`${first.base}/api/trust/payments?network=monad`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.network, MONAD);
    assert.equal(body.sellers[0].pay_to, P1);
    const bad = await (await fetch(`${first.base}/api/trust/payments?network=nope`)).json();
    assert.match(bad.error, /xlayer, monad/);
  } finally { first.s.close(); }
  const second = await start(createApp({ allowPrivate: true, env: {}, trustIndex, onchainPayments: reader({}) }));
  try {
    const res = await fetch(`${second.base}/api/trust/payments?network=monad`);
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /no complete day of Monad payments/);
  } finally { second.s.close(); }
});
