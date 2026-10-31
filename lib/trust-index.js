// Reads the published x402 Trust Index (index/ on the trust-data branch,
// written daily by scripts/trust-scan.js) and answers track-record lookups.
// Loaded at startup and checked again every 30 minutes; "unknown" (null) is a valid
// answer while it loads or when a URL was never scanned.

const { keyOf, pathMatches } = require('./bazaar-index');
const { trackRecord } = require('./trust-scan');
const { siteOf } = require('./site');
const { eachLine, readIndexParts } = require('./index-files');

// A seller with at least this share of the latest scan (and this many endpoints) is counted apart in summary().
const LARGEST_HOST_SHARE = 0.2;
const LARGEST_HOST_MIN = 1000;
const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};
const { wordsOf, groupServices, categoryOf, guessCategory, descKey, CATEGORIES, CATEGORY_IDS } = require('./services');

// The index in parts (lib/index-files.js: index/meta.json, then one [key, resource] per line in each part), read line
// by line, so it is never one string in memory: on 20 Oct 2026's index (69,302 resources) reading it by line peaked at
// 134 MB instead of 226 MB, and 57 MB stayed in use instead of 122 MB. index.ndjson (the same lines in one file) and
// then index.json are the fallbacks while the branch has no parts, or after the single files grew too large to publish.
const PARTS_URL = 'https://raw.githubusercontent.com/Fizzl13/x402-doctor/trust-data/index/meta.json';
const INDEX_URL = 'https://raw.githubusercontent.com/Fizzl13/x402-doctor/trust-data/index.ndjson';
const INDEX_JSON_URL = 'https://raw.githubusercontent.com/Fizzl13/x402-doctor/trust-data/index.json';
const FALLBACK_MS = 6 * 60 * 60 * 1000;
// Jev's category per service description (scripts/categorize.js); optional: without it the keyword guess is used.
const CATEGORIES_URL = 'https://raw.githubusercontent.com/Fizzl13/x402-doctor/trust-data/categories.json';
// Endpoints their sellers added themselves (lib/trust-submissions.js), scanned the same way but kept apart: lookups
// find them, the counts, pages and datasets don't include them.
const SUBMITTED_URL = 'https://raw.githubusercontent.com/Fizzl13/x402-doctor/trust-data/submitted.json';
// The scan publishes once a day at a time GitHub chooses (on 17 Oct 2026 at 13:30 UTC, 3 minutes after a restart,
// so a 6-hour refresh showed the day before until the evening). A check costs one conditional request: unchanged,
// GitHub answers 304 and nothing is downloaded or parsed.
const TTL_MS = 30 * 60 * 1000;
const ATLAS_NETWORKS = ['eip155', 'solana', 'xrpl', 'algorand', 'tempo', 'stellar', 'aptos', 'sui', 'near'];
// What GET /api/trust/network accepts (lowercased): a family or an id.
const NETWORK_RE = /^[a-z0-9-]{2,32}(:[a-z0-9-]{1,64})?$/i;

// An index response, read line by line: a header line, then one [key, resource] line per resource. A whole index on
// one line (index.json, or a test's JSON) is returned as it is. Without a readable body: res.json().
async function readIndex(res) {
  if (!res.body || typeof res.body.getReader !== 'function') return res.json();
  const resources = {};
  let head = null;
  await eachLine(res, (line) => {
    if (!line.trim()) return;
    const value = JSON.parse(line);
    if (head === null) head = value;
    else resources[value[0]] = value[1];
  });
  if (!head) throw new Error('empty trust index');
  return head.resources ? head : { ...head, resources };
}

function createTrustIndex({ url = process.env.TRUST_INDEX_URL || PARTS_URL, categoriesUrl = process.env.TRUST_CATEGORIES_URL || CATEGORIES_URL, submittedUrl = process.env.TRUST_SUBMITTED_URL || SUBMITTED_URL, fetchImpl = fetch } = {}) {
  let state = { at: 0, index: null };
  let loading = null;
  let etag = null;
  // Where the published index is read, in order (for the default url only): a 404 moves on to the next source for the
  // next 6 hours, with its own ETag, then the parts are tried again.
  const sources = url === PARTS_URL ? [PARTS_URL, INDEX_URL, INDEX_JSON_URL] : [url];
  let source = 0;
  let fallbackUntil = 0;

  function refresh() {
    if (!loading) {
      loading = (async () => {
        if (source > 0 && Date.now() >= fallbackUntil) { source = 0; etag = null; }
        // The index changes once a day (the scan), the check runs every 30 minutes: unchanged, GitHub answers 304.
        const headers = etag && state.index ? { 'if-none-match': etag } : {};
        let res = await fetchImpl(sources[source], { headers, signal: AbortSignal.timeout(30000) });
        while (res.status === 404 && source < sources.length - 1) {
          source++;
          fallbackUntil = Date.now() + FALLBACK_MS;
          etag = null;
          res = await fetchImpl(sources[source], { signal: AbortSignal.timeout(30000) });
        }
        if (res.status === 304) { state.at = Date.now(); return; }
        if (!res.ok) throw new Error(`trust index HTTP ${res.status}`);
        // ~40 MB of JSON, ~120 MB once parsed and grouped: drop the old index before parsing the new one, so the two
        // never sit in memory together (that peak crashed the 512 MB instance on 13 Oct 2026, exit 134). Lookups
        // answer "unknown" for the few seconds this takes, as they do at startup.
        state = { at: state.at, index: null };
        let index;
        if (sources[source] === PARTS_URL) {
          // meta.json lists the parts; a whole index served there (a test's fetch) is taken as it is.
          const meta = await res.json();
          index = Array.isArray(meta?.parts) ? await readIndexParts(meta, { baseUrl: PARTS_URL, fetchImpl, timeoutMs: 30000 }) : meta;
        } else index = await readIndex(res);
        etag = res.headers?.get?.('etag') || null;
        let categories = {};
        let bait = {};
        try {
          const c = await fetchImpl(categoriesUrl, { signal: AbortSignal.timeout(30000) });
          if (c.ok) { const j = await c.json(); categories = j?.categories || {}; bait = j?.bait || {}; }
        } catch { /* optional */ }
        let submitted = null;
        try {
          const s = await fetchImpl(submittedUrl, { signal: AbortSignal.timeout(30000) });
          if (s.ok) { const j = await s.json(); if (j && j.resources) submitted = j; }
        } catch { /* optional: none until the first scan with submissions */ }
        state = { at: Date.now(), index, categories, bait, submitted };
      })()
        .catch((err) => console.error('[trust-index] refresh failed:', err.message))
        .finally(() => {
          loading = null;
        });
    }
    return loading;
  }

  // The payable resources grouped into services (lib/services.js), each with its category; built once per load.
  function servicesView() {
    if (!state.services) {
      const grouped = groupServices(state.index.resources);
      for (const s of grouped.services) {
        s.category = categoryOf(s, state.categories);
        s.bait = baitOf(s, state.bait);
      }
      state.services = grouped;
    }
    return state.services;
  }
  const categoryCounts = (services) => {
    const n = {};
    for (const s of services) n[s.category] = (n[s.category] || 0) + 1;
    return CATEGORIES.filter((c) => n[c.id]).map((c) => ({ id: c.id, name: c.name, services: n[c.id] })).sort((a, b) => b.services - a.services);
  };

  // Track record for a URL, or null when unknown.
  async function lookup(targetUrl, { waitMs = 0 } = {}) {
    if (!state.index || Date.now() - state.at > TTL_MS) {
      const pending = refresh();
      if (!state.index && waitMs > 0) await Promise.race([pending, new Promise((r) => setTimeout(r, waitMs))]);
    }
    if (!state.index) return submittedLookup(state.submitted, targetUrl);
    if (!state.templates) state.templates = templatesOf(state.index.resources);
    return lookupIn(state.index, state.templates, targetUrl) ?? submittedLookup(state.submitted, targetUrl);
  }

  // The keys of one host's added endpoints, for the cap per host.
  const submittedKeys = (host) => submittedKeysOf(state.submitted, host);

  // The seller's other scanned resources on the same origin: how many, how
  // many are payable today and how reliable they were. Null when unknown.
  async function seller(targetUrl, { waitMs = 0 } = {}) {
    if (!state.index || Date.now() - state.at > TTL_MS) {
      const pending = refresh();
      if (!state.index && waitMs > 0) await Promise.race([pending, new Promise((r) => setTimeout(r, waitMs))]);
    }
    if (!state.index) return null;
    return sellerIn(state.index.resources, new URL(targetUrl).origin);
  }

  // Totals for the /trust page: the latest scan, why payments would fail in
  // it (a resource can have several reasons), and one row per scanned day.
  function summary() {
    if (!state.index) return null;
    const { days, resources } = state.index;
    const counts = { g: 0, c: 0, n: 0, x: 0 };
    const byProtocol = { x402: { resources: 0, g: 0, c: 0, n: 0, x: 0 }, mpp: { resources: 0, g: 0, c: 0, n: 0, x: 0 } };
    const reasons = {};
    const networks = {};
    const perDay = days.map(() => ({ g: 0, c: 0, n: 0, x: 0 }));
    const byOrigin = new Map();
    for (const r of Object.values(resources)) {
      const last = r.h.slice(-1);
      const proto = byProtocol[r.p === 'mpp' ? 'mpp' : 'x402'];
      // Judged in the latest scan only ('-' = not seen, rate limited, or an MPP endpoint that needs input).
      if (last in counts) { proto.resources++; proto[last]++; }
      if (last in counts) {
        counts[last]++;
        for (const code of (r.last && r.last.codes) || []) reasons[code] = (reasons[code] || 0) + 1;
        const origin = originOf(r.url);
        if (origin) {
          const o = byOrigin.get(origin) || byOrigin.set(origin, { g: 0, c: 0, n: 0, x: 0 }).get(origin);
          o[last]++;
        }
      }
      if ((last === 'g' || last === 'c') && ['go', 'caution'].includes(r.last?.verdict)) for (const n of r.last.networks || []) if (typeof n === 'string') networks[n] = (networks[n] || 0) + 1;
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
      // Endpoints payable in the latest scan per network (an endpoint often offers several).
      networks: Object.entries(networks).sort((a, b) => b[1] - a[1]).map(([network, endpoints]) => ({ network, endpoints })),
      payto_sanctioned: reasons.payto_sanctioned || 0, // endpoints whose payout address is on the OFAC SDN list
      payto_burn: reasons.payto_burn || 0, // endpoints that pay out to the zero address or another burn address
      sanctions: state.index.sanctions ?? null, // the list the latest scan screened against; null: not screened
      daily: days.map((date, i) => ({ date, go: perDay[i].g, caution: perDay[i].c, no_go: perDay[i].n, unreachable: perDay[i].x })),
      services: servicesSummary(),
      ...largestHost(byOrigin, counts),
    };
  }

  // One seller (a template farm can list tens of thousands of endpoints) with a large share of the latest scan moves
  // the totals by itself, up or down: then its share, whether it could be paid, and the totals without it. Never
  // named, as in the weekly report (lib/weekly-report.js).
  function largestHost(byOrigin, counts) {
    const total = counts.g + counts.c + counts.n + counts.x;
    let top = null;
    let topSize = 0;
    for (const o of byOrigin.values()) {
      const size = o.g + o.c + o.n + o.x;
      if (size > topSize) { top = o; topSize = size; }
    }
    if (!top || topSize < LARGEST_HOST_MIN || topSize < total * LARGEST_HOST_SHARE) return {};
    return {
      largest_host: {
        endpoints: topSize,
        share_pct: Math.round((topSize / total) * 1000) / 10,
        // Down: nine in ten of its endpoints could not be paid in the latest scan.
        down: top.n + top.x >= topSize * 0.9,
        latest_without: { go: counts.g - top.g, caution: counts.c - top.c, no_go: counts.n - top.n, unreachable: counts.x - top.x },
      },
    };
  }

  // How many different services the payable endpoints are, the sellers with the most endpoints per service, and
  // what kind of services they are.
  function servicesSummary() {
    const { services, bySite } = servicesView();
    const sites = Object.entries(bySite);
    return {
      payable_endpoints: sites.reduce((n, [, v]) => n + v.endpoints, 0),
      services: services.length,
      sellers: sites.length,
      largest: sites.sort((a, b) => b[1].endpoints - a[1].endpoints).slice(0, 10).map(([site, v]) => ({ seller: site, endpoints: v.endpoints, services: v.services })),
      categories: categoryCounts(services),
      bait: baitList(services, state.bait),
    };
  }

  // Every x402 resource in the latest scan that offers a network (an id like "xrpl:0", or a family prefix like
  // "xrpl"): payable there today or not (and why), its track record and price, grouped totals per seller. Resources
  // missing from the latest scan are left out: their last verdict may be weeks old.
  async function byNetwork(network, { waitMs = 0 } = {}) {
    if (!state.index || Date.now() - state.at > TTL_MS) {
      const pending = refresh();
      if (!state.index && waitMs > 0) await Promise.race([pending, new Promise((r) => setTimeout(r, waitMs))]);
    }
    if (!state.index) return null;
    const matches = (n) => n === network || String(n).startsWith(`${network}:`);
    const view = servicesView();
    const rows = [];
    const seen = new Map(); // service -> seller, for the services counted on this network
    for (const entry of Object.values(state.index.resources || {})) {
      if (entry.p === 'mpp' || !entry.last || !/[gcnx]$/.test(entry.h || '')) continue;
      const payableOn = (entry.last.networks || []).filter(matches);
      const brokenOn = Object.entries(entry.last.unpayable || {}).filter(([n]) => matches(n));
      if (!payableOn.length && !brokenOn.length) continue;
      const record = trackRecord(entry.h);
      const service = view.byUrl.get(entry.url);
      rows.push({
        url: entry.url,
        category: service ? service.category : guessCategory(entry.d || entry.url),
        same_service_endpoints: service ? service.members.length : 1,
        ...(service?.bait ? { bait: service.bait } : {}),
        host: (() => { try { return new URL(entry.url).hostname; } catch { return null; } })(),
        description: (entry.d || '').slice(0, 140),
        payable: payableOn.length > 0 && ['go', 'caution'].includes(entry.last.verdict),
        verdict: entry.last.verdict,
        problem: payableOn.length ? null : brokenOn[0][1],
        networks: [...payableOn, ...brokenOn.map(([n]) => n)],
        price_usd: entry.last.price_usd ?? null,
        history: entry.h,
        payable_ratio: record?.payable_ratio ?? null,
      });
    }
    const sellers = {};
    for (const r of rows) {
      const site = siteOf(r.host);
      const s = (sellers[site] ||= { host: site, endpoints: 0, payable: 0, services: 0 });
      s.endpoints++;
      if (r.payable) s.payable++;
      const service = view.byUrl.get(r.url);
      if (service && !seen.has(service)) { seen.set(service, site); s.services++; }
    }
    return {
      network,
      updated: state.index.updated,
      days: state.index.days,
      endpoints: rows.length,
      payable_now: rows.filter((r) => r.payable).length,
      services: seen.size,
      categories: categoryCounts([...seen.keys()]),
      sellers: Object.values(sellers).sort((a, b) => b.endpoints - a.endpoints),
      resources: rows.sort((a, b) => Number(b.payable) - Number(a.payable) || String(a.url).localeCompare(String(b.url))),
    };
  }

  // Paid APIs of other sellers whose description shares rare words with `description`, best first: candidates
  // for the price check (lib/jev-price.js), which lets Jev decide which really do the same thing. Only resources
  // payable in the latest scan with a dollar price; at most `perSite` per seller, so one seller's hundreds of
  // near-copies can't fill the list. [] while the index loads or when nothing matches.
  async function similar(targetUrl, description, { limit = 24, perSite = 2, waitMs = 0 } = {}) {
    if (!state.index || Date.now() - state.at > TTL_MS) {
      const pending = refresh();
      if (!state.index && waitMs > 0) await Promise.race([pending, new Promise((r) => setTimeout(r, waitMs))]);
    }
    if (!state.index) return [];
    if (!state.words) state.words = buildWordIndex(wordEntries(state.index.resources));
    return similarIn(state.words, targetUrl, description, { limit, perSite });
  }

  // The resources the price check compares with (payable, priced, described), for a precomputed similar.json.
  const similarEntries = () => (state.index ? wordEntries(state.index.resources) : null);

  // A view built while the full index is loaded (scripts/trust-views.js): the network views it can serve.
  const networkKeys = () => {
    if (!state.index) return [];
    const keys = new Set(ATLAS_NETWORKS);
    for (const r of Object.values(state.index.resources || {})) {
      for (const n of r.last?.networks || []) if (typeof n === 'string') keys.add(n);
      for (const n of Object.keys(r.last?.unpayable || {})) keys.add(n);
    }
    return [...keys].filter((k) => k === k.toLowerCase() && NETWORK_RE.test(k));
  };

  // The whole index as a star map (atlas.fizzl.eu): every seller with its kind of service, size, bait count, median
  // price and networks, and every endpoint with its daily verdicts. Compact arrays, built on request (not kept:
  // the server caches the gzipped answer per scan instead). Null while the index loads.
  function atlas() {
    if (!state.index) { if (Date.now() - state.at > TTL_MS) refresh(); return null; }
    const days = state.index.days || [];
    const baitUrls = new Set();
    for (const s of servicesView().services) if (s.bait) for (const url of s.members) baitUrls.add(url);
    const sellers = new Map();
    const endpoints = [];
    for (const r of Object.values(state.index.resources || {})) {
      if (!/[gcnx]/.test(r.h || '')) continue;
      let host;
      try { host = new URL(r.url).hostname.toLowerCase(); } catch { continue; }
      const site = siteOf(host);
      const text = r.d || r.url;
      const jev = state.categories?.[descKey(text)];
      const cat = CATEGORY_IDS.includes(jev) ? jev : guessCategory(text);
      let s = sellers.get(site);
      if (!s) { s = { site, cats: {}, n: 0, prices: [], bait: 0, nets: new Set() }; sellers.set(site, s); }
      s.n++;
      s.cats[cat] = (s.cats[cat] || 0) + 1;
      if (r.last?.price_usd > 0) s.prices.push(r.last.price_usd);
      for (const n of r.last?.networks || []) if (typeof n === 'string') s.nets.add(n.split(':')[0]);
      const bait = baitUrls.has(r.url);
      if (bait) s.bait++;
      // h is aligned to the end of days[]: pad the oldest days as not scanned.
      endpoints.push({ site, h: r.h.padStart(days.length, '-').slice(-days.length), bait });
    }
    const list = [...sellers.values()].sort((a, b) => b.n - a.n || (a.site < b.site ? -1 : 1));
    const idx = new Map(list.map((s, i) => [s.site, i]));
    const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
    return {
      updated: state.index.updated,
      days,
      categories: CATEGORIES.map((c) => ({ id: c.id, name: c.name })),
      networks: ATLAS_NETWORKS,
      // [site, category index, endpoints, bait endpoints, median price in USD or null, networks as a bitmask of networks[]]
      sellers: list.map((s) => {
        const cat = Object.entries(s.cats).sort((a, b) => b[1] - a[1])[0][0];
        let mask = 0;
        for (const n of s.nets) { const i = ATLAS_NETWORKS.indexOf(n); if (i >= 0) mask |= 1 << i; }
        return [s.site, CATEGORY_IDS.indexOf(cat), s.n, s.bait, median(s.prices), mask];
      }),
      // [seller index, one letter a day (g go, c caution, n no-go, x unreachable, - not scanned), 1 when bait]
      endpoints: endpoints.map((e) => (e.bait ? [idx.get(e.site), e.h, 1] : [idx.get(e.site), e.h])),
    };
  }

  // One seller's endpoints (its site, as on the atlas: the domain without subdomains), for the atlas card: each with
  // the latest verdict, its record, price, networks and whether it reads like bait. Payable ones first, at most
  // `limit`; null while the index loads. sellerEndpointsAll() builds every seller's list in one pass (lib/trust-views.js).
  function sellerRows(only) {
    const baitUrls = new Set();
    for (const s of servicesView().services) if (s.bait && (!only || s.site === only)) for (const url of s.members) baitUrls.add(url);
    const bySite = new Map();
    for (const r of Object.values(state.index.resources || {})) {
      if (!/[gcnx]/.test(r.h || '')) continue;
      let host;
      try { host = new URL(r.url).hostname.toLowerCase(); } catch { continue; }
      const site = siteOf(host);
      if (only && site !== only) continue;
      const record = trackRecord(r.h);
      if (!bySite.has(site)) bySite.set(site, []);
      bySite.get(site).push({
        url: r.url,
        verdict: VERDICT[r.h.slice(-1)] || 'not_scanned',
        ...(record ? { payable_ratio: record.payable_ratio, days_checked: record.days_checked } : {}),
        ...(r.last?.price_usd > 0 ? { price_usd: r.last.price_usd } : {}),
        networks: (r.last?.networks || []).filter((n) => typeof n === 'string'),
        ...(r.d ? { description: String(r.d).slice(0, 160) } : {}),
        ...(r.p === 'mpp' ? { protocol: 'mpp' } : {}),
        ...(baitUrls.has(r.url) ? { bait: true } : {}),
      });
    }
    return bySite;
  }
  const VERDICT = { g: 'go', c: 'caution', n: 'no_go', x: 'unreachable', '-': 'not_scanned' };
  const RANK = { go: 0, caution: 1, unreachable: 2, no_go: 3, not_scanned: 4 };
  const sellerView = (site, list, limit) => {
    list.sort((a, b) => RANK[a.verdict] - RANK[b.verdict] || (a.url < b.url ? -1 : 1));
    return { site, updated: state.index.updated, total: list.length, endpoints: list.slice(0, limit), truncated: list.length > limit };
  };
  function sellerEndpoints(site, { limit = 200 } = {}) {
    if (!state.index) { if (Date.now() - state.at > TTL_MS) refresh(); return null; }
    const want = String(site || '').toLowerCase();
    return sellerView(want, sellerRows(want).get(want) || [], limit);
  }
  function sellerEndpointsAll({ limit = 200 } = {}) {
    if (!state.index) return null;
    return new Map([...sellerRows(null)].map(([site, list]) => [site, sellerView(site, list, limit)]));
  }

  const updated = () => state.index?.updated ?? null;

  return { lookup, submittedKeys, seller, refresh, summary, byNetwork, similar, atlas, sellerEndpoints, sellerEndpointsAll, updated, similarEntries, networkKeys };
}

// The payable, priced, described resources the price check compares with.
function wordEntries(resources) {
  const entries = [];
  for (const entry of Object.values(resources || {})) {
    const price = entry.last?.price_usd;
    if (!['go', 'caution'].includes(entry.last?.verdict) || typeof price !== 'number' || price <= 0 || !entry.d) continue;
    let host;
    try { host = new URL(entry.url).hostname; } catch { continue; }
    if (wordsOf(entry.d).size === 0) continue;
    entries.push({ url: entry.url, host, site: siteOf(host), description: entry.d.slice(0, 300), price });
  }
  return entries;
}

// Which entries use each word; built once per loaded index (or similar.json).
function buildWordIndex(entries) {
  const byWord = new Map();
  const list = entries.map((e, i) => {
    const words = wordsOf(e.description);
    for (const w of words) {
      if (!byWord.has(w)) byWord.set(w, []);
      byWord.get(w).push(i);
    }
    return { ...e, words: words.size };
  });
  return { entries: list, byWord };
}

// Paid APIs of other sellers whose description shares rare words with `description`, best first (see similar()).
function similarIn({ entries, byWord }, targetUrl, description, { limit = 24, perSite = 2 } = {}) {
  const words = wordsOf(description);
  if (words.size === 0) return [];
  let ownSite = null;
  try { ownSite = siteOf(new URL(targetUrl).hostname); } catch {}
  const scores = new Map();
  for (const w of words) {
    const hits = byWord.get(w);
    if (!hits || hits.length > entries.length / 4) continue; // too common to tell services apart
    const idf = Math.log(entries.length / hits.length);
    for (const i of hits) scores.set(i, (scores.get(i) || 0) + idf);
  }
  const ranked = [...scores.entries()]
    .map(([i, sc]) => ({ e: entries[i], s: sc / Math.sqrt(entries[i].words) }))
    .filter((r) => r.e.site !== ownSite)
    .sort((a, b) => b.s - a.s);
  const out = [];
  const perSeller = new Map();
  for (const { e } of ranked) {
    const n = perSeller.get(e.site) || 0;
    if (n >= perSite) continue;
    perSeller.set(e.site, n + 1);
    out.push({ url: e.url, host: e.host, description: e.description, price_usd: e.price });
    if (out.length >= limit) break;
  }
  return out;
}

// Listed resources whose path has a parameter, per origin: a concrete URL finds its record through them.
function templatesOf(resources) {
  const templates = new Map();
  for (const [key, entry] of Object.entries(resources || {})) {
    let u;
    let path;
    try {
      u = new URL(key);
      path = decodeURIComponent(u.pathname);
    } catch {
      continue;
    }
    if (!path.split('/').some((seg) => /^:\w+$|^\{[^}]*\}$/.test(seg))) continue;
    if (!templates.has(u.origin)) templates.set(u.origin, []);
    templates.get(u.origin).push({ path, entry });
  }
  return templates;
}

// The payout address fingerprints and price history of an entry (lib/payee-history.js), as payto and price.
const payeeFields = (entry) => ({ ...(entry.pt ? { payto: entry.pt } : {}), ...(entry.pr ? { price: entry.pr } : {}) });

// A URL's track record in an index (or one host bucket of it), exact or through a path template; null when unknown.
function lookupIn(index, templates, targetUrl) {
  let key;
  try { key = keyOf(targetUrl); } catch { return null; }
  const exact = index?.resources?.[key];
  let entry = exact;
  if (!entry) {
    let target;
    try { target = new URL(targetUrl); } catch { return null; }
    const actual = target.pathname.replace(/\/+$/, '');
    entry = (templates.get(target.origin) || []).find((t) => pathMatches(t.path, actual))?.entry ?? null;
  }
  if (!entry) return null;
  const record = trackRecord(entry.h);
  if (!record) return null;
  // Matched through the listing's path template (/wallet/:address for /wallet/0xabc…): say which one.
  return { ...record, protocol: entry.p === 'mpp' ? 'mpp' : 'x402', history: entry.h, days: index.days, last_scan: entry.last, updated: index.updated, ...(exact ? {} : { listed_as: entry.url }), ...(entry.ns ? { namesake: entry.ns } : {}), ...payeeFields(entry) };
}

// An endpoint its seller added (submitted.json, not in a registry): the same track record, marked submitted.
function submittedLookup(submitted, targetUrl) {
  let key;
  try { key = keyOf(targetUrl); } catch { return null; }
  const entry = submitted?.resources?.[key];
  const record = entry ? trackRecord(entry.h) : null;
  if (!record) return null;
  return { ...record, protocol: entry.p === 'mpp' ? 'mpp' : 'x402', history: entry.h, days: submitted.days, last_scan: entry.last, updated: submitted.updated, submitted: true, ...payeeFields(entry) };
}

function submittedKeysOf(submitted, host) {
  return Object.keys(submitted?.resources || {}).filter((k) => {
    try { return new URL(k).host === host; } catch { return false; }
  });
}

// The seller's scanned resources on one origin: how many, how many are payable today and how reliable they were.
function sellerIn(resources, origin) {
  let count = 0;
  let payableNow = 0;
  let ratios = 0;
  let unreliable = 0;
  for (const [key, entry] of Object.entries(resources || {})) {
    if (key !== origin && !key.startsWith(`${origin}/`)) continue;
    const record = trackRecord(entry.h);
    if (!record) continue;
    count++;
    if (/[gc]$/.test(entry.h)) payableNow++; // payable in the latest scan, not just when last seen
    ratios += record.payable_ratio;
    if (record.days_checked >= 3 && record.payable_ratio < 0.5) unreliable++;
  }
  if (count === 0) return { origin, resources: 0 };
  return { origin, resources: count, payable_now: payableNow, avg_payable_ratio: Math.round((ratios / count) * 100) / 100, unreliable };
}

// Bait signs of a service from the published Jev answers (scripts/categorize.js, the paid preflight's bait check):
// { impersonation, lure } when one of them is sure (>= 0.85), else null.
const BAIT_SURE = 0.85;
function baitOf(service, bait) {
  const b = bait?.[descKey(service.rep.d || service.rep.url)];
  if (!Array.isArray(b)) return null;
  const [impersonation, lure] = b;
  return (impersonation ?? 0) >= BAIT_SURE || (lure ?? 0) >= BAIT_SURE ? { impersonation: impersonation ?? null, lure: lure ?? null } : null;
}
// The services that look like bait, surest first (at most 100), and how many services were checked.
function baitList(services, bait) {
  const flagged = services.filter((s) => s.bait);
  return {
    checked: services.filter((s) => Array.isArray(bait?.[descKey(s.rep.d || s.rep.url)])).length,
    flagged: flagged.length,
    services: flagged
      .sort((a, b) => Math.max(b.bait.impersonation ?? 0, b.bait.lure ?? 0) - Math.max(a.bait.impersonation ?? 0, a.bait.lure ?? 0))
      .slice(0, 100)
      .map((s) => ({ url: s.rep.url, seller: s.site, description: String(s.rep.d || '').slice(0, 200), endpoints: s.members.length, ...s.bait })),
  };
}

module.exports = { createTrustIndex, readIndex, wordsOf, lookupIn, templatesOf, submittedLookup, submittedKeysOf, sellerIn, similarIn, buildWordIndex, NETWORK_RE, TTL_MS };
