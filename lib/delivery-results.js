// The results of paid delivery checks (lib/delivery-checks.js): index.json on the delivery-data branch, written by
// .github/workflows/delivery-check.yml after each purchase. Refreshed every 5 minutes, so a finished job shows up
// on the status route soon after the workflow publishes it.

const { keyOf } = require('./bazaar-index');

const RESULTS_URL = 'https://raw.githubusercontent.com/Fizzl13/x402-doctor/delivery-data/index.json';
const DATA_URL = 'https://github.com/Fizzl13/x402-doctor/tree/delivery-data';
const TTL_MS = 5 * 60 * 1000;
const RETRY_MS = 2 * 60 * 1000; // after a failed load

function createDeliveryResults({ url = process.env.DELIVERY_RESULTS_URL || RESULTS_URL, fetchImpl = fetch, now = Date.now } = {}) {
  // Tests never download the real file unless they pass their own fetch.
  const disabled = Boolean(process.env.NODE_TEST_CONTEXT) && fetchImpl === globalThis.fetch;
  let state = { at: 0, byId: new Map(), byKey: new Map() };
  let loading = null;

  function refresh() {
    if (disabled) return Promise.resolve();
    if (!loading) {
      loading = (async () => {
        const res = await fetchImpl(`${url}?t=${Math.floor(now() / TTL_MS)}`, { signal: AbortSignal.timeout(20000) });
        if (res.status === 404) { state = { at: now(), byId: new Map(), byKey: new Map() }; return; } // no check run yet
        if (!res.ok) throw new Error(`delivery results HTTP ${res.status}`);
        const index = await res.json();
        const list = Object.values(index?.results || {});
        const byKey = new Map();
        for (const r of list.sort((a, b) => String(a.date).localeCompare(String(b.date)))) byKey.set(keyOf(r.url), r); // the newest per endpoint
        state = { at: now(), byId: new Map(list.map((r) => [r.id, r])), byKey };
      })()
        .catch((err) => { state = { ...state, at: now() - TTL_MS + RETRY_MS }; console.error('[delivery-results] refresh failed:', err.message); })
        .finally(() => { loading = null; });
    }
    return loading;
  }

  async function fresh(waitMs) {
    if (!state.at || now() - state.at > TTL_MS) {
      const pending = refresh();
      if (waitMs > 0) await Promise.race([pending, new Promise((r) => setTimeout(r, waitMs))]);
    }
  }

  return {
    refresh,
    async forId(id, { waitMs = 0 } = {}) { await fresh(waitMs); return state.byId.get(id) || null; },
    async forUrl(targetUrl, { waitMs = 0 } = {}) { await fresh(waitMs); return state.byKey.get(keyOf(targetUrl)) || null; },
    async ids({ waitMs = 0 } = {}) { await fresh(waitMs); return new Set(state.byId.keys()); },
  };
}

module.exports = { createDeliveryResults, RESULTS_URL, DATA_URL };
