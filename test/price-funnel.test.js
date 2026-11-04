'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { visitorsOf, parseKnownAgents, kindOf, summarizeFunnel } = require('../lib/price-funnel');

const known = parseKnownAgents(JSON.stringify({ monitor_agents: 'crawl|monitor|probe', test_agents: 'harness' }));

test('price funnel: kinds of caller', () => {
  assert.equal(kindOf('crawler', known), 'checker');
  assert.equal(kindOf('x402-test-harness/1', known), 'checker');
  assert.equal(kindOf('browser', known), 'browser', 'the log writes browsers as "browser"');
  assert.equal(kindOf('Mozilla/5.0 (iPhone)', known), 'browser');
  assert.equal(kindOf('python-httpx/0.28.1', known), 'client');
  assert.equal(kindOf('x402-doctor-buy-check/1', known), 'own');
  assert.equal(kindOf('fizzl-monitor/smoke', known), 'own');
  assert.equal(kindOf('', known), 'client');
});

test('price funnel: one row per visitor with quotes (count included) and payments; other calls are ignored', () => {
  const s = visitorsOf([
    { visitor: 'a', agent: 'python-httpx/0.28', service: 'doctor', route: 'preflight', quote: true, status: 402 },
    { visitor: 'a', agent: 'python-httpx/0.28', service: 'doctor', route: 'preflight', paid: true, status: 200 },
    { visitor: 'b', agent: 'crawler', service: 'presign', route: 'token', quote: true, count: 7, status: 402 },
    { visitor: 'c', agent: 'node', service: 'ichimoku', route: 'signal', status: 200 }, // free call: not in the funnel
    { agent: 'node', quote: true }, // no visitor: skipped
  ]);
  assert.deepEqual(Object.keys(s.v).sort(), ['a', 'b']);
  assert.deepEqual(s.v.a.slice(0, 2), [1, 1]);
  assert.deepEqual(s.v.b.slice(0, 2), [7, 0]);
  assert.equal(s.agents[s.v.b[2]], 'crawler');
  assert.equal(s.routes[s.v.b[2]]['presign token'], 7);
});

test('price funnel: visitors are merged across files and split by kind, with the share that paid', () => {
  const day1 = visitorsOf([
    { visitor: 'a', agent: 'python-httpx/0.28', service: 'doctor', route: 'preflight', quote: true },
    { visitor: 'b', agent: 'crawler', service: 'presign', route: 'token', quote: true, count: 5 },
    { visitor: 'c', agent: 'browser', service: 'ichimoku', route: 'signal', quote: true },
    { visitor: 'o', agent: 'x402-doctor-buy-check/1', service: 'buy', route: 'buy', quote: true },
  ]);
  const day2 = visitorsOf([
    { visitor: 'a', agent: 'python-httpx/0.28', service: 'doctor', route: 'preflight', paid: true },
    { visitor: 'd', agent: 'node', service: 'doctor', route: 'diagnose', quote: true, count: 3 },
    { visitor: 'e', agent: 'paid-without-quote', service: 'doctor', route: 'diagnose', paid: true },
  ]);
  const old = visitorsOf([{ visitor: 'z', agent: 'node', service: 'doctor', route: 'diagnose', quote: true }]);
  const f = summarizeFunnel([
    { service: 'doctor', date: '2026-10-01', summary: old }, // before the range
    { service: 'doctor', date: '2026-11-03', summary: day1 },
    { service: 'doctor', date: '2026-11-04', summary: day2 },
  ], { known, fromIso: '2026-11-03T00:00:00Z' });
  assert.deepEqual(f.kinds.client, { visitors: 2, quotes: 4, paid_visitors: 1, paid_pct: 50 });
  assert.deepEqual(f.kinds.checker, { visitors: 1, quotes: 5, paid_visitors: 0, paid_pct: 0 });
  assert.deepEqual(f.kinds.browser, { visitors: 1, quotes: 1, paid_visitors: 0, paid_pct: 0 });
  assert.equal(f.own_left_out, 1);
  assert.deepEqual(f.lookers.map((l) => l.agent), ['crawler', 'node', 'browser'], 'never-paid callers, most 402s first');
  assert.deepEqual(f.lookers[1].services, ['doctor']);
  assert.deepEqual(f.client_routes, [{ route: 'doctor preflight', quotes: 1 }, { route: 'doctor diagnose', quotes: 3 }].sort((a, b) => b.quotes - a.quotes));
});
