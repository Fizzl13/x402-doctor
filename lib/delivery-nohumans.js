// Delivery evidence from nohumans.directory: the endpoints it bought with real USDC and got an answer from
// (paid_verified in its CC BY 4.0 catalogue), written daily by the trust scan's plan job to delivery-nohumans.json on
// the trust-data branch as { endpoints: { key: [day of that purchase, the listing's status now, its id] } }.
// The preflight shows it as information next to its own check: the scan sees whether an agent can pay, this shows
// that someone paid and got an answer. Loaded on first use and refreshed every 6 hours; null while it loads.

const { keyOf } = require('./bazaar-index');

const DELIVERY_URL = 'https://raw.githubusercontent.com/Fizzl13/x402-doctor/trust-data/delivery-nohumans.json';
const TTL_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000; // after a failed load

function createNohumansDelivery({ url = process.env.NOHUMANS_DELIVERY_URL || DELIVERY_URL, fetchImpl = fetch, now = Date.now } = {}) {
  // Tests never download the real file unless they pass their own fetch.
  const disabled = Boolean(process.env.NODE_TEST_CONTEXT) && fetchImpl === globalThis.fetch;
  let state = { at: 0, updated: null, byKey: new Map() };
  let loading = null;

  function refresh() {
    if (disabled) return Promise.resolve();
    if (!loading) {
      loading = (async () => {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new Error(`nohumans delivery HTTP ${res.status}`);
        const data = await res.json();
        const byKey = new Map(Object.entries(data?.endpoints || {}).filter(([, v]) => Array.isArray(v) && /^\d{4}-\d{2}-\d{2}$/.test(v[0])));
        state = { at: now(), updated: data?.updated ?? null, byKey };
      })()
        .catch((err) => { state = { ...state, at: now() - TTL_MS + RETRY_MS }; console.error('[nohumans-delivery] refresh failed:', err.message); })
        .finally(() => { loading = null; });
    }
    return loading;
  }

  async function fresh(waitMs) {
    if (!state.at || now() - state.at > TTL_MS) {
      const pending = refresh();
      if (!state.byKey.size && waitMs > 0) await Promise.race([pending, new Promise((r) => setTimeout(r, waitMs))]);
    }
  }

  return {
    refresh,
    // { paid_on, status, listing } for this endpoint, or null when the directory has no such purchase.
    async forUrl(targetUrl, { waitMs = 0 } = {}) {
      await fresh(waitMs);
      let key;
      try { key = keyOf(targetUrl); } catch { return null; }
      const hit = state.byKey.get(key);
      if (!hit) return null;
      const [paidOn, status, id] = hit;
      return { source: 'nohumans.directory', paid_on: paidOn, status: status || null, listing: id ? `https://nohumans.directory/l/${encodeURIComponent(id)}` : null, license: 'CC BY 4.0' };
    },
  };
}

module.exports = { createNohumansDelivery, DELIVERY_URL };
