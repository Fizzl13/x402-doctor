// Weekly x402 health report from the Trust Index (lib/weekly-report.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { weeklyReport, weeklyStats } = require('../lib/weekly-report');

const BASE = 'eip155:8453';
const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const days = ['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29'];
const res = (url, h, last) => [url, { url, h, last }];
const go = (price, networks = [BASE]) => ({ verdict: 'go', codes: [], price_usd: price, networks });

// The window is the last 7 days (09-23 .. 09-29); the first letter (09-22) is outside it.
const index = {
  days,
  resources: Object.fromEntries([
    res('https://a.example/one', 'gggggggg', go(0.01, [BASE, SOLANA])),
    res('https://a.example/two', 'gggggggg', go(0.02)),
    res('https://b.example/broke', '-gggggnn', { verdict: 'no_go', codes: ['no_402'], networks: [] }),
    res('https://c.example/fixed', 'nnnnnnng', go(0.001)),
    res('https://d.example/test', 'cccccccc', { verdict: 'caution', codes: ['testnet_only'], price_usd: 0.01, networks: ['eip155:84532'] }),
    res('https://e.example/new', '-------g', go(0.05)),
    res('https://f.example/flaky', 'gngngngx', { verdict: 'error', codes: ['unreachable'], networks: [] }),
    res('https://g.example/gone', 'ggggg---', go(0.01)),
  ]),
};

test('weekly stats: shares, reasons, networks and the week in one number each', () => {
  const s = weeklyStats(index);
  assert.deepEqual(s.window, { from: '2026-09-23', to: '2026-09-29', days: 7 });
  assert.equal(s.resources, 7, 'the one not scanned today is left out');
  assert.equal(s.hosts, 6);
  assert.equal(s.clean, 4);
  assert.equal(s.caution, 1);
  assert.equal(s.no_go, 2, 'no_go and unreachable');
  assert.equal(s.clean_pct, 57.1);
  assert.deepEqual(s.reasons.map((r) => [r.code, r.count]), [['no_402', 1], ['testnet_only', 1], ['unreachable', 1]]);
  assert.match(s.reasons[0].fix, /answer 402/);
  assert.deepEqual(s.networks.map((n) => [n.network, n.count]), [[BASE, 4], [SOLANA, 1], ['eip155:84532', 1]]);
  assert.equal(s.median_price_usd, 0.01);
  assert.deepEqual(s.this_week, { broke: 2, fixed: 1, added: 1, flaky: 1 });
});

test('weekly report: markdown and posts name no seller, and the X post fits', () => {
  const { markdown, posts } = weeklyReport(index);
  for (const text of [markdown, posts.x, posts.discord, posts.reddit]) assert.doesNotMatch(text, /[a-g]\.example/);
  assert.match(markdown, /# x402 health, week ending 2026-09-29/);
  assert.match(markdown, /\| Don't answer 402 at all/);
  assert.ok(posts.x_length <= 280, `X post is ${posts.x_length} characters`);
  assert.match(posts.x, /57\.1% clean/);
  assert.match(posts.x, /#1 problem: 1 don't answer 402\./);
  assert.match(posts.discord, /DM me your endpoint/);
  assert.match(posts.discord, /2 endpoints stopped being payable this week.*wallet\.fizzl\.eu/);
  assert.match(markdown, /Fizzl endpoint monitor.*https:\/\/wallet\.fizzl\.eu/);
});

test('weekly report: an empty index is an error, not an empty report', () => {
  assert.throws(() => weeklyReport({ days: [], resources: {} }), /empty index/);
});

test('weekly stats: test, staging and tunnel endpoints are left out of the numbers and counted apart', () => {
  const withTest = { ...index, resources: { ...index.resources, ...Object.fromEntries([
    res('https://staging.h.example/x', 'cccccccc', { verdict: 'caution', codes: ['testnet_only'], networks: ['eip155:84532'] }),
    res('https://demo.ngrok-free.dev/y', 'nnnnnnnn', { verdict: 'no_go', codes: ['no_402'], networks: [] }),
  ]) } };
  const s = weeklyStats(withTest);
  assert.equal(s.resources, weeklyStats(index).resources);
  assert.deepEqual(s.left_out_test, { resources: 2, hosts: 2 });
  const { markdown, posts } = weeklyReport(withTest);
  assert.match(markdown, /Left out: \*\*2\*\* test, staging or tunnel endpoints on 2 hosts/);
  assert.match(posts.discord, /2 test\/staging endpoints left out/);
});
