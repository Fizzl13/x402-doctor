// Payout address and price compared with the daily scans (lib/payee-history.js): what the index keeps, and the
// preflight's payto_changed and price_changed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { payToMap, mergePayTo, mergePrice, changeReasons } = require('../lib/payee-history');
const { mergeIndex } = require('../lib/trust-scan');

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const SOL = 'So11111111111111111111111111111111111111112';
const opt = (network, pay_to, usd = 0.01, payable = true) => ({ network, pay_to, usd, payable });
const now = Date.parse('2026-10-31T12:00:00Z');

test('payToMap: one fingerprint per network, EVM case-insensitive, Solana case-sensitive', () => {
  const m = payToMap([opt('eip155:8453', A), opt('solana:x', SOL)]);
  assert.deepEqual(Object.keys(m).sort(), ['eip155:8453', 'solana:x']);
  assert.equal(payToMap([opt('eip155:8453', A.toUpperCase().replace('0X', '0x'))])['eip155:8453'], m['eip155:8453']);
  assert.notEqual(payToMap([opt('solana:x', SOL.toLowerCase())])['solana:x'], m['solana:x']);
  assert.match(m['eip155:8453'], /^[0-9a-f]{10}$/);
  assert.deepEqual(payToMap([{ network: 'eip155:8453' }, null]), {});
});

test('mergePayTo: a new or dropped network is no change; another address on the same network is', () => {
  const base = payToMap([opt('eip155:8453', A)]);
  const first = mergePayTo(undefined, base, '2026-10-01');
  assert.deepEqual(first, { a: base, s: '2026-10-01' });
  assert.deepEqual(mergePayTo(first, base, '2026-10-02'), first, 'same address: unchanged entry');
  const plusSol = mergePayTo(first, payToMap([opt('solana:x', SOL)]), '2026-10-03');
  assert.equal(plusSol.s, '2026-10-01');
  assert.equal(plusSol.c, undefined);
  const moved = mergePayTo(plusSol, payToMap([opt('eip155:8453', B)]), '2026-10-30');
  assert.equal(moved.s, '2026-10-30');
  assert.deepEqual(moved.c, ['eip155:8453']);
  assert.equal(mergePayTo(moved, {}, '2026-10-31'), moved, 'nothing seen today: kept');
});

test('mergePrice: the day it changed and the price before', () => {
  assert.deepEqual(mergePrice(undefined, 0.01, '2026-10-01'), [0.01, '2026-10-01']);
  assert.deepEqual(mergePrice([0.01, '2026-10-01'], 0.010001, '2026-10-02'), [0.01, '2026-10-01']);
  assert.deepEqual(mergePrice([0.01, '2026-10-01'], 0.05, '2026-10-29'), [0.05, '2026-10-29', 0.01]);
  assert.deepEqual(mergePrice([0.05, '2026-10-29', 0.01], null, '2026-10-30'), [0.05, '2026-10-29', 0.01]);
});

test('changeReasons: live payTo differs from the scan (caution), named by network', () => {
  const record = { days: ['2026-10-30', '2026-10-31'], payto: { a: payToMap([opt('eip155:8453', A)]), s: '2026-10-01' }, price: [0.01, '2026-10-01'] };
  const r = changeReasons({ record, options: [opt('eip155:8453', B)], now });
  assert.deepEqual(r.map((x) => [x.level, x.code]), [['caution', 'payto_changed']]);
  assert.match(r[0].message, /payout address on Base is not the one x402 Doctor's daily scan saw \(last scan 31 Oct 2026\)/);
  assert.deepEqual(changeReasons({ record, options: [opt('eip155:8453', A), opt('solana:x', SOL)], now }), [], 'same address, a new network: fine');
});

test('changeReasons: changed in a scan this week (caution); older changes are history', () => {
  const pt = { a: payToMap([opt('eip155:8453', B)]), s: '2026-10-29', c: ['eip155:8453'] };
  const r = changeReasons({ record: { days: ['2026-10-31'], payto: pt }, options: [opt('eip155:8453', B)], now });
  assert.equal(r[0].code, 'payto_changed');
  assert.match(r[0].message, /changed in the daily scan of 29 Oct 2026/);
  assert.deepEqual(changeReasons({ record: { payto: { ...pt, s: '2026-10-10' } }, options: [opt('eip155:8453', B)], now }), []);
});

test('changeReasons: price above the scan is a caution, below is info, a change this week is noted', () => {
  const record = { days: ['2026-10-31'], price: [0.01, '2026-10-01'] };
  const up = changeReasons({ record, options: [opt('eip155:8453', A, 0.05)], now });
  assert.deepEqual(up.map((x) => [x.level, x.code]), [['caution', 'price_changed']]);
  assert.match(up[0].message, /Asks \$0\.05 now; the daily scan of 31 Oct 2026 saw \$0\.01\./);
  assert.equal(changeReasons({ record, options: [opt('eip155:8453', A, 0.005)], now })[0].level, 'info');
  assert.deepEqual(changeReasons({ record, options: [opt('eip155:8453', A, 0.01), opt('solana:x', SOL, 0.5)], now }), [], 'the cheapest payable option is compared');
  const week = changeReasons({ record: { price: [0.05, '2026-10-28', 0.01] }, options: [opt('eip155:8453', A, 0.05)], now });
  assert.match(week[0].message, /went from \$0\.01 to \$0\.05 in the daily scan of 28 Oct 2026/);
  assert.equal(week[0].level, 'caution');
  assert.deepEqual(changeReasons({ record: null, options: [] }), []);
});

test('mergeIndex keeps pt and pr, updated only by a scan that could pay', () => {
  const key = 'GET https://s.example/data';
  const result = (verdict, pay, price) => ({ key, url: 'https://s.example/data', method: 'GET', verdict, codes: [], price_usd: price, networks: ['eip155:8453'], ...(pay ? { pt: payToMap([opt('eip155:8453', pay)]) } : {}), ms: 1 });
  let index = mergeIndex(null, [result('go', A, 0.01)], { date: '2026-10-29' });
  assert.equal(index.resources[key].pt.s, '2026-10-29');
  assert.deepEqual(index.resources[key].pr, [0.01, '2026-10-29']);
  index = mergeIndex(index, [result('no_go', null, null)], { date: '2026-10-30' });
  assert.deepEqual(index.resources[key].pr, [0.01, '2026-10-29'], 'a failed scan keeps them');
  index = mergeIndex(index, [result('go', B, 0.02)], { date: '2026-10-31' });
  assert.deepEqual(index.resources[key].pt.c, ['eip155:8453']);
  assert.deepEqual(index.resources[key].pr, [0.02, '2026-10-31', 0.01]);
});

test('changeReasons: a moved address bound to the seller\'s agent (ERC-8478) is an info line, not a caution', () => {
  const record = { days: ['2026-10-31'], payto: { a: { ...payToMap([opt('eip155:8453', A)]), ...payToMap([opt('solana:x', SOL)]) }, s: '2026-10-01' } };
  const live = [opt('eip155:8453', B), opt('solana:x', 'So22222222222222222222222222222222222222222')];
  const bound = new Map([['eip155:8453', '988891']]);
  const r = changeReasons({ record, options: live, now, bound });
  assert.deepStrictEqual(r.map((x) => [x.level, x.code]), [['info', 'payto_changed_bound'], ['caution', 'payto_changed']]);
  assert.match(r[0].message, /on Base changed since the daily scan, and the new one is bound to the seller's ERC-8004 agent #988891/);
  assert.match(r[1].message, /on solana:x is not the one/);
  const recent = changeReasons({ record: { payto: { a: payToMap([opt('eip155:8453', B)]), s: '2026-10-30', c: ['eip155:8453'] } }, options: [opt('eip155:8453', B)], now, bound });
  assert.deepStrictEqual(recent.map((x) => x.code), ['payto_changed_bound']);
});

test('mergeIndex marks how many endpoints of a host moved their payout address that day (pt.m = [moved, of])', () => {
  const res = (path, verdict, pay) => ({ key: `GET https://h.example/${path}`, url: `https://h.example/${path}`, method: 'GET', verdict, codes: [], price_usd: 0.01, networks: ['eip155:8453'], pt: payToMap([opt('eip155:8453', pay)]), ms: 1 });
  const paths = ['a', 'b', 'c', 'd', 'e'];
  let index = mergeIndex(null, paths.map((p) => res(p, 'go', A)), { date: '2026-11-01' });
  assert.equal(index.resources['GET https://h.example/a'].pt.m, undefined, 'a first sighting is no move');
  index = mergeIndex(index, paths.map((p) => res(p, 'go', p === 'a' ? B : A)), { date: '2026-11-02' });
  assert.deepEqual(index.resources['GET https://h.example/a'].pt.m, [1, 5]);
  assert.equal(index.resources['GET https://h.example/b'].pt.m, undefined);
  index = mergeIndex(index, paths.map((p) => res(p, 'go', p === 'a' || p === 'b' || p === 'c' ? B : A)), { date: '2026-11-03' });
  assert.deepEqual(index.resources['GET https://h.example/b'].pt.m, [2, 5], 'b and c moved together on 3 Nov');
  assert.deepEqual(index.resources['GET https://h.example/a'].pt.m, [1, 5], 'a keeps its own day');
});

test('changeReasons: a change that was the only one of its host is payto_changed_alone; a host-wide move says so', () => {
  const base = { a: payToMap([opt('eip155:8453', B)]), s: '2026-10-29', c: ['eip155:8453'] };
  const reason = (m) => changeReasons({ record: { days: ['2026-10-31'], payto: { ...base, m } }, options: [opt('eip155:8453', B)], now })[0];
  const alone = reason([1, 5]);
  assert.equal(alone.code, 'payto_changed_alone');
  assert.equal(alone.level, 'caution');
  assert.match(alone.message, /only endpoint of its site that moved: its 4 other endpoints kept theirs/);
  const together = reason([3, 5]);
  assert.equal(together.code, 'payto_changed');
  assert.match(together.message, /Together with 2 other endpoints of the same site/);
  assert.equal(reason([1, 3]).code, 'payto_changed', 'with fewer than 3 others on the host, alone says little');
  assert.equal(reason(undefined).code, 'payto_changed', 'an index from before the marking');
});

test('mergeIndex groups payout moves by site: subdomains of one seller move together, separate sellers on co.uk do not', () => {
  const res = (url, pay) => ({ key: `GET ${url}`, url, method: 'GET', verdict: 'go', codes: [], price_usd: 0.01, networks: ['eip155:8453'], pt: payToMap([opt('eip155:8453', pay)]), ms: 1 });
  // One seller on many subdomains, one endpoint each (as x402atlas.com on 2 Nov 2026), plus a co.uk seller with 5 routes.
  const subs = ['a', 'b', 'c', 'd', 'e'].map((s) => `https://${s}.use.seller.example/x`);
  const uk = ['p', 'q', 'r', 's', 't'].map((p) => `https://one.co.uk/${p}`);
  const other = 'https://two.co.uk/x';
  let index = mergeIndex(null, [...subs.map((u) => res(u, A)), ...uk.map((u) => res(u, A)), res(other, A)], { date: '2026-11-01' });
  index = mergeIndex(index, [...subs.map((u) => res(u, B)), ...uk.map((u, i) => res(u, i === 0 ? B : A)), res(other, B)], { date: '2026-11-02' });
  assert.deepEqual(index.resources[`GET ${subs[0]}`].pt.m, [5, 5], 'five subdomains of one site moved together');
  assert.deepEqual(index.resources[`GET ${uk[0]}`].pt.m, [1, 5], 'one.co.uk: one of its own five moved, alone');
  assert.deepEqual(index.resources[`GET ${other}`].pt.m, [1, 1], 'two.co.uk is its own site, not part of co.uk');
});
