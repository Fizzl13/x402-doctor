// The latest spot-buy sample (lib/spot-buy.js; latest.json on the spot-data branch, written weekly by
// .github/workflows/spot-buy.yml): how often a "go" from the Trust Index turned into "paid and delivered".
// Loaded on first use and refreshed every 6 hours; null while it loads or when there is no run yet.

const { keyOf } = require('./bazaar-index');

const SPOT_URL = 'https://raw.githubusercontent.com/Fizzl13/x402-doctor/spot-data/latest.json';
const DATA_URL = 'https://github.com/Fizzl13/x402-doctor/tree/spot-data';
const TTL_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000; // after a failed load

// What happened per purchase, without the wallet's or the seller's internals.
function purchaseOf(r, date) {
  return {
    url: r.url,
    host: r.host,
    result: r.result,
    price_usd: r.price_usd ?? null,
    charged_usd: r.charged_usd ?? null,
    status: r.status ?? null,
    ...(/[a-z0-9]/i.test(r.reason || '') ? { reason: r.reason } : {}), // not a bare "{}"
    request: r.request?.source ?? null,
    explorer: r.proof?.explorer ?? null,
    date,
  };
}

function viewOf(report) {
  if (!report?.summary?.live || !Array.isArray(report.results)) return null;
  const bought = report.results.filter((r) => r.step === 'paid' || r.result === 'charged_not_delivered');
  return {
    date: report.date,
    index_date: report.index_date ?? null,
    rules: report.rules ?? null,
    summary: report.summary,
    purchases: bought.map((r) => purchaseOf(r, report.date)),
    data: DATA_URL,
  };
}

function createSpotResults({ url = process.env.SPOT_RESULTS_URL || SPOT_URL, fetchImpl = fetch, now = Date.now } = {}) {
  // Tests never download the real file unless they pass their own fetch.
  const disabled = Boolean(process.env.NODE_TEST_CONTEXT) && fetchImpl === globalThis.fetch;
  let state = { at: 0, view: null, byKey: new Map() };
  let loading = null;

  function refresh() {
    if (disabled) return Promise.resolve();
    if (!loading) {
      loading = (async () => {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new Error(`spot results HTTP ${res.status}`);
        const view = viewOf(await res.json());
        const byKey = new Map((view?.purchases || []).map((p) => [keyOf(p.url), p]));
        state = { at: now(), view, byKey };
      })()
        .catch((err) => { state = { ...state, at: now() - TTL_MS + RETRY_MS }; console.error('[spot-results] refresh failed:', err.message); })
        .finally(() => { loading = null; });
    }
    return loading;
  }

  async function fresh(waitMs) {
    if (!state.at || now() - state.at > TTL_MS) {
      const pending = refresh();
      if (!state.view && waitMs > 0) await Promise.race([pending, new Promise((r) => setTimeout(r, waitMs))]);
    }
  }

  return {
    refresh,
    // The latest run: summary plus every purchase (endpoints skipped before paying are left out).
    async latest({ waitMs = 0 } = {}) { await fresh(waitMs); return state.view; },
    // This endpoint's purchase in the latest run, or null when it wasn't in the sample.
    async forUrl(targetUrl, { waitMs = 0 } = {}) { await fresh(waitMs); return state.byKey.get(keyOf(targetUrl)) || null; },
  };
}

module.exports = { createSpotResults, viewOf, SPOT_URL, DATA_URL };
