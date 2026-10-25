const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { createPublicStats, summarize, charts, weekCharts, daySummary, buyWeek, allTime, statsCors, SERVICES } = require('../lib/public-stats');

const NOW = Date.parse('2026-09-30T08:00:00Z');
const events = [
  { t: '2026-09-30T07:00:00Z', service: 'doctor', via: 'api', status: 402, input: { url: 'https://secret.example' }, payer: '0xabc' },
  { t: '2026-09-30T06:00:00Z', service: 'presign', via: 'mcp', status: 200 },
  { t: '2026-09-30T05:00:00Z', service: 'ichimoku', via: 'web', status: 200 },
  { t: '2026-09-29T23:59:59Z', service: 'doctor', via: 'api', status: 402 },
];

test('summarize: today (UTC) only, agent and MCP calls only, per service', () => {
  assert.deepStrictEqual(summarize(events, NOW), { date: '2026-09-30', requests: 2, services: { doctor: 1, presign: 1, ichimoku: 0, buy: 0 } });
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
    { t: '2026-09-28T12:00:00Z', service: 'buy', via: 'api', status: 402, ms: 2 },
    { t: '2026-09-27T12:00:00Z', service: 'plaintext', via: 'api', status: 402, ms: 2 },
    { t: '2026-09-20T12:00:00Z', service: 'doctor', via: 'api', status: 402, ms: 2 },
  ];
  const c = charts(log, NOW);
  assert.strictEqual(c.hourly.length, 24);
  assert.strictEqual(c.hourly[23].hour, '2026-09-30T08:00:00.000Z');
  assert.deepStrictEqual(c.hourly[22], { hour: '2026-09-30T07:00:00.000Z', doctor: 3, presign: 0, ichimoku: 0, buy: 0 });
  assert.strictEqual(c.hourly[21].presign, 1);
  assert.strictEqual(c.paid_hourly.length, 24);
  assert.strictEqual(c.paid_hourly[22], 1, 'one settled payment at 07:xx, counted without payer or amount');
  assert.strictEqual(c.paid_hourly.reduce((a, b) => a + b, 0), 1);
  assert.deepStrictEqual(c.daily.map((d) => d.date), ['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30']);
  assert.strictEqual(c.daily[4].buy, 1);
  assert.strictEqual(c.daily[3].plaintext, undefined, 'PlainText is no longer charted');
  assert.strictEqual(c.daily[6].doctor, 3);
  assert.deepStrictEqual(c.outcomes_24h, { quote: 1, answered: 2, rejected: 1 });
  assert.deepStrictEqual(c.median_ms_24h, { doctor: 3, presign: 40, ichimoku: null, buy: null });
  assert.deepStrictEqual(c.p95_ms_24h, { doctor: 9, presign: 40, ichimoku: null, buy: null });
  // Payments only as a count per hour (paid_hourly): no payer, amount or "paid" flag on anything else.
  const { paid_hourly: _counts, ...rest } = c;
  assert.doesNotMatch(JSON.stringify(c), /secret|0xabc|payer|input|bot\/1|v1|usd|amount/);
  assert.doesNotMatch(JSON.stringify(rest), /paid/);
});

test('charts: week-by-hour heatmap and the most asked routes, without made-up probe names', () => {
  const log = [
    { t: '2026-09-30T07:10:00Z', service: 'doctor', via: 'api', route: 'preflight', status: 402 },
    { t: '2026-09-30T07:11:00Z', service: 'doctor', via: 'api', route: 'preflight', status: 402 },
    { t: '2026-09-29T08:30:00Z', service: 'presign', via: 'mcp', route: 'token_verdict', status: 402 },
    { t: '2026-09-29T08:31:00Z', service: 'presign', via: 'mcp', route: '__verifymcp_auth_probe_f3ec9f75__', status: 400 },
    { t: '2026-09-23T09:00:00Z', service: 'doctor', via: 'api', route: 'fix', status: 402 },
  ];
  const c = charts(log, NOW);
  assert.strictEqual(c.heat_168.calls.length, 168);
  assert.strictEqual(c.heat_168.start, '2026-09-23T09:00:00.000Z');
  assert.strictEqual(c.heat_168.calls[0], 1);
  assert.strictEqual(c.heat_168.calls[166], 2);
  assert.strictEqual(c.heat_168.calls[143], 2);
  assert.deepStrictEqual(c.routes_7d, [{ service: 'doctor', route: 'preflight', calls: 2 }, { service: 'presign', route: 'token_verdict', calls: 1 }]);
});

test('week charts from the per-file summaries match charts() on the raw events', () => {
  const log = [];
  const routes = ['preflight', 'diagnose', 'fix', 'token_verdict', '__probe_1__'];
  // Nine days of calls up to NOW, spread over services, hours, routes and channels.
  for (let i = 0; i < 400; i++) {
    const t = new Date(NOW - i * 33 * 60 * 1000).toISOString();
    log.push({ t, service: ['doctor', 'presign', 'ichimoku', 'buy', 'wallet'][i % 5], via: i % 7 === 0 ? 'web' : i % 3 ? 'api' : 'mcp', route: routes[i % 5], status: 402 });
  }
  const byFile = new Map();
  for (const e of log) {
    const key = `${e.service} ${e.t.slice(0, 10)}`;
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key).push(e);
  }
  const files = [...byFile].map(([key, events]) => ({ service: key.split(' ')[0], date: key.split(' ')[1], summary: daySummary(events, { service: key.split(' ')[0] }) }));
  const raw = charts(log, NOW);
  const week = weekCharts(files, NOW);
  assert.deepStrictEqual(week.daily, raw.daily);
  assert.deepStrictEqual(week.heat_168, raw.heat_168);
  const bySet = (list) => [...list].sort((a, b) => `${a.service}${a.route}`.localeCompare(`${b.service}${b.route}`));
  assert.deepStrictEqual(bySet(week.routes_7d), bySet(raw.routes_7d));
});

test('all time: total calls, first day, busiest day and hour', () => {
  const s1 = daySummary([
    { t: '2026-09-25T10:00:01Z', via: 'api' }, { t: '2026-09-25T10:30:00Z', via: 'mcp' }, { t: '2026-09-25T11:00:00Z', via: 'web' },
  ]);
  assert.deepStrictEqual(s1.calls, 2);
  assert.strictEqual(s1.hours[10], 2);
  const s2 = daySummary([{ t: '2026-09-26T03:00:00Z', via: 'api' }]);
  const total = allTime([
    { service: 'doctor', date: '2026-09-25', summary: s1 },
    { service: 'presign', date: '2026-09-26', summary: s2 },
    { service: 'presign', date: '2026-09-25', summary: s2 },
    { service: 'other', date: '2026-09-20', summary: s1 },
    { service: 'doctor', date: '2026-09-24', summary: daySummary([]) },
  ]);
  assert.deepStrictEqual(total, { since: '2026-09-25', calls: 4, record_day: { date: '2026-09-25', calls: 3 }, record_hour: { hour: '2026-09-25T10:00:00.000Z', calls: 2 } });
});

test('stats: the BTC chart comes along, trimmed to the chart fields', async () => {
  const usageReader = { load: async () => ({ events, truncated: false }), summarizeAll: async (fn) => ({ files: [{ service: 'doctor', date: '2026-09-30', summary: fn(events) }] }) };
  const fetchFn = async (url) => ({ ok: true, json: async () => (url.includes('/api/chart/') ? { pair: 'BTC-USDT', candles: [{ t: 1, o: 1, h: 2, l: 0, c: 1 }], tenkan: [1], kijun: [1], chikou: [null], span_a: [1], span_b: [1], shift: 26, latest: { signal: 'bullish' }, secret: 'x' } : { signal: 'bullish', cloud_position: 'above', interval: '1d' }) });
  const body = await createPublicStats({ usageReader, fetchFn, now: () => NOW }).get();
  assert.strictEqual(body.btc_chart.candles.length, 1);
  assert.strictEqual(body.btc_chart.latest.signal, 'bullish');
  assert.strictEqual(body.btc_chart.secret, undefined);
  assert.strictEqual(body.all_time.calls, 3);
});

test('stats: the paper trade comes along, trimmed to standings and the trades it already shows', async () => {
  const usageReader = { load: async () => ({ events, truncated: false }) };
  const paper = { standings: { start: '2026-09-29', start_equity_usd: 1000, equity_usd: 980.42, return_pct: -1.96, trades_closed: 3, targets: 0, stops: 3, timeouts: 0, r_closed: -3, open: 3, hidden: 3, secret: 'x' }, days: [{ salt: 'abc' }], trades: [{ date: '2026-09-29', pair: 'XRP-USDT', direction: 'long', status: 'stop', r: -1, pnl_usd: -7.44, entry: 1.5, qty: 12, closed_at: '2026-09-29T15:26:51Z' }] };
  const fetchFn = async (url) => ({ ok: true, json: async () => (url.includes('track-record') ? paper : {}) });
  const body = await createPublicStats({ usageReader, fetchFn, now: () => NOW }).get();
  assert.strictEqual(body.paper_trade.standings.equity_usd, 980.42);
  assert.strictEqual(body.paper_trade.standings.secret, undefined);
  assert.deepStrictEqual(body.paper_trade.trades, [{ date: '2026-09-29', pair: 'XRP-USDT', direction: 'long', status: 'stop', r: -1, pnl_usd: -7.44, closed_at: '2026-09-29T15:26:51Z' }]);
  assert.doesNotMatch(JSON.stringify(body.paper_trade), /salt|qty/);
});

test('stats: the trend paper test comes along with its standings and daily values only', async () => {
  const usageReader = { load: async () => ({ events: [] }) };
  const trend = { standings: { start: '2026-10-01', start_equity_usd: 1000, weeks: 1, in_market: '30/30', trend: { value_usd: 998.8, return_pct: -0.12, max_drawdown_pct: -0.12 }, hold: { value_usd: 998.8, return_pct: -0.12, max_drawdown_pct: -0.12 }, btc: { value_usd: 998.8, return_pct: -0.12, max_drawdown_pct: -0.12 } }, rebalances: [{ universe: [{ coin: 'BTC' }] }], marks: [{ date: '2026-10-01', at: 'x', trend: 998.8, hold: 998.8, btc: 998.8, extra: 1 }] };
  const fetchFn = async (url) => ({ ok: true, json: async () => (url.includes('trend-record') ? trend : {}) });
  const body = await createPublicStats({ usageReader, fetchFn }).get();
  assert.strictEqual(body.trend_paper.standings.trend.value_usd, 998.8);
  assert.strictEqual(body.trend_paper.standings.in_market, '30/30');
  assert.deepStrictEqual(body.trend_paper.marks, [{ date: '2026-10-01', trend: 998.8, trendf: undefined, hold: 998.8, btc: 998.8 }]);
  assert.strictEqual(body.trend_paper.rebalances, undefined);
});

test('stats: the ranking test comes along with its standings and, per finished day, only the numbers', async () => {
  const usageReader = { load: async () => ({ events: [] }) };
  const measure = { mean: 0.8, t: 1.2, days_positive_pct: 60 };
  const rank = {
    standings: { start: '2026-10-15', days_ranked: 7, days_counted: 1, days_waiting: 5, first_look_after_days: 60, primary: 'neutral_atr', neutral_atr: measure, top_minus_rest_pct: measure, neutral_pct: measure, rank_ic: { mean: 0.1, t: null, days_positive_pct: 100 }, ranking_unchanged: true, backtest: { days: 121, neutral_atr: 1.786, neutral_atr_t: 2.88, top_minus_rest_pct: 1.85, script: 'x' } },
    rules: { top: 5 },
    next_result_at: '2026-10-21T12:28:00.000Z',
    waiting: [{ date: '2026-10-16', eligible: 44, due_at: '2026-10-21T12:28:00.000Z' }],
    days: [{ date: '2026-10-15', ranked_at: 'x', eligible: 48, ranking: 'abc', setups: [[1, 'DOGE-USDT', 'short', 0.2, 2.1, 0.19]], result: { counted: true, top_pct: 2, rest_pct: -0.6667, top_minus_rest_pct: 2.6667, neutral_pct: 2.7, neutral_atr: 0.9956, rank_ic: 0.6 } }],
  };
  const fetchFn = async (url) => ({ ok: true, json: async () => (url.includes('rank-test') ? rank : {}) });
  const body = await createPublicStats({ usageReader, fetchFn }).get();
  assert.strictEqual(body.rank_test.standings.days_counted, 1);
  assert.deepStrictEqual(body.rank_test.standings.neutral_atr, measure);
  assert.strictEqual(body.rank_test.standings.rank_ic.t, null);
  assert.strictEqual(body.rank_test.standings.backtest.neutral_atr_t, 2.88);
  assert.strictEqual(body.rank_test.next_result_at, '2026-10-21T12:28:00.000Z');
  assert.deepStrictEqual(body.rank_test.days, [{ date: '2026-10-15', counted: true, neutral_atr: 0.9956, top_minus_rest_pct: 2.6667, top_pct: 2, rest_pct: -0.6667 }]);
  assert.doesNotMatch(JSON.stringify(body.rank_test), /DOGE|"setups"|"waiting"/);
});

test('Fizzl Buy: purchases over 7 days from the day summaries, counts and totals only', () => {
  const day = (date, list) => ({ service: 'buy', date, summary: daySummary(list.map((e) => ({ t: `${date}T10:00:00Z`, via: 'api', ...e })), { service: 'buy' }) });
  const files = [
    day('2026-09-30', [
      { route: 'buy', status: 200, paid: true, ms: 12000, input: { chars: 30, spent_usd: 0.002, instance: 'a' }, result: { delivered: true, service: 'weather.example' }, payer: '0xabc' },
      { route: 'buy', status: 200, paid: true, ms: 8000, input: { chars: 20, spent_usd: 0.004, instance: 'a' }, result: { delivered: true, service: 'prices.example' } },
      { route: 'buy', status: 502, ms: 30000, input: { chars: 20, spent_usd: 0.003, instance: 'a' } },
      { route: 'buy', status: 402, quote: true, input: { chars: 7 } },
      { route: 'pick', status: 200 },
      { route: 'x402_pick', status: 200, via: 'mcp' },
      { route: 'pick', status: 200, via: 'web' },
    ]),
    day('2026-09-25', [{ route: 'buy', status: 200, paid: true, ms: 10000, input: { spent_usd: 0.001 }, result: { service: 'weather.example' } }]),
    day('2026-09-20', [{ route: 'buy', status: 200, paid: true, ms: 1, input: { spent_usd: 1 }, result: { service: 'old.example' } }]),
    { service: 'doctor', date: '2026-09-30', summary: daySummary([{ t: '2026-09-30T10:00:00Z', via: 'api', route: 'buy', status: 200, paid: true }], { service: 'doctor' }) },
  ];
  const b = buyWeek(files, NOW);
  assert.deepStrictEqual(b, { days: 7, purchases: 3, not_delivered: 1, picks: 2, paid_to_sellers_usd: 0.01, sellers: 2, median_ms: 10000 });
  assert.doesNotMatch(JSON.stringify(b), /example|0xabc|payer|instance/);
  assert.deepStrictEqual(SERVICES, ['doctor', 'presign', 'ichimoku', 'buy']);
});

test('all time: PlainText\'s calls still count after it left the charts', () => {
  const s = daySummary([{ t: '2026-09-25T10:00:00Z', via: 'api' }]);
  assert.strictEqual(allTime([{ service: 'plaintext', date: '2026-09-25', summary: s }, { service: 'doctor', date: '2026-09-25', summary: s }, { service: 'wallet', date: '2026-09-25', summary: s }]).calls, 2);
});

test('public stats: a counted line (a bot\'s unpaid 402s for an hour) counts as that many calls', () => {
  const { summarize, daySummary, charts } = require('../lib/public-stats');
  const now = Date.parse('2026-10-25T12:00:00Z');
  const events = [
    { t: '2026-10-25T10:00:00.000Z', service: 'presign', route: 'token', via: 'api', status: 402, quote: true, agent: 'crawler', count: 40, visitors: 12 },
    { t: '2026-10-25T10:12:00.000Z', service: 'presign', route: 'token', via: 'api', status: 200, paid: true },
  ];
  assert.deepEqual([summarize(events, now).requests, summarize(events, now).services.presign], [41, 41]);
  const day = daySummary(events, { service: 'presign' });
  assert.deepEqual([day.calls, day.hours[10], day.routes.token], [41, 41, 41]);
  const c = charts(events, now);
  assert.equal(c.outcomes_24h.quote, 40);
  assert.equal(c.hourly.find((h) => h.hour === '2026-10-25T10:00:00.000Z').presign, 41);
});
