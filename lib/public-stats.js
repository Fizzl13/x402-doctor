// public-stats.js
//
// GET /api/stats: the live numbers on fizzl.eu and its subdomains. Only totals
// (how many API requests the four Fizzl services got today, per service) and
// the free daily BTC trend from Ichimoku Signal; no inputs, wallets, visitors
// or anything else from the log. Computed at most every 5 minutes.

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
    const [log, trend] = await Promise.all([usageReader.load({ days: 1 }), btc()]);
    const today = summarize(log.events || [], now());
    return { updated: new Date(now()).toISOString(), today: { ...today, capped: Boolean(log.truncated) }, services_online: SERVICES.length, btc: trend };
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

module.exports = { createPublicStats, summarize, statsCors, STATS_ORIGINS: ORIGINS };
