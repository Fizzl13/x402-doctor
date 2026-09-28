// In-memory index of the CDP Bazaar (Coinbase's x402 discovery catalog), used
// as a seller reputation signal by the pre-payment check, and by the diagnosis
// to see under which origin a route is listed (listings). Loaded lazily on
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

// "/signal/:pair" and "/signal/{pair}" match any one segment ("/signal/BTC-USDT").
const segments = (path) => path.replace(/\/+$/, '').split('/');
const isParam = (segment) => /^:\w+$|^\{[^}]*\}$/.test(segment);
function pathMatches(listed, actual) {
  const a = segments(listed);
  const b = segments(actual);
  return a.length === b.length && a.every((seg, i) => seg === b[i] || isParam(seg) || isParam(b[i]));
}

function createBazaarIndex({ url = process.env.CDP_DISCOVERY_URL || DISCOVERY_URL, fetchImpl = fetch } = {}) {
  let state = { at: 0, resources: null, origins: null, byPayTo: null };
  let loading = null;

  async function load() {
    const resources = new Set();
    const origins = new Set();
    const byPayTo = new Map(); // payTo (lowercase) -> [{ origin, path }]
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await fetchImpl(`${url}?type=http&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`CDP discovery HTTP ${res.status}`);
      const items = (await res.json()).items || [];
      for (const item of items) {
        try {
          resources.add(keyOf(item.resource));
          const u = new URL(item.resource);
          origins.add(u.origin);
          for (const payTo of new Set((item.accepts || []).map((a) => String(a?.payTo || '').toLowerCase()).filter(Boolean))) {
            if (!byPayTo.has(payTo)) byPayTo.set(payTo, []);
            byPayTo.get(payTo).push({ origin: u.origin, path: u.pathname });
          }
        } catch {
          // skip malformed entries
        }
      }
      if (items.length < PAGE_SIZE) break;
    }
    state = { at: Date.now(), resources, origins, byPayTo };
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

  // Where the Bazaar lists this route, among the listings paid to the same
  // wallet: { here, elsewhere: [origin] }, or null when the index is not
  // available within waitMs. After a domain move the route is often listed
  // only under the old host, because the Bazaar keeps the URL the payer used.
  async function listings(targetUrl, payTos, { waitMs = 0 } = {}) {
    if (!state.byPayTo || Date.now() - state.at > TTL_MS) {
      const pending = refresh();
      if (!state.byPayTo && waitMs > 0) await Promise.race([pending, new Promise((r) => setTimeout(r, waitMs))]);
    }
    if (!state.byPayTo) return null;
    const target = new URL(targetUrl);
    let here = false;
    const elsewhere = new Set();
    for (const payTo of new Set((payTos || []).map((p) => String(p).toLowerCase()))) {
      for (const entry of state.byPayTo.get(payTo) || []) {
        if (!pathMatches(entry.path, target.pathname)) continue;
        if (entry.origin === target.origin) here = true;
        else elsewhere.add(entry.origin);
      }
    }
    return { here, elsewhere: [...elsewhere].sort() };
  }

  return { lookup, listings, refresh, size: () => state.resources?.size ?? 0 };
}

module.exports = { createBazaarIndex, keyOf, pathMatches };
