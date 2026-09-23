// In-memory index of the CDP Bazaar (Coinbase's x402 discovery catalog), used
// as a seller reputation signal by the pre-payment check. Loaded lazily on
// first use and refreshed at most every 6 hours; a lookup never waits for a
// refresh longer than the caller allows, and "unknown" is a valid answer.

const DISCOVERY_URL = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources';
const PAGE_SIZE = 500;
const MAX_PAGES = 100;
const TTL_MS = 6 * 60 * 60 * 1000;

// Listings are keyed by origin + path (no query), so /signal/BTC-USDT and
// /signal/ETH-USDT both count for the origin, and a query never matters.
const keyOf = (url) => {
  const u = new URL(url);
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
};

function createBazaarIndex({ url = process.env.CDP_DISCOVERY_URL || DISCOVERY_URL, fetchImpl = fetch } = {}) {
  let state = { at: 0, resources: null, origins: null };
  let loading = null;

  async function load() {
    const resources = new Set();
    const origins = new Set();
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await fetchImpl(`${url}?type=http&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`CDP discovery HTTP ${res.status}`);
      const items = (await res.json()).items || [];
      for (const item of items) {
        try {
          resources.add(keyOf(item.resource));
          origins.add(new URL(item.resource).origin);
        } catch {
          // skip malformed entries
        }
      }
      if (items.length < PAGE_SIZE) break;
    }
    state = { at: Date.now(), resources, origins };
  }

  function refresh() {
    if (!loading) {
      loading = load()
        .catch((err) => console.error('[bazaar-index] refresh failed:', err.message))
        .finally(() => {
          loading = null;
        });
    }
    return loading;
  }

  // { resource: bool, origin: bool } or null when the index is not available
  // within waitMs.
  async function lookup(targetUrl, { waitMs = 0 } = {}) {
    if (!state.resources || Date.now() - state.at > TTL_MS) {
      const pending = refresh();
      if (!state.resources && waitMs > 0) await Promise.race([pending, new Promise((r) => setTimeout(r, waitMs))]);
    }
    if (!state.resources) return null;
    return { resource: state.resources.has(keyOf(targetUrl)), origin: state.origins.has(new URL(targetUrl).origin) };
  }

  return { lookup, refresh, size: () => state.resources?.size ?? 0 };
}

module.exports = { createBazaarIndex, keyOf };
