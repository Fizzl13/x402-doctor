const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { createPublicStats, summarize, charts, statsCors } = require('../lib/public-stats');

const NOW = Date.parse('2026-09-30T08:00:00Z');
const events = [
  { t: '2026-09-30T07:00:00Z', service: 'doctor', via: 'api', status: 402, input: { url: 'https://secret.example' }, payer: '0xabc' },
  { t: '2026-09-30T06:00:00Z', service: 'presign', via: 'mcp', status: 200 },
  { t: '2026-09-30T05:00:00Z', service: 'ichimoku', via: 'web', status: 200 },
  { t: '2026-09-29T23:59:59Z', service: 'doctor', via: 'api', status: 402 },
];

test('summarize: today (UTC) only, agent and MCP calls only, per service', () => {
  assert.deepStrictEqual(summarize(events, NOW), { date: '2026-09-30', requests: 2, services: { doctor: 1, presign: 1, ichimoku: 0, plaintext: 0 } });
});

test('stats: totals and BTC trend only, nothing from the log leaks, cached for 5 minutes', async () => {
  let loads = 0; let now = NOW;
  const usageReader = { load: async () => { loads++; return { events, truncated: false }; } };
  const fetchFn = async () => ({ ok: true, json: async () => ({ pair: 'BTC-USDT', interval: '1d', signal: 'bullish', cloud_position: 'above', exchange: 'x' }) });
  const stats = createPublicStats({ usageReader, fetchFn, now: () => now });
  const body = await stats.get();
  assert.strictEqual(body.today.requests, 2);
  assert.deepStrictEqual(body.btc, { signal: 'bullish', cloud_position: 'above', interval: '1d' });
  assert.doesNotMatch(JSON.stringify(body), /secret|0xabc|payer|input/);
  await stats.get(); now += 4 * 60 * 1000; await stats.get();
  assert.strictEqual(loads, 1);
  now += 2 * 60 * 1000; await stats.get();
  assert.strictEqual(loads, 2);
});

test('stats: a failing trend gives btc null; a failing log keeps the last good numbers', async () => {
  let fail = false; let now = NOW;
  const usageReader = { load: async () => { if (fail) throw new Error('GitHub down'); return { events, truncated: false }; } };
  const stats = createPublicStats({ usageReader, fetchFn: async () => { throw new Error('offline'); }, now: () => now });
  const first = await stats.get();
  assert.strictEqual(first.btc, null);
  fail = true; now += 10 * 60 * 1000;
  assert.strictEqual((await stats.get()).today.requests, 2);
  const fresh = createPublicStats({ usageReader, now: () => now, fetchFn: async () => ({ ok: false }) });
  await assert.rejects(fresh.get(), /GitHub down/);
});

test('cors: fizzl.eu and its subdomains may read the stats, other sites may not', async () => {
  const app = express();
  app.get('/api/stats', statsCors, (_req, res) => res.json({ ok: true }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const origin of ['https://fizzl.eu', 'https://ai.fizzl.eu', 'https://projects.fizzl.eu']) {
      assert.strictEqual((await fetch(`${base}/api/stats`, { headers: { origin } })).headers.get('access-control-allow-origin'), origin);
    }
    for (const origin of ['https://evil.example', 'https://fizzl.eu.evil.example', 'https://evil.fizzl.eu']) {
      assert.strictEqual((await fetch(`${base}/api/stats`, { headers: { origin } })).headers.get('access-control-allow-origin'), null);
    }
  } finally { server.close(); }
});

test('charts: counts per hour and day, outcomes and median time; nothing about callers', () => {
  const log = [
    { t: '2026-09-30T07:10:00Z', service: 'doctor', via: 'api', status: 402, ms: 3, agent: 'bot/1', visitor: 'v1', input: { url: 'https://secret.example' } },
    { t: '2026-09-30T07:20:00Z', service: 'doctor', via: 'api', status: 200, ms: 9, paid: true, payer: '0xabc' },
    { t: '2026-09-30T07:30:00Z', service: 'doctor', via: 'api', status: 400, ms: 1 },
    { t: '2026-09-30T06:00:00Z', service: 'presign', via: 'mcp', status: 200, ms: 40 },
    { t: '2026-09-30T05:00:00Z', service: 'ichimoku', via: 'web', status: 200, ms: 5 },
    { t: '2026-09-28T12:00:00Z', service: 'plaintext', via: 'api', status: 402, ms: 2 },
    { t: '2026-09-20T12:00:00Z', service: 'doctor', via: 'api', status: 402, ms: 2 },
  ];
  const c = charts(log, NOW);
  assert.strictEqual(c.hourly.length, 24);
  assert.strictEqual(c.hourly[23].hour, '2026-09-30T08:00:00.000Z');
  assert.deepStrictEqual(c.hourly[22], { hour: '2026-09-30T07:00:00.000Z', doctor: 3, presign: 0, ichimoku: 0, plaintext: 0 });
  assert.strictEqual(c.hourly[21].presign, 1);
  assert.deepStrictEqual(c.daily.map((d) => d.date), ['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30']);
  assert.strictEqual(c.daily[4].plaintext, 1);
  assert.strictEqual(c.daily[6].doctor, 3);
  assert.deepStrictEqual(c.outcomes_24h, { quote: 1, answered: 2, rejected: 1 });
  assert.deepStrictEqual(c.median_ms_24h, { doctor: 3, presign: 40, ichimoku: null, plaintext: null });
  assert.deepStrictEqual(c.p95_ms_24h, { doctor: 9, presign: 40, ichimoku: null, plaintext: null });
  assert.doesNotMatch(JSON.stringify(c), /secret|0xabc|payer|input|bot\/1|v1|paid/);
});
