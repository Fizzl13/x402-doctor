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
    return { ...record, history: entry.h, days: state.index.days, last_scan: entry.last, updated: state.index.updated };
  }

  function summary() {
    if (!state.index) return null;
    const counts = { g: 0, c: 0, n: 0, x: 0 };
    for (const r of Object.values(state.index.resources)) {
      const last = r.h.slice(-1);
      if (last in counts) counts[last]++;
    }
    return { updated: state.index.updated, days: state.index.days.length, resources: Object.keys(state.index.resources).length, latest: { go: counts.g, caution: counts.c, no_go: counts.n, unreachable: counts.x } };
  }

  return { lookup, refresh, summary };
}

module.exports = { createTrustIndex };
