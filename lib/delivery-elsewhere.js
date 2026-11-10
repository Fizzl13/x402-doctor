// Delivery evidence from others who buy x402 endpoints with real USDC, written daily by the trust scan's plan job to
// the trust-data branch as { endpoints: { key: [day of that purchase, the listing's status, a link] } }:
// - delivery-nohumans.json: the endpoints nohumans.directory bought and got an answer from (paid_verified in its
//   CC BY 4.0 catalogue); the link is its listing id.
// - delivery-payapi.json: the routes PayAPI Market paid once from its own wallet and got real product from
//   (settlement-verified); the link is the listing page on payapi.market.
// - OpenClaw delivery grades (OpenClawProductions, who pay x402 endpoints and grade what comes back), read straight
//   from their feed once OPENCLAW_GRADES_URL is set (openclawproductions.com/api/v1/graded: { rows: [{ url, host,
//   date, tx_hash, delivered, reason }] }; grades[] with report links is read too). Unlike the two above it also has
//   failed purchases (paid, and no usable answer): a failed row counts only with a tx hash, the proof it was paid
//   (their "skipped" rows, which their wallet could not sign, have none). A "masked" reason is left out.
// - ARP's x402 outcomes feed (Maxime Saint-Joannis, intuition-box/ARP, schema arp.x402-outcomes/2): payers' own
//   public lines about a paid call ("worked", or "failed" with a reason such as no-delivery), each tied to a
//   settlement tx ARP checked on chain when it built the file (the payer is read from the token's Transfer log). It
//   proves the payment and who made it, not what the endpoint delivered: the outcome is the payer's word, so the line
//   says how many different wallets said it. Read by default (ARP_OUTCOMES_URL to point elsewhere, "off" to stop).
// The preflight shows it as information next to its own check: the scan sees whether an agent can pay, this shows
// that someone paid and whether an answer came. Each file is loaded on first use and refreshed every 6 hours.

const { keyOf } = require('./bazaar-index');

const DATA = 'https://raw.githubusercontent.com/Fizzl13/x402-doctor/trust-data/';
const ARP_FEED = 'https://raw.githubusercontent.com/intuition-box/ARP/main/apps/web/public/feeds/x402-outcomes.json';
const TX = /^0x[0-9a-fA-F]{64}$/;
const EXPLORERS = { 'eip155:8453': 'https://basescan.org/tx/' };
const ARP_REASONS = { 'no-delivery': 'paid, got nothing back' };
const SOURCES = [
  { name: 'nohumans.directory', url: process.env.NOHUMANS_DELIVERY_URL || `${DATA}delivery-nohumans.json`, license: 'CC BY 4.0', listing: (id) => (id ? `https://nohumans.directory/l/${encodeURIComponent(id)}` : null) },
  { name: 'PayAPI Market', url: process.env.PAYAPI_DELIVERY_URL || `${DATA}delivery-payapi.json`, listing: (link) => (/^https:\/\/payapi\.market\//.test(link || '') ? link : null) },
  ...(process.env.OPENCLAW_GRADES_URL ? [openClawSource(process.env.OPENCLAW_GRADES_URL)] : []),
  ...(process.env.ARP_OUTCOMES_URL === 'off' ? [] : [arpSource(process.env.ARP_OUTCOMES_URL || ARP_FEED)]),
];

// ARP's feed: per endpoint its latest recorded outcome, as [day, 'delivered' or 'failed', explorer link, what was
// said and by how many wallets]. Only records with a settlement tx count; a record's endpoint is matched without its
// query (keyOf), so a query value from the payer's call never becomes a key here.
function arpSource(url) {
  return {
    name: 'ARP',
    url,
    listing: (link) => (/^https:\/\/basescan\.org\/tx\/0x[0-9a-fA-F]{64}$/.test(link || '') ? link : null),
    parse(data) {
      const byKey = new Map();
      const records = Array.isArray(data?.records) ? data.records : [];
      for (const r of records.slice(0, 50000)) {
        const outcome = r?.outcome === 'worked' ? 'delivered' : r?.outcome === 'failed' ? 'failed' : null;
        const day = String(r?.paid_at || '').slice(0, 10);
        if (!outcome || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !TX.test(String(r.settlement_tx || ''))) continue;
        let key;
        try { key = keyOf(String(r.endpoint_canonical || r.endpoint)); } catch { continue; }
        const e = byKey.get(key) || { latest: null, payers: { delivered: new Set(), failed: new Set() } };
        if (r.payer) e.payers[outcome].add(String(r.payer).toLowerCase());
        if (!e.latest || e.latest.day <= day) e.latest = { day, outcome, reason: r.reason, tx: r.settlement_tx, network: r.network };
        byKey.set(key, e);
      }
      const out = new Map();
      for (const [key, { latest, payers }] of byKey) {
        const n = payers[latest.outcome].size || 1;
        const said = latest.outcome === 'failed' ? ARP_REASONS[latest.reason] || String(latest.reason || 'failed').replace(/[^a-z0-9 -]/gi, '').replace(/-/g, ' ').slice(0, 60) : null;
        const who = `the payer's word, ${n} wallet${n === 1 ? '' : 's'}`;
        const explorer = EXPLORERS[latest.network];
        out.set(key, [latest.day, latest.outcome, explorer ? `${explorer}${latest.tx}` : null, said ? `${said}; ${who}` : who]);
      }
      return out;
    },
  };
}

// OpenClaw's feed: per endpoint its latest graded purchase, as [day, 'delivered' or 'failed', report link, reason].
function openClawSource(url) {
  return {
    name: 'OpenClaw',
    url,
    listing: (link) => (/^https:\/\//.test(link || '') ? link : null),
    parse(data) {
      const out = new Map();
      const rows = Array.isArray(data?.grades) ? data.grades : Array.isArray(data?.rows) ? data.rows : [];
      for (const g of rows.slice(0, 50000)) {
        const day = String(g?.date || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || typeof g.delivered !== 'boolean') continue;
        // A failed row is a purchase only with its proof of payment.
        if (!g.delivered && !(g.tx_hash || g.tx || g.report)) continue;
        let key;
        try { key = keyOf(String(g.url)); } catch { continue; }
        const prev = out.get(key);
        if (prev && prev[0] > day) continue;
        // "n: paid hello endpoint returns only {status: ok}" -> "paid hello endpoint …"; "masked" says nothing.
        let reason = typeof g.reason === 'string' ? g.reason.replace(/\s+/g, ' ').trim().replace(/^[yn]\s*(\([^)]*\))?\s*:\s*/i, '') : '';
        if (/^masked$/i.test(reason)) reason = '';
        out.set(key, [day, g.delivered ? 'delivered' : 'failed', typeof g.report === 'string' ? g.report : null, reason.slice(0, 160) || null]);
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

module.exports = { createDeliveryElsewhere, openClawSource, arpSource, SOURCES };
