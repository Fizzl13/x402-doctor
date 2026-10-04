// Reads the published x402 Trust Index (index.json on the trust-data branch,
// written daily by scripts/trust-scan.js) and answers track-record lookups.
// Loaded at startup and refreshed every 6 hours; "unknown" (null) is a valid
// answer while it loads or when a URL was never scanned.

const { keyOf } = require('./bazaar-index');
const { trackRecord } = require('./trust-scan');

const INDEX_URL = 'https://raw.githubusercontent.com/Fizzl13/x402-doctor/trust-data/index.json';
const TTL_MS = 6 * 60 * 60 * 1000;

function createTrustIndex({ url = process.env.TRUST_INDEX_URL || INDEX_URL, fetchImpl = fetch } = {}) {
  let state = { at: 0, index: null };
  let loading = null;

  function refresh() {
    if (!loading) {
      loading = (async () => {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new Error(`trust index HTTP ${res.status}`);
        state = { at: Date.now(), index: await res.json() };
      })()
        .catch((err) => console.error('[trust-index] refresh failed:', err.message))
        .finally(() => {
          loading = null;
        });
    }
    return loading;
  }

  // Track record for a URL, or null when unknown.
  async function lookup(targetUrl, { waitMs = 0 } = {}) {
    if (!state.index || Date.now() - state.at > TTL_MS) {
      const pending = refresh();
      if (!state.index && waitMs > 0) await Promise.race([pending, new Promise((r) => setTimeout(r, waitMs))]);
    }
    const entry = state.index?.resources?.[keyOf(targetUrl)];
    if (!entry) return null;
    const record = trackRecord(entry.h);
    if (!record) return null;
    return { ...record, protocol: entry.p === 'mpp' ? 'mpp' : 'x402', history: entry.h, days: state.index.days, last_scan: entry.last, updated: state.index.updated };
  }

  // The seller's other scanned resources on the same origin: how many, how
  // many are payable today and how reliable they were. Null when unknown.
  async function seller(targetUrl, { waitMs = 0 } = {}) {
    if (!state.index || Date.now() - state.at > TTL_MS) {
      const pending = refresh();
      if (!state.index && waitMs > 0) await Promise.race([pending, new Promise((r) => setTimeout(r, waitMs))]);
    }
    if (!state.index) return null;
    const origin = new URL(targetUrl).origin;
    let resources = 0;
    let payableNow = 0;
    let ratios = 0;
    let unreliable = 0;
    for (const [key, entry] of Object.entries(state.index.resources || {})) {
      if (key !== origin && !key.startsWith(`${origin}/`)) continue;
      const record = trackRecord(entry.h);
      if (!record) continue;
      resources++;
      if (record.last === 'g' || record.last === 'c') payableNow++;
      ratios += record.payable_ratio;
      if (record.days_checked >= 3 && record.payable_ratio < 0.5) unreliable++;
    }
    if (resources === 0) return { origin, resources: 0 };
    return { origin, resources, payable_now: payableNow, avg_payable_ratio: Math.round((ratios / resources) * 100) / 100, unreliable };
  }

  // Totals for the /trust page: the latest scan, why payments would fail in
  // it (a resource can have several reasons), and one row per scanned day.
  function summary() {
    if (!state.index) return null;
    const { days, resources } = state.index;
    const counts = { g: 0, c: 0, n: 0, x: 0 };
    const byProtocol = { x402: { resources: 0, g: 0, c: 0, n: 0, x: 0 }, mpp: { resources: 0, g: 0, c: 0, n: 0, x: 0 } };
    const reasons = {};
    const perDay = days.map(() => ({ g: 0, c: 0, n: 0, x: 0 }));
    for (const r of Object.values(resources)) {
      const last = r.h.slice(-1);
      const proto = byProtocol[r.p === 'mpp' ? 'mpp' : 'x402'];
      proto.resources++;
      if (last in proto) proto[last]++;
      if (last in counts) {
        counts[last]++;
        for (const code of (r.last && r.last.codes) || []) reasons[code] = (reasons[code] || 0) + 1;
      }
      // h is aligned to the end of days[] (oldest letters may be missing)
      const offset = days.length - r.h.length;
      for (let i = 0; i < r.h.length; i++) {
        const day = perDay[offset + i];
        if (day && r.h[i] in day) day[r.h[i]]++;
      }
    }
    return {
      updated: state.index.updated,
      days: days.length,
      resources: Object.keys(resources).length,
      latest: { go: counts.g, caution: counts.c, no_go: counts.n, unreachable: counts.x },
      by_protocol: Object.fromEntries(Object.entries(byProtocol).map(([k, v]) => [k, { resources: v.resources, go: v.g, caution: v.c, no_go: v.n, unreachable: v.x }])),
      reasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([code, count]) => ({ code, count })),
      daily: days.map((date, i) => ({ date, go: perDay[i].g, caution: perDay[i].c, no_go: perDay[i].n, unreachable: perDay[i].x })),
    };
  }

  return { lookup, seller, refresh, summary };
}

module.exports = { createTrustIndex };
