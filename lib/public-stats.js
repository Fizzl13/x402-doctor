// public-stats.js
//
// GET /api/stats: the live numbers on fizzl.eu and its subdomains. Only totals
// (how many API requests the four Fizzl services got today, per service) and
// the free daily BTC trend from Ichimoku Signal; no inputs, wallets, visitors
// or anything else from the log. Computed at most every 5 minutes. The charts
// on lab.fizzl.eu get counts per hour and per day, how the calls ended
// (price quote, answered, rejected) and response times (median and 95th
// percentile): never who called, what they sent or what anyone paid.

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
  const outcomes = { quote: 0, answered: 0, rejected: 0 };
  const times = Object.fromEntries(SERVICES.map((s) => [s, []]));
  for (const e of events) {
    if (!e || typeof e.t !== 'string' || !SERVICES.includes(e.service)) continue;
    if (e.via !== 'api' && e.via !== 'mcp') continue;
    const t = Date.parse(e.t);
    if (!(t >= firstDay) || t > nowMs) continue;
    daily[Math.floor((t - firstDay) / DAY)][e.service]++;
    if (t < firstHour) continue;
    hourly[Math.floor((t - firstHour) / HOUR)][e.service]++;
    if (e.status === 402) outcomes.quote++;
    else if (e.status >= 200 && e.status < 300) outcomes.answered++;
    else if (e.status >= 400) outcomes.rejected++;
    if (Number.isFinite(e.ms)) times[e.service].push(e.ms);
  }
  const sorted = Object.fromEntries(SERVICES.map((s) => [s, times[s].sort((a, b) => a - b)]));
  const at = (p) => Object.fromEntries(SERVICES.map((s) => [s, percentile(sorted[s], p)]));
  return { hourly, daily, outcomes_24h: outcomes, median_ms_24h: at(0.5), p95_ms_24h: at(0.95) };
}

function createPublicStats({ usageReader, fetchFn = globalThis.fetch, now = () => Date.now(), ttlMs = 5 * 60 * 1000, trendUrl = 'https://ichimoku-signal.fizzl.eu/api/trend/BTC-USDT' } = {}) {
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

  async function compute() {
    const [log, trend] = await Promise.all([usageReader.load({ days: 7, max: 200000 }), btc()]);
    const today = summarize(log.events || [], now());
    return { updated: new Date(now()).toISOString(), today: { ...today, capped: Boolean(log.truncated) }, services_online: SERVICES.length, btc: trend, charts: charts(log.events || [], now()) };
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

module.exports = { createPublicStats, summarize, charts, statsCors, STATS_ORIGINS: ORIGINS };
