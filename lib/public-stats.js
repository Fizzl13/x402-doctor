// public-stats.js
//
// GET /api/stats: the live numbers on fizzl.eu and its subdomains. Only totals
// (how many API requests the four Fizzl services got today, per service) and
// the free daily BTC trend from Ichimoku Signal; no inputs, wallets, visitors
// or anything else from the log. Computed at most every 5 minutes. The charts
// on lab.fizzl.eu get counts per hour and per day, how the calls ended
// (price quote, answered, rejected) and response times (median and 95th
// percentile), a week-by-hour heatmap, the most asked routes, totals since
// the log started and the daily Ichimoku chart of BTC: never who called, what
// they sent or what anyone paid.

'use strict';

const SERVICES = ['doctor', 'presign', 'ichimoku', 'plaintext'];
const ORIGINS = new Set(['https://fizzl.eu', 'https://www.fizzl.eu', 'https://ai.fizzl.eu', 'https://cv.fizzl.eu', 'https://lab.fizzl.eu', 'https://projects.fizzl.eu']);

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
    if (e.status === 402) outcomes.quote++;
    else if (e.status >= 200 && e.status < 300) outcomes.answered++;
    else if (e.status >= 400) outcomes.rejected++;
    if (Number.isFinite(e.ms)) times[e.service].push(e.ms);
  }
  const sorted = Object.fromEntries(SERVICES.map((s) => [s, times[s].sort((a, b) => a - b)]));
  const at = (p) => Object.fromEntries(SERVICES.map((s) => [s, percentile(sorted[s], p)]));
  const top = [...routes.values()].sort((a, b) => b.calls - a.calls).slice(0, 8);
  return { hourly, daily, heat_168: { start: new Date(firstHeat).toISOString(), calls: heat }, routes_7d: top, outcomes_24h: outcomes, median_ms_24h: at(0.5), p95_ms_24h: at(0.95) };
}

// Per day file: agent and MCP calls, in total and per UTC hour.
function daySummary(events) {
  const hours = new Array(24).fill(0);
  let calls = 0;
  for (const e of events) {
    if (!e || typeof e.t !== 'string' || (e.via !== 'api' && e.via !== 'mcp')) continue;
    calls++;
    const h = Number(e.t.slice(11, 13));
    if (h >= 0 && h < 24) hours[h]++;
  }
  return { calls, hours };
}

// Everything since the log started: total calls, the busiest day and hour.
function allTime(files) {
  const days = new Map();
  for (const { service, date, summary } of files) {
    if (!SERVICES.includes(service) || !summary) continue;
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

function createPublicStats({ usageReader, fetchFn = globalThis.fetch, now = () => Date.now(), ttlMs = 5 * 60 * 1000, trendUrl = 'https://ichimoku-signal.fizzl.eu/api/trend/BTC-USDT', chartUrl = 'https://ichimoku-signal.fizzl.eu/api/chart/BTC-USDT' } = {}) {
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

  async function sinceStart() {
    if (typeof usageReader.summarizeAll !== 'function') return null;
    try {
      const { files } = await usageReader.summarizeAll(daySummary);
      return files && files.length ? allTime(files) : null;
    } catch {
      return null;
    }
  }

  async function compute() {
    const [log, trend, chart, total] = await Promise.all([usageReader.load({ days: 7, max: 200000 }), btc(), btcChart(), sinceStart()]);
    const today = summarize(log.events || [], now());
    return { updated: new Date(now()).toISOString(), today: { ...today, capped: Boolean(log.truncated) }, services_online: SERVICES.length, btc: trend, btc_chart: chart, all_time: total, charts: charts(log.events || [], now()) };
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

module.exports = { createPublicStats, summarize, charts, daySummary, allTime, statsCors, STATS_ORIGINS: ORIGINS };
