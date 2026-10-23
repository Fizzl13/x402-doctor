// public-stats.js
//
// GET /api/stats: the live numbers on fizzl.eu and its subdomains. Only totals
// (how many API requests the four Fizzl agents got today, per service: x402
// Doctor, presign-guard, Ichimoku Signal and Fizzl Buy, which took PlainText's
// place on 23 Oct 2026) and
// the free daily BTC trend from Ichimoku Signal; no inputs, wallets, visitors
// or anything else from the log. Computed at most every 5 minutes. The charts
// on lab.fizzl.eu get counts per hour and per day, how the calls ended
// (price quote, answered, rejected) and response times (median and 95th
// percentile), a week-by-hour heatmap, the most asked routes, totals since
// the log started and the daily Ichimoku chart of BTC: never who called, what
// they sent or what anyone paid. One exception, for the comets on atlas.fizzl.eu:
// how many calls per hour were paid (paid_hourly), a count only, never who paid,
// how much or for what. Also the public paper-trade standings of
// Ichimoku Signal (only the trades its own page already shows), and Fizzl
// Buy's purchases over 7 days as counts and totals (no buyer, need or seller).

'use strict';

const SERVICES = ['doctor', 'presign', 'ichimoku', 'buy'];
// No longer charted, but its calls still count in the all-time totals: PlainText (paused 16 Oct 2026, replaced on the
// charts by Fizzl Buy on 23 Oct 2026).
const FORMER_SERVICES = ['plaintext'];
const ORIGINS = new Set(['https://fizzl.eu', 'https://www.fizzl.eu', 'https://ai.fizzl.eu', 'https://cv.fizzl.eu', 'https://lab.fizzl.eu', 'https://projects.fizzl.eu', 'https://atlas.fizzl.eu']);

function statsCors(req, res, next) {
  res.vary('Origin');
  const origin = req.get('origin');
  if (origin && ORIGINS.has(origin)) res.set({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Max-Age': '600' });
  next();
}

function summarize(events, nowMs) {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const services = Object.fromEntries(SERVICES.map((s) => [s, 0]));
  let requests = 0;
  for (const e of events) {
    if (!e || typeof e.t !== 'string' || e.t.slice(0, 10) !== day) continue;
    if (e.via !== 'api' && e.via !== 'mcp') continue; // agents and scripts, not the web demos
    requests++;
    if (e.service in services) services[e.service]++;
  }
  return { date: day, requests, services };
}

const HOUR = 3600000;
// Route names as the services log them ("preflight batch", "token_verdict");
// probes with made-up tool names ("__probe_…__") are left out.
const ROUTE_NAME = /^[a-z][a-z +_-]{0,40}$/;
const DAY = 86400000;

function emptyRow() {
  return Object.fromEntries(SERVICES.map((s) => [s, 0]));
}

function percentile(sorted, p) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null;
}

function charts(events, nowMs) {
  const hourStart = Math.floor(nowMs / HOUR) * HOUR;
  const firstHour = hourStart - 23 * HOUR;
  const hourly = Array.from({ length: 24 }, (_, i) => ({ hour: new Date(firstHour + i * HOUR).toISOString(), ...emptyRow() }));
  const dayStart = Date.parse(new Date(nowMs).toISOString().slice(0, 10));
  const firstDay = dayStart - 6 * DAY;
  const daily = Array.from({ length: 7 }, (_, i) => ({ date: new Date(firstDay + i * DAY).toISOString().slice(0, 10), ...emptyRow() }));
  const heat = new Array(168).fill(0); // the last 7 x 24 hours, oldest first
  const firstHeat = hourStart - 167 * HOUR;
  const routes = new Map();
  const outcomes = { quote: 0, answered: 0, rejected: 0 };
  const paidHourly = new Array(24).fill(0); // settled payments per hour, a count only (no payer, no amount)
  const times = Object.fromEntries(SERVICES.map((s) => [s, []]));
  for (const e of events) {
    if (!e || typeof e.t !== 'string' || !SERVICES.includes(e.service)) continue;
    if (e.via !== 'api' && e.via !== 'mcp') continue;
    const t = Date.parse(e.t);
    if (!(t >= Math.min(firstDay, firstHeat)) || t > nowMs) continue;
    if (t >= firstHeat) heat[Math.floor((t - firstHeat) / HOUR)]++;
    if (t < firstDay) continue;
    daily[Math.floor((t - firstDay) / DAY)][e.service]++;
    if (typeof e.route === 'string' && ROUTE_NAME.test(e.route)) {
      const key = `${e.service} ${e.route}`;
      if (!routes.has(key)) routes.set(key, { service: e.service, route: e.route, calls: 0 });
      routes.get(key).calls++;
    }
    if (t < firstHour) continue;
    hourly[Math.floor((t - firstHour) / HOUR)][e.service]++;
    if (e.paid === true) paidHourly[Math.floor((t - firstHour) / HOUR)]++;
    if (e.status === 402) outcomes.quote++;
    else if (e.status >= 200 && e.status < 300) outcomes.answered++;
    else if (e.status >= 400) outcomes.rejected++;
    if (Number.isFinite(e.ms)) times[e.service].push(e.ms);
  }
  const sorted = Object.fromEntries(SERVICES.map((s) => [s, times[s].sort((a, b) => a - b)]));
  const at = (p) => Object.fromEntries(SERVICES.map((s) => [s, percentile(sorted[s], p)]));
  const top = [...routes.values()].sort((a, b) => b.calls - a.calls).slice(0, 8);
  return { hourly, paid_hourly: paidHourly, daily, heat_168: { start: new Date(firstHeat).toISOString(), calls: heat }, routes_7d: top, outcomes_24h: outcomes, median_ms_24h: at(0.5), p95_ms_24h: at(0.95) };
}

// Fizzl Buy's purchases in one day file: delivered (paid, 2xx), none of the tried sellers delivered (502), free picks,
// what the sellers were paid (input.spent_usd, logged since 23 Oct 2026), which sellers (hosts) and how long the
// delivered purchases took.
function buyDay(events) {
  const out = { purchases: 0, not_delivered: 0, picks: 0, spent_usd: 0, sellers: [], ms: [] };
  const sellers = new Set();
  for (const e of events) {
    if (!e || typeof e.t !== 'string' || (e.via !== 'api' && e.via !== 'mcp')) continue;
    if (e.route === 'pick' || e.route === 'x402_pick') { out.picks++; continue; }
    if (e.route !== 'buy') continue;
    const spent = Number(e.input && e.input.spent_usd);
    if (spent > 0) out.spent_usd += spent;
    if (e.paid === true && e.status >= 200 && e.status < 300) {
      out.purchases++;
      if (e.result && typeof e.result.service === 'string') sellers.add(e.result.service);
      if (Number.isFinite(e.ms)) out.ms.push(e.ms);
    } else if (e.status === 502) out.not_delivered++;
  }
  out.spent_usd = Math.round(out.spent_usd * 1e6) / 1e6;
  out.sellers = [...sellers];
  return out;
}

// Per day file: agent and MCP calls, in total, per UTC hour and per route (and for Fizzl Buy its purchases).
function daySummary(events, { service } = {}) {
  const hours = new Array(24).fill(0);
  const routes = {};
  let calls = 0;
  for (const e of events) {
    if (!e || typeof e.t !== 'string' || (e.via !== 'api' && e.via !== 'mcp')) continue;
    calls++;
    const h = Number(e.t.slice(11, 13));
    if (h >= 0 && h < 24) hours[h]++;
    if (typeof e.route === 'string' && ROUTE_NAME.test(e.route)) routes[e.route] = (routes[e.route] || 0) + 1;
  }
  return { calls, hours, routes, ...(service === 'buy' ? { buy: buyDay(events) } : {}) };
}

// Fizzl Buy over the last 7 UTC days (today included), from its day summaries: counts and totals only, the number of
// different sellers but not who they are.
function buyWeek(files, nowMs) {
  const dayStart = Date.parse(new Date(nowMs).toISOString().slice(0, 10));
  const firstDay = dayStart - 6 * DAY;
  const out = { days: 7, purchases: 0, not_delivered: 0, picks: 0, paid_to_sellers_usd: 0, sellers: 0, median_ms: null };
  const sellers = new Set();
  const ms = [];
  for (const { service, date, summary } of files) {
    const b = service === 'buy' && summary && summary.buy;
    const dayMs = Date.parse(date);
    if (!b || !(dayMs >= firstDay && dayMs <= dayStart)) continue;
    out.purchases += b.purchases;
    out.not_delivered += b.not_delivered;
    out.picks += b.picks;
    out.paid_to_sellers_usd += b.spent_usd;
    b.sellers.forEach((h) => sellers.add(h));
    ms.push(...b.ms);
  }
  out.paid_to_sellers_usd = Math.round(out.paid_to_sellers_usd * 1e6) / 1e6;
  out.sellers = sellers.size;
  out.median_ms = percentile(ms.sort((a, b) => a - b), 0.5);
  return out;
}

// The 7-day parts of charts() (per day, the week-by-hour heatmap and the most asked routes), from the per-file
// summaries instead of the raw events: a week of raw events is ~170,000 objects in memory (13 Oct 2026).
function weekCharts(files, nowMs) {
  const hourStart = Math.floor(nowMs / HOUR) * HOUR;
  const dayStart = Date.parse(new Date(nowMs).toISOString().slice(0, 10));
  const firstDay = dayStart - 6 * DAY;
  const daily = Array.from({ length: 7 }, (_, i) => ({ date: new Date(firstDay + i * DAY).toISOString().slice(0, 10), ...emptyRow() }));
  const heat = new Array(168).fill(0);
  const firstHeat = hourStart - 167 * HOUR;
  const routes = new Map();
  for (const { service, date, summary } of files) {
    if (!SERVICES.includes(service) || !summary) continue;
    const dayMs = Date.parse(date);
    summary.hours.forEach((n, h) => {
      const t = dayMs + h * HOUR;
      if (n && t >= firstHeat && t <= hourStart) heat[(t - firstHeat) / HOUR] += n;
    });
    if (!(dayMs >= firstDay && dayMs <= dayStart)) continue;
    daily[(dayMs - firstDay) / DAY][service] += summary.calls;
    for (const [route, calls] of Object.entries(summary.routes || {})) {
      const key = `${service} ${route}`;
      if (!routes.has(key)) routes.set(key, { service, route, calls: 0 });
      routes.get(key).calls += calls;
    }
  }
  const top = [...routes.values()].sort((a, b) => b.calls - a.calls || `${a.service} ${a.route}`.localeCompare(`${b.service} ${b.route}`)).slice(0, 8);
  return { daily, heat_168: { start: new Date(firstHeat).toISOString(), calls: heat }, routes_7d: top };
}

// Everything since the log started: total calls, the busiest day and hour (former services included).
function allTime(files) {
  const days = new Map();
  for (const { service, date, summary } of files) {
    if ((!SERVICES.includes(service) && !FORMER_SERVICES.includes(service)) || !summary) continue;
    const d = days.get(date) || { calls: 0, hours: new Array(24).fill(0) };
    d.calls += summary.calls;
    summary.hours.forEach((n, h) => { d.hours[h] += n; });
    days.set(date, d);
  }
  let calls = 0; let since = null; let recordDay = null; let recordHour = null;
  for (const [date, d] of [...days.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!d.calls) continue;
    calls += d.calls;
    if (!since) since = date;
    if (!recordDay || d.calls > recordDay.calls) recordDay = { date, calls: d.calls };
    d.hours.forEach((n, h) => {
      if (!recordHour || n > recordHour.calls) recordHour = { hour: `${date}T${String(h).padStart(2, '0')}:00:00.000Z`, calls: n };
    });
  }
  return { since, calls, record_day: recordDay, record_hour: recordHour };
}

function createPublicStats({ usageReader, fetchFn = globalThis.fetch, now = () => Date.now(), ttlMs = 5 * 60 * 1000, trendUrl = 'https://ichimoku-signal.fizzl.eu/api/trend/BTC-USDT', chartUrl = 'https://ichimoku-signal.fizzl.eu/api/chart/BTC-USDT', paperUrl = 'https://ichimoku-signal.fizzl.eu/track-record.json', trendPaperUrl = 'https://ichimoku-signal.fizzl.eu/trend-record.json', rankTestUrl = 'https://ichimoku-signal.fizzl.eu/rank-test.json' } = {}) {
  let cached = null;
  let pending = null;

  async function btc() {
    try {
      const res = await fetchFn(trendUrl, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const b = await res.json();
      return { signal: b.signal, cloud_position: b.cloud_position, interval: b.interval };
    } catch {
      return null;
    }
  }

  // The daily Ichimoku chart of BTC for lab.fizzl.eu (null when unavailable).
  async function btcChart() {
    try {
      const res = await fetchFn(chartUrl, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const b = await res.json();
      const { candles, tenkan, kijun, chikou, span_a: spanA, span_b: spanB, shift, latest, updated } = b;
      return Array.isArray(candles) ? { candles, tenkan, kijun, chikou, span_a: spanA, span_b: spanB, shift, latest, updated } : null;
    } catch {
      return null;
    }
  }

  // The public paper-trade experiment of Ichimoku Signal: its standings and the
  // trades it already shows (picks appear there 24 hours after they are made).
  async function paperTrade() {
    try {
      const res = await fetchFn(paperUrl, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const b = await res.json();
      if (!b || !b.standings || !Array.isArray(b.trades)) return null;
      const s = b.standings;
      const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
      return {
        standings: pick(s, ['start', 'start_equity_usd', 'equity_usd', 'return_pct', 'trades_closed', 'targets', 'stops', 'timeouts', 'r_closed', 'open', 'hidden', 'unrealized_usd']),
        trades: b.trades.slice(-60).map((t) => pick(t, ['date', 'pair', 'direction', 'status', 't1_hit', 'r', 'pnl_usd', 'unrealized_usd', 'unrealized_r', 'opened_at', 'closed_at'])),
      };
    } catch {
      return null;
    }
  }

  // The trend paper test of Ichimoku Signal: standings, daily values and this
  // week's holdings count (all public at once on /trend-record).
  async function trendPaper() {
    try {
      const res = await fetchFn(trendPaperUrl, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const b = await res.json();
      if (!b || !b.standings || !Array.isArray(b.marks)) return null;
      const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
      const line = (o) => (o ? { value_usd: num(o.value_usd), return_pct: num(o.return_pct), max_drawdown_pct: num(o.max_drawdown_pct) } : undefined);
      const s = b.standings;
      return {
        standings: { start: s.start, start_equity_usd: num(s.start_equity_usd), weeks: num(s.weeks), in_market: s.in_market ?? null, in_market_f: s.in_market_f ?? null, trendf_since: s.trendf_since ?? null, trend: line(s.trend), trendf: line(s.trendf), hold: line(s.hold), btc: line(s.btc) },
        marks: b.marks.slice(-180).map((m) => ({ date: m.date, trend: num(m.trend), trendf: num(m.trendf), hold: num(m.hold), btc: num(m.btc) })),
      };
    } catch {
      return null;
    }
  }

  // The ranking test of Ichimoku Signal: does the top 5 of /setups beat the rest of that day, 5 days later?
  // Standings and the finished days only (a day shows on /rank-test once its 5 days are up).
  async function rankTest() {
    try {
      const res = await fetchFn(rankTestUrl, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const b = await res.json();
      if (!b || !b.standings || !Array.isArray(b.days)) return null;
      const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
      const measure = (m) => (m ? { mean: num(m.mean), t: num(m.t) ?? null, days_positive_pct: num(m.days_positive_pct) } : null);
      const s = b.standings;
      const bt = s.backtest || {};
      return {
        standings: {
          start: s.start, days_ranked: num(s.days_ranked), days_counted: num(s.days_counted), days_waiting: num(s.days_waiting), first_look_after_days: num(s.first_look_after_days),
          neutral_atr: measure(s.neutral_atr), top_minus_rest_pct: measure(s.top_minus_rest_pct), rank_ic: measure(s.rank_ic), ranking_unchanged: s.ranking_unchanged === true,
          backtest: { days: num(bt.days), neutral_atr: num(bt.neutral_atr), neutral_atr_t: num(bt.neutral_atr_t), top_minus_rest_pct: num(bt.top_minus_rest_pct) },
        },
        next_result_at: typeof b.next_result_at === 'string' ? b.next_result_at : null,
        days: b.days.slice(-180).map((d) => ({ date: d.date, counted: d.result?.counted === true, neutral_atr: num(d.result?.neutral_atr), top_minus_rest_pct: num(d.result?.top_minus_rest_pct), top_pct: num(d.result?.top_pct), rest_pct: num(d.result?.rest_pct) })),
      };
    } catch {
      return null;
    }
  }

  // One small summary per day file for the whole log (all-time totals, the 7-day charts); null if unavailable.
  async function daySummaries() {
    if (typeof usageReader.summarizeAll !== 'function') return null;
    try {
      const { files } = await usageReader.summarizeAll(daySummary);
      return files && files.length ? files : null;
    } catch {
      return null;
    }
  }

  async function compute() {
    // Raw events only for the last day (today's totals, the 24-hour charts); the 7-day charts come from the summaries.
    const [log, files, trend, chart, paper, trendTest, ranking] = await Promise.all([usageReader.load({ days: 1, max: 200000 }), daySummaries(), btc(), btcChart(), paperTrade(), trendPaper(), rankTest()]);
    const events = log.events || [];
    const today = summarize(events, now());
    const chartData = files ? { ...charts(events, now()), ...weekCharts(files, now()) } : charts(events, now());
    return { updated: new Date(now()).toISOString(), today: { ...today, capped: Boolean(log.truncated) }, services_online: SERVICES.length, btc: trend, btc_chart: chart, paper_trade: paper, trend_paper: trendTest, rank_test: ranking, all_time: files ? allTime(files) : null, buy: files ? buyWeek(files, now()) : null, charts: chartData };
  }

  async function get() {
    if (cached && now() - cached.at < ttlMs) return cached.body;
    if (!pending) {
      pending = compute().then((body) => { cached = { at: now(), body }; return body; }).finally(() => { pending = null; });
    }
    try {
      return await pending;
    } catch (err) {
      if (cached) return cached.body; // keep showing the last good numbers
      throw err;
    }
  }

  return { get };
}

module.exports = { createPublicStats, summarize, charts, weekCharts, daySummary, buyWeek, allTime, statsCors, STATS_ORIGINS: ORIGINS, SERVICES };
