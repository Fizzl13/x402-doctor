// The longer history of on-chain payment counts (lib/onchain-history.js): days that leave the hourly file are kept,
// as they were, for 35 days. No network.

const test = require('node:test');
const assert = require('node:assert/strict');
const { archiveDropped, daysOf, HISTORY_DAYS } = require('../lib/onchain-history');

const at = (iso) => () => Date.parse(iso);
const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);

function stateWith(days) {
  const s = { version: 1, network: 'eip155:8453', token: '0xusdc', updated: null, last_block: 1, days: {}, pay_tos: { [A]: { since: '2026-10-20', d: {} }, [B]: { since: '2026-11-02', d: {} } } };
  for (const day of days) {
    s.days[day] = { covered: 43200 };
    s.pay_tos[A].d[day] = [10, 200000, ['aaaaaaaaaa']];
  }
  if (days.includes('2026-11-02')) s.pay_tos[B].d['2026-11-02'] = [3, 60000, ['bbbbbbbbbb']];
  return s;
}

test('a day that leaves the hourly file goes into the history, as it was', () => {
  const before = stateWith(['2026-11-01', '2026-11-02', '2026-11-03']);
  const after = stateWith(['2026-11-02', '2026-11-03']); // 1 Nov rolled off
  const h = archiveDropped(before, after, null, { now: at('2026-11-09T01:00:00Z') });
  assert.deepEqual(Object.keys(h.days), ['2026-11-01']);
  assert.deepEqual(h.pay_tos[A].d, { '2026-11-01': [10, 200000, ['aaaaaaaaaa']] });
  assert.equal(h.pay_tos[A].since, '2026-10-20');
  assert.equal(h.pay_tos[B], undefined, 'nothing dropped for B');
  assert.equal(h.network, 'eip155:8453');
  assert.equal(h.token, '0xusdc');
  assert.equal(h.keep_days, HISTORY_DAYS);

  // The next day: 2 Nov rolls off too and joins 1 Nov.
  const later = stateWith(['2026-11-03']);
  const h2 = archiveDropped(after, later, h, { now: at('2026-11-10T01:00:00Z') });
  assert.deepEqual(Object.keys(h2.days).sort(), ['2026-11-01', '2026-11-02']);
  assert.deepEqual(Object.keys(h2.pay_tos[A].d).sort(), ['2026-11-01', '2026-11-02']);
  assert.deepEqual(h2.pay_tos[B].d, { '2026-11-02': [3, 60000, ['bbbbbbbbbb']] });
  assert.deepEqual(Object.keys(h.days), ['2026-11-01'], 'the history passed in is not changed');
});

test('days older than 35 days leave the history; an hourly run that drops nothing keeps it as it is', () => {
  const h = archiveDropped(stateWith(['2026-10-01', '2026-10-20']), stateWith(['2026-10-20']), null, { now: at('2026-10-21T00:00:00Z') });
  assert.deepEqual(Object.keys(h.days), ['2026-10-01']);
  const same = archiveDropped(stateWith(['2026-10-20']), stateWith(['2026-10-20']), h, { now: at('2026-10-21T01:00:00Z') });
  assert.deepEqual(same.days, h.days);
  const old = archiveDropped(null, stateWith(['2026-11-20']), h, { now: at('2026-11-20T00:00:00Z') });
  assert.deepEqual(old.days, {}, '1 Oct is more than 35 days before 20 Nov');
  assert.deepEqual(old.pay_tos, {});
});

test('a history for another network is started anew, and a first run has nothing to keep', () => {
  const base = archiveDropped(stateWith(['2026-11-01']), stateWith([]), null, { now: at('2026-11-09T00:00:00Z') });
  const solana = archiveDropped(null, { version: 1, network: 'solana:5eykt', days: {}, pay_tos: {} }, base, { now: at('2026-11-09T00:00:00Z') });
  assert.equal(solana.network, 'solana:5eykt');
  assert.deepEqual(solana.days, {});
  assert.deepEqual(archiveDropped(null, stateWith(['2026-11-08']), null).days, {});
  assert.deepEqual([...daysOf(stateWith(['2026-11-01']))], ['2026-11-01']);
});
