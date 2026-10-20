// The Trust Index for the Doctor, read from the small files the daily scan precomputes (lib/trust-views.js) instead
// of loading the whole index: one key bucket per lookup (at most 32 kept, each checked again after 30 minutes), the
// summary, atlas, path templates and seller totals as they were built, a network view or a few pages of the price
// check's word index only when asked for. Same API and answers as lib/trust-index.js, a fraction of the memory. Until
// the scan has published the views (views/meta.json 404), it uses the full index, as before.

'use strict';

const { createTrustIndex, lookupIn, submittedLookup, submittedKeysOf, wordsOf, TTL_MS } = require('./trust-index');
const { bucketOf, fileOfNetwork } = require('./trust-views');
const { keyOf } = require('./bazaar-index');
const { siteOf } = require('./site');

const BASE = 'https://raw.githubusercontent.com/Fizzl13/x402-doctor/trust-data/';
const MAX_BUCKETS = 32;
// A network view larger than this (Base: ~11 MB) is not kept after answering.
const KEEP_NETWORK_CHARS = 2_000_000;
const MAX_SIMILAR_FILES = 64;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createTrustReader({ base = process.env.TRUST_DATA_URL || BASE, fetchImpl = fetch, createFull = () => createTrustIndex({ fetchImpl }), maxBuckets = MAX_BUCKETS } = {}) {
  let state = { at: 0, meta: null };
  let loading = null;
  let metaEtag = null;
  let full = null; // the full index, only while the views are not published
  let scan = null; // what belongs to one scan: { atlasText, templates, sellers, submitted }
  const buckets = new Map(); // bucket -> { at, etag, resources }, least recently used first
  const fetching = new Map(); // bucket -> pending fetch
  const networks = new Map(); // key -> view (small ones)
  const similarCache = new Map(); // path -> parsed file (word buckets, entry pages, meta)

  const get = (path, headers = {}) => fetchImpl(base + path, { headers, signal: AbortSignal.timeout(30000) });
  const getJson = async (path) => {
    const res = await get(path);
    if (!res.ok) throw new Error(`${path} HTTP ${res.status}`);
    return res.json();
  };
  const stale = () => Date.now() - state.at > TTL_MS;

  function refresh() {
    if (!loading) {
      loading = (async () => {
        // Without the scan's files (a failed download) the meta is asked again in full, so they are too.
        const res = await get('views/meta.json', metaEtag && state.meta && scan ? { 'if-none-match': metaEtag } : {});
        if (res.status === 304) { state.at = Date.now(); return; }
        if (res.status === 404) {
          if (!full) full = createFull();
          state = { at: Date.now(), meta: null };
          await full.refresh();
          return;
        }
        if (!res.ok) throw new Error(`trust views HTTP ${res.status}`);
        const meta = await res.json();
        metaEtag = res.headers?.get?.('etag') || null;
        if (meta.updated !== state.meta?.updated || !scan) {
          // A new scan: everything cached belongs to the old one.
          buckets.clear();
          networks.clear();
          similarCache.clear();
          const [atlasText, templates, sellers, submitted] = await Promise.all([
            get('views/atlas.json').then((a) => (a.ok ? a.text() : null)).catch(() => null),
            getJson('views/templates.json').then((t) => new Map(Object.entries(t))).catch(() => null),
            getJson('views/sellers.json').catch(() => null),
            getJson('submitted.json').then((j) => (j && j.resources ? j : null)).catch(() => null),
          ]);
          scan = atlasText && templates && sellers ? { atlasText, templates, sellers, submitted } : null;
          if (!scan) metaEtag = null;
        }
        full = null;
        state = { at: Date.now(), meta };
      })()
        .catch((err) => console.error('[trust-reader] refresh failed:', err.message))
        .finally(() => {
          loading = null;
        });
    }
    return loading;
  }

  // Loaded (views or the full index) and fresh, waiting up to waitMs for a first load.
  async function ready(waitMs) {
    if ((!state.meta && !full) || stale()) {
      const pending = refresh();
      if (!state.meta && !full && waitMs > 0) await Promise.race([pending, sleep(waitMs)]);
    }
    return Boolean(full || (state.meta && scan));
  }

  function bucketFor(key) {
    const b = bucketOf(key);
    const have = buckets.get(b);
    if (have && Date.now() - have.at < TTL_MS) {
      buckets.delete(b);
      buckets.set(b, have);
      return Promise.resolve(have);
    }
    if (!fetching.has(b)) {
      fetching.set(b, (async () => {
        const res = await get(`keys/${b}.json`, have?.etag ? { 'if-none-match': have.etag } : {});
        let entry;
        if (res.status === 304 && have) entry = { ...have, at: Date.now() };
        else if (res.ok) entry = { at: Date.now(), etag: res.headers?.get?.('etag') || null, resources: (await res.json()).resources || {} };
        else throw new Error(`trust bucket ${b} HTTP ${res.status}`);
        buckets.delete(b);
        buckets.set(b, entry);
        while (buckets.size > maxBuckets) buckets.delete(buckets.keys().next().value);
        return entry;
      })().finally(() => fetching.delete(b)));
    }
    return fetching.get(b);
  }
  // A bucket within a time limit; null when it doesn't come (the record is then unknown, as while an index loads).
  const bucketWithin = (key, ms) => Promise.race([bucketFor(key).catch(() => null), sleep(ms).then(() => null)]);

  async function lookup(targetUrl, { waitMs = 0 } = {}) {
    const ok = await ready(waitMs);
    if (full) return full.lookup(targetUrl, { waitMs });
    if (!ok) return null;
    let key;
    try { key = keyOf(targetUrl); } catch { return null; }
    const b = await bucketWithin(key, Math.max(waitMs, 5000));
    // The bucket holds the exact key if it is listed; a path template comes from templates.json.
    const index = { resources: b ? b.resources : {}, days: state.meta.days, updated: state.meta.updated };
    return lookupIn(index, scan.templates, targetUrl) ?? submittedLookup(scan.submitted, targetUrl);
  }

  async function seller(targetUrl, { waitMs = 0 } = {}) {
    const ok = await ready(waitMs);
    if (full) return full.seller(targetUrl, { waitMs });
    if (!ok) return null;
    const origin = new URL(targetUrl).origin;
    return scan.sellers[origin] ?? { origin, resources: 0 };
  }

  function summary() {
    if (full) return full.summary();
    if (stale()) refresh();
    return state.meta && scan ? state.meta.summary : null;
  }

  const updated = () => (full ? full.updated() : state.meta?.updated ?? null);

  // Built fresh per call, like the full index's atlas(): the server adds its own fields to it.
  function atlas() {
    if (full) return full.atlas();
    if (stale()) refresh();
    return scan ? JSON.parse(scan.atlasText) : null;
  }

  function emptyNetwork(network) {
    return { network, updated: state.meta.updated, days: state.meta.days, endpoints: 0, payable_now: 0, services: 0, categories: [], sellers: [], resources: [] };
  }

  async function byNetwork(network, { waitMs = 0 } = {}) {
    const ok = await ready(waitMs);
    if (full) return full.byNetwork(network, { waitMs });
    if (!ok) return null;
    if (!(state.meta.networks || []).includes(network)) return emptyNetwork(network);
    if (networks.has(network)) return networks.get(network);
    const res = await get(`views/networks/${fileOfNetwork(network)}.json`);
    if (!res.ok) return null;
    const text = await res.text();
    const view = JSON.parse(text);
    if (text.length < KEEP_NETWORK_CHARS) networks.set(network, view);
    return view;
  }

  // The file of a network view, for passing straight to a client without parsing it (GET /api/trust/network). Null
  // when the views aren't there (then byNetwork() answers); { empty } for a key without endpoints.
  async function openNetwork(network) {
    const ok = await ready(8000);
    if (full || !ok) return null;
    if (!(state.meta.networks || []).includes(network)) return { empty: emptyNetwork(network) };
    const res = await get(`views/networks/${fileOfNetwork(network)}.json`);
    return res.ok ? { res } : null;
  }

  async function similarFile(path) {
    if (similarCache.has(path)) return similarCache.get(path);
    const data = await getJson(path);
    similarCache.set(path, data);
    while (similarCache.size > MAX_SIMILAR_FILES) similarCache.delete(similarCache.keys().next().value);
    return data;
  }

  // The same ranking as lib/trust-index.js similarIn(), from the word files: scores in the order the words and their
  // hits come, a stable sort, at most perSite per seller; then only the pages of the entries it returns.
  async function similar(targetUrl, description, { limit = 24, perSite = 2, waitMs = 0 } = {}) {
    const ok = await ready(waitMs);
    if (full) return full.similar(targetUrl, description, { limit, perSite, waitMs });
    if (!ok) return [];
    const words = wordsOf(description);
    if (words.size === 0) return [];
    try {
      const meta = await similarFile('views/similar/meta.json');
      const files = new Map();
      await Promise.all([...new Set([...words].map(bucketOf))].map(async (b) => files.set(b, await similarFile(`views/similar/words/${b}.json`))));
      let ownSite = null;
      try { ownSite = siteOf(new URL(targetUrl).hostname); } catch {}
      const scores = new Map();
      const info = new Map();
      for (const w of words) {
        const hits = files.get(bucketOf(w))?.[w];
        if (!hits || hits.length > meta.n / 4) continue; // too common to tell services apart
        const idf = Math.log(meta.n / hits.length);
        for (const [i, count, site] of hits) {
          scores.set(i, (scores.get(i) || 0) + idf);
          info.set(i, [count, meta.sites[site]]);
        }
      }
      const ranked = [...scores.entries()]
        .map(([i, sc]) => ({ i, s: sc / Math.sqrt(info.get(i)[0]), site: info.get(i)[1] }))
        .filter((r) => r.site !== ownSite)
        .sort((a, b) => b.s - a.s);
      const picked = [];
      const perSeller = new Map();
      for (const r of ranked) {
        const n = perSeller.get(r.site) || 0;
        if (n >= perSite) continue;
        perSeller.set(r.site, n + 1);
        picked.push(r.i);
        if (picked.length >= limit) break;
      }
      const pages = new Map();
      await Promise.all([...new Set(picked.map((i) => Math.floor(i / meta.page)))].map(async (p) => pages.set(p, await similarFile(`views/similar/entries/${p}.json`))));
      return picked.map((i) => {
        const [url, host, desc, price] = pages.get(Math.floor(i / meta.page))[i % meta.page];
        return { url, host, description: desc, price_usd: price };
      });
    } catch {
      return [];
    }
  }

  const submittedKeys = (host) => (full ? full.submittedKeys(host) : submittedKeysOf(scan?.submitted, host));

  return { lookup, submittedKeys, seller, refresh, summary, byNetwork, openNetwork, similar, atlas, updated, kept: () => buckets.size };
}

module.exports = { createTrustReader };
