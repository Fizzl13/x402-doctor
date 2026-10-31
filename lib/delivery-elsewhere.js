// Delivery evidence from others who buy x402 endpoints with real USDC, written daily by the trust scan's plan job to
// the trust-data branch as { endpoints: { key: [day of that purchase, the listing's status, a link] } }:
// - delivery-nohumans.json: the endpoints nohumans.directory bought and got an answer from (paid_verified in its
//   CC BY 4.0 catalogue); the link is its listing id.
// - delivery-payapi.json: the routes PayAPI Market paid once from its own wallet and got real product from
//   (settlement-verified); the link is the listing page on payapi.market.
// - OpenClaw delivery grades (OpenClawProductions, who pay x402 endpoints and grade what comes back), read straight
//   from their feed once OPENCLAW_GRADES_URL is set: { grades: [{ url, date, delivered, reason?, report?, tx? }] }.
//   Unlike the two above it also has failed purchases (paid, and no usable answer).
// The preflight shows it as information next to its own check: the scan sees whether an agent can pay, this shows
// that someone paid and whether an answer came. Each file is loaded on first use and refreshed every 6 hours.

const { keyOf } = require('./bazaar-index');

const DATA = 'https://raw.githubusercontent.com/Fizzl13/x402-doctor/trust-data/';
const SOURCES = [
  { name: 'nohumans.directory', url: process.env.NOHUMANS_DELIVERY_URL || `${DATA}delivery-nohumans.json`, license: 'CC BY 4.0', listing: (id) => (id ? `https://nohumans.directory/l/${encodeURIComponent(id)}` : null) },
  { name: 'PayAPI Market', url: process.env.PAYAPI_DELIVERY_URL || `${DATA}delivery-payapi.json`, listing: (link) => (/^https:\/\/payapi\.market\//.test(link || '') ? link : null) },
  ...(process.env.OPENCLAW_GRADES_URL ? [openClawSource(process.env.OPENCLAW_GRADES_URL)] : []),
];

// OpenClaw's feed: per endpoint its latest graded purchase, as [day, 'delivered' or 'failed', report link, reason].
function openClawSource(url) {
  return {
    name: 'OpenClaw',
    url,
    listing: (link) => (/^https:\/\//.test(link || '') ? link : null),
    parse(data) {
      const out = new Map();
      for (const g of Array.isArray(data?.grades) ? data.grades.slice(0, 50000) : []) {
        const day = String(g?.date || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || typeof g.delivered !== 'boolean') continue;
        let key;
        try { key = keyOf(String(g.url)); } catch { continue; }
        const prev = out.get(key);
        if (prev && prev[0] > day) continue;
        const reason = typeof g.reason === 'string' ? g.reason.replace(/\s+/g, ' ').trim().slice(0, 160) : null;
        out.set(key, [day, g.delivered ? 'delivered' : 'failed', typeof g.report === 'string' ? g.report : null, reason]);
      }
      return out;
    },
  };
}
const TTL_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000; // after a failed load

// One source's file, by key.
function sourceReader(source, { fetchImpl, now, disabled }) {
  let state = { at: 0, byKey: new Map() };
  let loading = null;

  function refresh() {
    if (disabled) return Promise.resolve();
    if (!loading) {
      loading = (async () => {
        const res = await fetchImpl(source.url, { signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new Error(`${source.name} delivery HTTP ${res.status}`);
        const data = await res.json();
        const byKey = source.parse ? source.parse(data) : new Map(Object.entries(data?.endpoints || {}).filter(([, v]) => Array.isArray(v) && /^\d{4}-\d{2}-\d{2}$/.test(v[0])));
        state = { at: now(), byKey };
      })()
        .catch((err) => { state = { ...state, at: now() - TTL_MS + RETRY_MS }; console.error('[delivery-elsewhere] refresh failed:', err.message); })
        .finally(() => { loading = null; });
    }
    return loading;
  }

  return {
    refresh,
    async get(key, waitMs) {
      if (!state.at || now() - state.at > TTL_MS) {
        const pending = refresh();
        if (!state.byKey.size && waitMs > 0) await Promise.race([pending, new Promise((r) => setTimeout(r, waitMs))]);
      }
      const hit = state.byKey.get(key);
      if (!hit) return null;
      const [paidOn, status, link, reason] = hit;
      return { source: source.name, paid_on: paidOn, status: status || null, listing: source.listing(link), ...(reason ? { reason } : {}), ...(source.license ? { license: source.license } : {}) };
    },
  };
}

function createDeliveryElsewhere({ sources = SOURCES, fetchImpl = fetch, now = Date.now } = {}) {
  // Tests never download the real files unless they pass their own fetch.
  const disabled = Boolean(process.env.NODE_TEST_CONTEXT) && fetchImpl === globalThis.fetch;
  const readers = sources.map((s) => sourceReader(s, { fetchImpl, now, disabled }));
  return {
    refresh: () => Promise.all(readers.map((r) => r.refresh())),
    // The latest purchase of this endpoint ({ source, paid_on, status, listing }) with every source's in `sources`,
    // or null when nobody we read bought it.
    async forUrl(targetUrl, { waitMs = 0 } = {}) {
      let key;
      try { key = keyOf(targetUrl); } catch { return null; }
      const hits = (await Promise.all(readers.map((r) => r.get(key, waitMs).catch(() => null)))).filter(Boolean);
      if (!hits.length) return null;
      hits.sort((a, b) => (a.paid_on < b.paid_on ? 1 : a.paid_on > b.paid_on ? -1 : 0));
      return { ...hits[0], sources: hits };
    },
  };
}

module.exports = { createDeliveryElsewhere, openClawSource, SOURCES };
