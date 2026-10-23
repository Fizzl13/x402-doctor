// Real payments on chain (lib/onchain-payments.js) against a fake Base node: signed USDC transfers to watched payout
// addresses, counted per UTC day, and USDC sent back out of them (closed loops). No network.

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergePayTos, collect, windowOf, totalsOf, createOnchainPayments, TRANSFER, AUTH_USED, USDC } = require('../lib/onchain-payments');
const { payTosOf } = require('../lib/trust-scan');

const P1 = '0x1111111111111111111111111111111111111111';
const P2 = '0x2222222222222222222222222222222222222222';
const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const OWN = '0xA12871853F653F76EC303B94AC4fb6C46578a3F1';
const pad = (a) => `0x${a.toLowerCase().slice(2).padStart(64, '0')}`;
const hex = (n) => `0x${n.toString(16)}`;

// A node whose chain tip is `tip` (2-second blocks, tip at headIso). transfers: [block, from, to, micro-USDC, signed].
// limits: { maxSpan } refuses wider getLogs ranges; { archiveBelow } refuses blocks older than that.
function fakeNode({ tip, headIso, transfers, maxSpan = Infinity, archiveBelow = 0 }) {
  const calls = [];
  const logs = transfers.map(([block, from, to, value, signed], i) => ({ block, from: from.toLowerCase(), to: to.toLowerCase(), value, signed, tx: `0x${String(i + 1).padStart(64, '0')}` }));
  const reply = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) });
  const fail = (message) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: -32000, message } }) });
  const fetchImpl = async (_url, { body }) => {
    const { method, params } = JSON.parse(body);
    calls.push(method);
    if (method === 'eth_blockNumber') return reply(hex(tip));
    if (method === 'eth_getBlockByNumber') {
      const b = parseInt(params[0], 16);
      return reply({ number: params[0], timestamp: hex(Date.parse(headIso) / 1000 - 2 * (tip - b)) });
    }
    if (method === 'eth_getLogs') {
      const f = params[0];
      const from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16);
      if (to - from + 1 > maxSpan) return fail('query returned more than 10000 results');
      if (from < archiveBelow) return fail('Archive requests require a personal token');
      assert.equal(f.address.toLowerCase(), USDC);
      const inRange = logs.filter((l) => l.block >= from && l.block <= to);
      if (f.topics[0] === TRANSFER) {
        // Transfers to the payout addresses (topic 2), or out of them (topic 1).
        const senders = f.topics[1] ? new Set(f.topics[1]) : null, targets = f.topics[2] ? new Set(f.topics[2]) : null;
        return reply(inRange.filter((l) => (!senders || senders.has(pad(l.from))) && (!targets || targets.has(pad(l.to)))).map((l) => ({ topics: [TRANSFER, pad(l.from), pad(l.to)], data: hex(l.value), blockNumber: hex(l.block), transactionHash: l.tx })));
      }
      if (f.topics[0] === AUTH_USED) {
        const who = new Set(f.topics[1]);
        return reply(inRange.filter((l) => l.signed && who.has(pad(l.from))).map((l) => ({ topics: [AUTH_USED, pad(l.from), pad('0x01')], data: '0x', blockNumber: hex(l.block), transactionHash: l.tx })));
      }
    }
    return fail(`unexpected ${method}`);
  };
  return { fetchImpl, calls };
}

test('mergePayTos: lowercase Base payout addresses with the day last seen; placeholders skipped, old ones dropped', () => {
  let m = mergePayTos(null, [{ pay_tos: [P1.toUpperCase().replace('0X', '0x'), '0x0000000000000000000000000000000000000000'] }, { pay_tos: ['nope'] }, {}], '2026-10-01');
  assert.deepEqual(m.pay_tos, { [P1]: '2026-10-01' });
  m = mergePayTos(m, [{ pay_tos: [P2] }], '2026-10-15');
  assert.deepEqual(m.pay_tos, { [P1]: '2026-10-01', [P2]: '2026-10-15' }, '14 days: still kept');
  m = mergePayTos(m, [], '2026-10-16');
  assert.deepEqual(m.pay_tos, { [P2]: '2026-10-15' });
  assert.equal(m.network, 'eip155:8453');
});

test('collect: signed USDC payments per payout address per day; unsigned transfers, our own wallet and self-payments left out', async () => {
  // The tip (after 10 confirmations) is block 100000 at 00:10 UTC on 19 Oct: block 99700 is midnight.
  const node = fakeNode({
    tip: 100010,
    headIso: '2026-10-19T00:10:20Z',
    transfers: [
      [99000, A, P1, 10000, true], // 18 Oct, 23:36
      [99100, A, P1, 20000, true],
      [99200, B, P1, 30000, false], // a plain transfer, not an x402 payment
      [99300, OWN, P1, 50000, true], // x402 Doctor's own test purchase
      [99400, P1, P1, 10000, true],
      [99800, B, P2, 40000, true], // 19 Oct
      [99900, A, '0x3333333333333333333333333333333333333333', 10000, true], // not watched
    ],
  });
  const lines = [];
  const state = await collect(null, { payTos: [P1, P2], nodes: ['https://node.test'], fetchImpl: node.fetchImpl, now: () => Date.parse('2026-10-19T00:11:00Z'), log: (l) => lines.push(l) });
  assert.equal(state.last_block, 100000);
  assert.deepEqual(state.pay_tos[P1].d['2026-10-18'], [2, 30000, [A.slice(2, 12)]]);
  assert.deepEqual(state.pay_tos[P2].d['2026-10-19'], [1, 40000, [B.slice(2, 12)]]);
  assert.equal(state.pay_tos[P1].since, '2026-10-19');
  // First run: the last 9,000 blocks, split at midnight.
  assert.deepEqual(state.days, { '2026-10-18': { covered: 8700 }, '2026-10-19': { covered: 301 } });
  assert.match(lines.at(-1), /3 signed payments and 0 outgoing transfers added, up to block 100000/);

  // A day later: the window is the complete days before today that were read.
  const later = { ...state, updated: '2026-10-19T23:00:00.000Z', pay_tos: { ...state.pay_tos, [P1]: { ...state.pay_tos[P1], since: '2026-10-18' } } };
  assert.equal(windowOf(later, P2), null, 'watched since 19 Oct: no complete day yet');
  const w = windowOf(later, P1.toUpperCase().replace('0X', '0x'));
  assert.deepEqual({ ...w, as_of: undefined }, { network: 'eip155:8453', pay_to: P1, days: 1, payments: 2, payers: 1, payers_wide: 0, payers_paid_back: 0, usd_paid_back: 0, usd: 0.03, coverage: 0.201, as_of: undefined });
  const t = totalsOf(later);
  assert.deepEqual([t.days, t.watched, t.pay_tos_paid, t.payments, t.payers, t.usd], [1, 2, 1, 2, 1, 0.03]);
});

test('wallets that pay 10 or more payout addresses (checkers, scanners) are counted apart, per address and in total', () => {
  const day = '2026-10-20';
  const addr = (i) => `0x${String(i).padStart(40, 'a')}`;
  const pay_tos = {};
  // Twelve sellers paid by the same wallet W; the first also by an ordinary buyer O, the last by a wallet paying 2.
  for (let i = 1; i <= 12; i++) pay_tos[addr(i)] = { since: '2026-10-19', d: { [day]: [3, 30000, ['wwwwwwwwww', ...(i === 1 ? ['oooooooooo'] : []), ...(i >= 11 ? ['tttttttttt'] : [])]] } };
  const state = { version: 1, updated: '2026-10-21T08:00:00.000Z', days: { [day]: { covered: 43200 } }, pay_tos };
  assert.equal(windowOf(state, addr(1)).payers_wide, 1, 'W pays 12 sellers');
  assert.deepEqual([windowOf(state, addr(1)).payers, windowOf(state, addr(5)).payers, windowOf(state, addr(5)).payers_wide], [2, 1, 1]);
  assert.deepEqual([windowOf(state, addr(12)).payers, windowOf(state, addr(12)).payers_wide], [2, 1], 'paying 2 sellers is not wide');
  const t = totalsOf(state);
  assert.deepEqual([t.pay_tos_paid, t.pay_tos_paid_only_wide, t.payers, t.payers_wide, t.wide_sellers], [12, 9, 3, 1, 10]);
});

test('closed loops: USDC sent back from a payout address to the wallets that paid it', async () => {
  // P1: A pays it 3 times ($0.03), and P1 sweeps $0.03 back to A the same day: a closed loop.
  // P2: B pays $0.04, P2 refunds B $0.01 and sends $5 to an exchange C: paid back, but not a loop.
  const C = '0xcccccccccccccccccccccccccccccccccccccccc';
  const node = fakeNode({
    tip: 100010,
    headIso: '2026-10-19T00:10:20Z',
    transfers: [
      [99000, A, P1, 10000, true], [99010, A, P1, 10000, true], [99020, A, P1, 10000, true],
      [99030, P1, A, 30000, false], // the sweep back: a plain transfer
      [99040, B, P2, 40000, true],
      [99050, P2, B, 10000, false], [99060, P2, C, 5000000, false],
      [99070, C, P2, 1, false], // into P2 but not signed: not a payment
    ],
  });
  const lines = [];
  const state = await collect(null, { payTos: [P1, P2], nodes: ['https://node.test'], fetchImpl: node.fetchImpl, now: () => Date.parse('2026-10-19T00:11:00Z'), log: (l) => lines.push(l) });
  assert.match(lines.at(-1), /4 signed payments and 3 outgoing transfers added/);
  assert.deepEqual(state.pay_tos[P1].d['2026-10-18'], [3, 30000, [A.slice(2, 12)], { [A.slice(2, 12)]: 30000 }]);
  assert.deepEqual(state.pay_tos[P2].d['2026-10-18'][3], { [B.slice(2, 12)]: 10000, [C.slice(2, 12)]: 5000000 });

  const later = { ...state, updated: '2026-10-19T23:00:00.000Z', pay_tos: Object.fromEntries(Object.entries(state.pay_tos).map(([a, e]) => [a, { ...e, since: '2026-10-18' }])) };
  const w1 = windowOf(later, P1), w2 = windowOf(later, P2);
  assert.deepEqual([w1.payers, w1.payers_paid_back, w1.usd_paid_back, w1.closed_loop], [1, 1, 0.03, true]);
  assert.deepEqual([w2.payers, w2.payers_paid_back, w2.usd_paid_back, w2.closed_loop], [1, 1, 0.01, undefined], 'a refund of a quarter: not a loop');
  const t = totalsOf(later);
  assert.deepEqual([t.pay_tos_paid, t.pay_tos_closed_loop, t.payers_paid_back, t.usd_paid_back], [2, 1, 2, 0.04]);
});

test('closed loops: a wide payer paid back, or an address that only sends, is not a loop or a paid seller', () => {
  const day = '2026-10-20';
  const addr = (i) => `0x${String(i).padStart(40, 'a')}`;
  const pay_tos = {};
  // W pays 12 sellers; seller 1 pays W back everything; seller 2 has no payments, only sends USDC out.
  for (let i = 1; i <= 12; i++) pay_tos[addr(i)] = { since: '2026-10-19', d: { [day]: [1, 10000, ['wwwwwwwwww'], ...(i === 1 ? [{ wwwwwwwwww: 10000 }] : [])] } };
  pay_tos[addr(13)] = { since: '2026-10-19', d: { [day]: [0, 0, [], { oooooooooo: 70000 }] } };
  const state = { version: 1, updated: '2026-10-21T08:00:00.000Z', days: { [day]: { covered: 43200 } }, pay_tos };
  assert.deepEqual([windowOf(state, addr(1)).payers_paid_back, windowOf(state, addr(1)).closed_loop], [1, undefined], 'no ordinary payer: not called a loop');
  assert.equal(windowOf(state, addr(13)).payments, 0);
  const t = totalsOf(state);
  assert.deepEqual([t.pay_tos_paid, t.pay_tos_closed_loop], [12, 0], 'sending only is not being paid');
});

test('collect: a range the node finds too wide is halved; blocks it no longer serves are skipped, not retried forever', async () => {
  let node = fakeNode({ tip: 50010, headIso: '2026-10-19T12:00:00Z', transfers: [[45000, A, P1, 10000, true], [49000, B, P1, 10000, true]], maxSpan: 3000 });
  let state = await collect(null, { payTos: [P1], nodes: ['https://node.test'], fetchImpl: node.fetchImpl, chunk: 9001, now: () => Date.parse('2026-10-19T12:00:30Z') });
  assert.deepEqual(state.pay_tos[P1].d['2026-10-19'], [2, 20000, [A.slice(2, 12), B.slice(2, 12)]]);

  // 20,000 blocks later, and the node only serves the last 9,000: the rest is skipped and lowers coverage.
  node = fakeNode({ tip: 70010, headIso: '2026-10-19T23:06:40Z', transfers: [[55000, A, P1, 10000, true], [69000, A, P1, 10000, true]], archiveBelow: 61000 });
  const lines = [];
  state = await collect(state, { payTos: [P1], nodes: ['https://node.test'], fetchImpl: node.fetchImpl, now: () => Date.parse('2026-10-19T23:07:00Z'), log: (l) => lines.push(l) });
  assert.equal(state.last_block, 70000);
  assert.deepEqual(state.pay_tos[P1].d['2026-10-19'], [3, 30000, [A.slice(2, 12), B.slice(2, 12)]], 'block 55000 was skipped');
  assert.ok(lines.some((l) => /blocks 50001-60999 skipped: Archive requests/.test(l)), lines.join('\n'));
  assert.equal(state.days['2026-10-19'].covered, 9001 + 9001);
});

test('collect: no payout addresses or nothing new is a no-op; days older than 8 are dropped', async () => {
  const node = fakeNode({ tip: 1010, headIso: '2026-10-19T12:00:00Z', transfers: [] });
  const old = { version: 1, network: 'eip155:8453', token: USDC, updated: '2026-10-10T00:00:00.000Z', last_block: 1000, days: { '2026-10-01': { covered: 43200 }, '2026-10-18': { covered: 43200 } }, pay_tos: { [P1]: { since: '2026-10-01', d: { '2026-10-01': [1, 1, ['aa']] } }, [P2]: { since: '2026-10-01', d: { '2026-10-01': [1, 1, ['bb']] } } } };
  const s = await collect(old, { payTos: [P1], nodes: ['https://node.test'], fetchImpl: node.fetchImpl, now: () => Date.parse('2026-10-19T12:00:30Z') });
  assert.equal(s.last_block, 1000);
  assert.deepEqual(Object.keys(s.days), ['2026-10-18']);
  assert.deepEqual(s.pay_tos, { [P1]: { since: '2026-10-01', d: {} } }, 'P2 is no longer listed and has nothing left');
});

test('createOnchainPayments: lookup and totals from the published file', async () => {
  const data = { version: 1, updated: '2026-10-19T05:00:00.000Z', last_block: 1, days: { '2026-10-18': { covered: 43200 } }, pay_tos: { [P1]: { since: '2026-10-01', d: { '2026-10-18': [5, 50000, ['aa', 'bb']] } } } };
  const payments = createOnchainPayments({ url: 'https://raw.test/payments.json', fetchImpl: async () => ({ ok: true, json: async () => data }) });
  assert.deepEqual(await payments.lookup(P1, { waitMs: 1000 }), { network: 'eip155:8453', pay_to: P1, days: 1, payments: 5, payers: 2, payers_wide: 0, payers_paid_back: 0, usd_paid_back: 0, usd: 0.05, coverage: 1, as_of: data.updated });
  assert.equal(await payments.lookup(P2), null);
  assert.equal((await payments.totals()).payers, 2);
  assert.equal(payments.loaded(), true);
  // Before the file is loaded (or when it can't be), lookup's null doesn't mean "not watched".
  const down = createOnchainPayments({ url: 'https://raw.test/payments.json', fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.equal(down.loaded(), false);
  assert.equal(await down.lookup(P1, { waitMs: 1000 }), null);
  assert.equal(down.loaded(), false);
});

test('payTosOf: the Base payout addresses of a check, lowercase, once each', () => {
  assert.deepEqual(payTosOf([
    { network: 'eip155:8453', pay_to: '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD' },
    { network: 'eip155:8453', pay_to: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' },
    { network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', pay_to: 'ATWJ82T8nRdQwZnaysB68N5EpaSvLRsQP4h6eWmaJBH9' },
    { network: 'eip155:137', pay_to: P1 },
  ]), { pay_tos: ['0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'] });
  assert.deepEqual(payTosOf([]), {});
});
