// x402 Trust Index: a daily scan of every resource in the CDP Bazaar (plus the MPP directory, the GoPlausible
// facilitator's Algorand listings, Circle's Agent Marketplace catalog, the XRPL AI Hub, nohumans.directory's catalogue
// and PayAPI Market) with the pre-payment check, kept as a rolling 30-day history per resource.
//
// Politeness: the scan only ever triggers the 402 challenge (it never pays),
// at most PER_HOST requests run against one host at a time, /openapi.json is
// fetched once per origin, Solana payout lookups are cached, and every request
// carries a User-Agent that explains the scan. A 429 or 503 is retried once after
// the seller's Retry-After (capped, with jitter); a seller that is still rate
// limited is recorded as not checked that day, never as down.

const crypto = require('node:crypto');
const { preflight } = require('./preflight');
const { keyOf } = require('./bazaar-index');
const { parseChallenges, hasPayment } = require('./mpp');
const { burnAddress, isEvmAddress, isSolanaAddress, isXrplAddress, isStellarAddress, isAlgorandAddress } = require('./networks');
const { SOLANA, USDC_MINT } = require('./onchain-payments-solana');
const { XRPL } = require('./onchain-payments-xrpl');
const { STELLAR, USDC_CONTRACT: STELLAR_USDC } = require('./onchain-payments-stellar');
const { isAlgorandUsdc } = require('./onchain-payments-algorand');
const { XLAYER, TOKENS: XLAYER_DOLLARS } = require('./onchain-payments-xlayer');

const DISCOVERY_URL = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources';
// The MPP (Stripe + Tempo) service directory: services with their endpoints, method and path.
const MPP_DIRECTORY_URL = 'https://mpp.dev/api/services';
// The GoPlausible facilitator's discovery list: mostly x402 on Algorand (USDC ASA), which the CDP Bazaar doesn't list.
const GOPLAUSIBLE_DISCOVERY_URL = 'https://facilitator.goplausible.xyz/discovery/resources';
// Circle's Agent Marketplace catalog (agents.circle.com/services): many Circle Gateway sellers the Bazaar doesn't list.
const CIRCLE_DISCOVERY_URL = 'https://api.circle.com/v2/x402/discovery/resources';
// nohumans.directory's catalogue (CC BY 4.0): endpoints it probes and buys from with real USDC, many in no other registry.
const NOHUMANS_LISTINGS_URL = 'https://api.nohumans.directory/v1/listings';
// PayAPI Market's catalogue: x402 APIs whose sellers listed them there, each with the route its operator paid once.
const PAYAPI_LIST_URL = 'https://payapi.market/agent/list';
const USER_AGENT = 'x402-doctor-trust-scan/1.0 (+https://x402-doctor.fizzl.eu/trust; probes the 402 challenge once a day, never pays)';
const HISTORY_DAYS = 30;
const RETRY_STATUSES = new Set([429, 503]);
const MAX_RETRY_AFTER_MS = 60_000;
const DEFAULT_RETRY_AFTER_MS = 5_000;
const HOST_WAIT_BUDGET_MS = 120_000; // total Retry-After waiting per host per scan
// A seller that stops answering must not hold up the scan (on 17 Oct one did for over two hours and the job ran out of
// time): after SLOW_STREAK requests in a row that took SLOW_MS or more (timeouts included), or once its requests took
// HOST_SCAN_BUDGET_MS in all, the rest of its endpoints are not checked that day ('-'), never marked down. Only time
// spent in the request counts, not the wait for the host's slot; a seller that refuses at once still counts as down.
const SLOW_MS = 8_000;
const SLOW_STREAK = 10;
const HOST_SCAN_BUDGET_MS = 120 * 60_000;
// A seller's firewall that turned the scan away this many times in a row: the rest of its endpoints are left alone
// for the day (not checked, never marked down). It answers for the scanner, not for what agents get.
const BLOCK_STREAK = 3;
// A seller with more than SAMPLE_ABOVE endpoints gets a share of them checked each day, so that every one of them has
// its turn within SAMPLE_DAYS (at least SAMPLE_ABOVE a day); the rest are not checked that day ('-', code 'sampled')
// and keep their last verdict. On 27 Oct 2026 one seller listed 62,924 endpoints: its requests ran into
// HOST_SCAN_BUDGET_MS, held its share of the scan for nearly two hours and still left half of them unchecked.
const SAMPLE_ABOVE = 5_000;
const SAMPLE_DAYS = 7;

// One letter per day: g = go, c = caution, n = no_go, x = unreachable or
// error, - = not checked that day.
// rate_limited counts as '-': the seller asked us to come back later.
// Not judged today ('-'): rate limited, an MPP endpoint that checks its input before asking for payment, or a listed
// path template without an example value.
const LETTER = { go: 'g', caution: 'c', no_go: 'n', rate_limited: '-', needs_input: '-', not_checked: '-' };

// Retry-After is seconds or an HTTP date; missing or unreadable falls back to a short default.
function retryAfterMs(value, now = Date.now()) {
  if (value == null || value === '') return DEFAULT_RETRY_AFTER_MS;
  const ms = /^\d+$/.test(String(value).trim()) ? Number(value) * 1000 : Date.parse(value) - now;
  if (!Number.isFinite(ms)) return DEFAULT_RETRY_AFTER_MS;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, ms));
}

// One catalog page, tried again after a 429, a 5xx, a timeout or a dropped connection: the catalog is ~80 pages, and
// on 15 Oct one 502 on one page ended the whole day's scan. A 4xx other than 429 is a real answer and fails at once.
const PAGE_RETRY_DELAYS_MS = [2_000, 10_000, 30_000];
async function catalogPage(pageUrl, { fetchImpl, sleep, delays = PAGE_RETRY_DELAYS_MS, name = 'CDP discovery', headers, pick = (data) => data.items || [] }) {
  for (let attempt = 0; ; attempt++) {
    let res = null;
    let error = null;
    try {
      res = await fetchImpl(pageUrl, { ...(headers ? { headers } : {}), signal: AbortSignal.timeout(30000) });
    } catch (err) {
      error = err;
    }
    if (res && res.ok) return pick(await res.json());
    const retryable = !res || res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= delays.length) throw new Error(res ? `${name} HTTP ${res.status}` : `${name} unreachable: ${error.message}`);
    await sleep(delays[attempt]);
  }
}

// Every CDP Bazaar listing as the registry gives it (also read by scripts/namesakes.js for service names and payTo).
async function loadCatalogItems({ url = DISCOVERY_URL, fetchImpl = fetch, maxPages = 200, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), retryDelays } = {}) {
  const items = [];
  for (let page = 0; page < maxPages; page++) {
    const batch = await catalogPage(`${url}?type=http&limit=500&offset=${page * 500}`, { fetchImpl, sleep, delays: retryDelays });
    items.push(...batch);
    if (batch.length < 500) break;
  }
  return items;
}

async function loadCatalog(opts = {}) {
  const items = await loadCatalogItems(opts);
  // One entry per origin + path; keep the method the seller declared.
  const byKey = new Map();
  for (const item of items) {
    let key;
    try {
      key = keyOf(item.resource);
    } catch {
      continue;
    }
    if (byKey.has(key)) continue;
    const declared = String(item.extensions?.bazaar?.info?.input?.method || '').toUpperCase();
    byKey.set(key, { key, url: item.resource, method: declared === 'GET' || declared === 'POST' ? declared : undefined, description: String(item.description || '').slice(0, 200), ...probeOf(item) });
  }
  return [...byKey.values()];
}

// A listed path with a parameter (/wallet/:address, /wallet/{address}) is probed with the example value its listing
// gives (bazaar.info.input.pathParams), as the diagnosis does: { probe }. Without one there is no valid request to
// make, and the placeholder itself would answer 404: { template: true }, recorded as needs_input, not as broken.
const PATH_PARAM = /^:([A-Za-z_][\w-]*)$|^\{([^/{}]+)\}$|^\[([^/[\]]+)\]$/;
function probeOf(item) {
  const u = new URL(item.resource);
  const params = item.extensions?.bazaar?.info?.input?.pathParams || {};
  let templated = false;
  let missing = false;
  const path = u.pathname.split('/').map((segment) => {
    let decoded = segment;
    try { decoded = decodeURIComponent(segment); } catch { /* keep it */ }
    const m = PATH_PARAM.exec(decoded);
    if (!m) return segment;
    templated = true;
    const value = params[m[1] ?? m[2] ?? m[3]];
    if (value === undefined || value === null || value === '') {
      missing = true;
      return segment;
    }
    return encodeURIComponent(String(value));
  }).join('/');
  if (!templated) return {};
  return missing ? { template: true } : { probe: `${u.origin}${path}${u.search}` };
}

// The GoPlausible discovery list as scan entries (checked like Bazaar resources, with the x402 preflight). Its
// items name the URL resourceUrl and carry the declared method; pages follow pagination.total. https only, one
// entry per origin + path.
async function loadGoPlausibleCatalog({ url = GOPLAUSIBLE_DISCOVERY_URL, fetchImpl = fetch, maxPages = 100 } = {}) {
  const byKey = new Map();
  // The server may cap the page size below what is asked (100 since late Oct 2026, of 2,700+): page on by what
  // came back, until the total is reached or a page is empty.
  let offset = 0;
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchImpl(`${url}?limit=500&offset=${offset}`, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`GoPlausible discovery HTTP ${res.status}`);
    const data = await res.json();
    const batch = data.items || [];
    for (const item of batch) {
      const href = String(item.resourceUrl || item.resource || '');
      if (!href.startsWith('https://')) continue;
      let key;
      try { key = keyOf(href); } catch { continue; }
      if (byKey.has(key)) continue;
      const declared = String(item.method || item.discoveryInfo?.input?.method || '').toUpperCase();
      byKey.set(key, { key, url: href, method: declared === 'GET' || declared === 'POST' ? declared : undefined, description: String(item.description || '').slice(0, 200) });
    }
    offset += batch.length;
    const total = Number(data.pagination?.total);
    if (batch.length === 0 || (Number.isFinite(total) ? offset >= total : batch.length < 500)) break;
  }
  return [...byKey.values()];
}

// Circle's Agent Marketplace catalog as scan entries (checked with the x402 preflight). Items are like the Bazaar's,
// with the declared method and description under metadata; at most 200 per page. Its API rate limits quickly, so
// pages are a second apart and a 429 is tried again. https only, one entry per origin + path.
async function loadCircleCatalog({ url = CIRCLE_DISCOVERY_URL, fetchImpl = fetch, maxPages = 50, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), retryDelays, pauseMs = 1000 } = {}) {
  const byKey = new Map();
  for (let page = 0; page < maxPages; page++) {
    if (page > 0) await sleep(pauseMs);
    const batch = await catalogPage(`${url}?type=http&limit=200&offset=${page * 200}`, { fetchImpl, sleep, delays: retryDelays, name: 'Circle discovery', headers: { 'user-agent': USER_AGENT } });
    for (const item of batch) {
      const href = String(item.resource || '');
      if (!href.startsWith('https://')) continue;
      let key;
      try { key = keyOf(href); } catch { continue; }
      if (byKey.has(key)) continue;
      const meta = item.metadata || {};
      const declared = String(meta.method || '').toUpperCase();
      const pathParams = meta.input?.pathParams;
      byKey.set(key, {
        key,
        url: href,
        method: declared === 'GET' || declared === 'POST' ? declared : undefined,
        description: String(meta.description || meta.provider?.description || '').slice(0, 200),
        ...probeOf({ resource: href, extensions: { bazaar: { info: { input: { pathParams } } } } }),
      });
    }
    if (batch.length < 200) break;
  }
  return [...byKey.values()];
}

// nohumans.directory's catalogue as scan entries (checked with the x402 preflight). Mirroring it is a supported use and
// the data is CC BY 4.0 (credited on /trust, in the README and on the Hugging Face dataset). /v1/listings gives the
// active listings (verified, unverified, failing) in a stable order, 200 a page, until next_offset is null. It names no
// method, so both are tried. https only, one entry per origin + path; a path template without an example is marked as
// for the other registries. MCP endpoints (a path ending in /mcp) are listed free there and left out.
// With `evidence` (a Map), every listing the directory bought with real USDC and got its answer from (paid_verified)
// is added to it by key as [day of that purchase, the listing's status now, its id]: delivery evidence for the
// preflight (lib/delivery-elsewhere.js), which the scan itself can't give.
async function loadNohumansCatalog({ url = NOHUMANS_LISTINGS_URL, fetchImpl = fetch, maxPages = 100, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), retryDelays, pauseMs = 300, evidence = null } = {}) {
  const byKey = new Map();
  let offset = 0;
  for (let page = 0; page < maxPages && offset !== null; page++) {
    if (page > 0) await sleep(pauseMs);
    const data = await catalogPage(`${url}?limit=200&offset=${offset}`, { fetchImpl, sleep, delays: retryDelays, name: 'nohumans.directory', headers: { 'user-agent': USER_AGENT }, pick: (d) => d });
    for (const item of data.results || []) {
      const href = String(item.endpoint_url || '');
      if (!href.startsWith('https://')) continue;
      let key;
      try { key = keyOf(href); } catch { continue; }
      if (byKey.has(key) || /\/mcp\/?$/.test(new URL(href).pathname)) continue;
      byKey.set(key, { key, url: href, description: String(item.description || '').slice(0, 200), ...probeOf({ resource: href }) });
      const paidAt = Number(item.paid_verified_at);
      if (evidence && item.paid_verified === true && Number.isFinite(paidAt) && paidAt > 0) {
        evidence.set(key, [new Date(paidAt * 1000).toISOString().slice(0, 10), String(item.status || ''), String(item.id || '')]);
      }
    }
    const next = Number(data.next_offset);
    offset = data.next_offset == null || !Number.isFinite(next) || next <= offset ? null : next;
  }
  return [...byKey.values()];
}

// PayAPI Market's catalogue as scan entries (checked with the x402 preflight). /agent/list is its open discovery API
// for agents (verified_only=false: the whole live catalogue, not only the listings it has paid), 500 a page. A listing
// gives its paid route (base_url) and the routes its operator paid once (verified_routes, with the method), relative
// to it. A bare origin (a homepage) and the listing's MCP endpoint are left out: neither answers 402. https only, one
// entry per origin + path, the method from the paid route when it names one.
// With `evidence` (a Map), every route PayAPI paid and got real product from (settlement-verified, with its day) is added
// to it by key as [day of that payment, 'verified', the listing page]: delivery evidence for the preflight.
async function loadPayApiCatalog({ url = PAYAPI_LIST_URL, fetchImpl = fetch, maxPages = 20, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), retryDelays, pauseMs = 300, evidence = null } = {}) {
  const byKey = new Map();
  const add = (href, method, description) => {
    let u, key;
    try { u = new URL(href); key = keyOf(u.href); } catch { return; }
    if (u.protocol !== 'https:' || u.pathname === '/' || byKey.has(key)) return;
    const m = String(method || '').toUpperCase();
    byKey.set(key, { key, url: u.href, method: m === 'GET' || m === 'POST' ? m : undefined, description, ...probeOf({ resource: u.href }) });
  };
  for (let page = 0; page < maxPages; page++) {
    if (page > 0) await sleep(pauseMs);
    const data = await catalogPage(`${url}?verified_only=false&limit=500&offset=${page * 500}`, { fetchImpl, sleep, delays: retryDelays, name: 'PayAPI Market', headers: { 'user-agent': USER_AGENT }, pick: (d) => d });
    const batch = data.results || [];
    for (const item of batch) {
      const base = String(item.base_url || '');
      const mcp = String(item.mcp_endpoint || '');
      const description = String(item.description || '').slice(0, 200);
      const routes = (Array.isArray(item.verified_routes) ? item.verified_routes : []).map((v) => {
        try { return { href: new URL(String(v.route || ''), base).href, method: v.method, at: v.verified_at }; } catch { return null; }
      }).filter((v) => v && v.href !== mcp);
      if (base && base !== mcp) add(base, routes.find((v) => v.href === base)?.method, description);
      for (const v of routes) {
        add(v.href, v.method, description);
        const day = /^\d{4}-\d{2}-\d{2}/.test(String(v.at || '')) ? String(v.at).slice(0, 10) : null;
        let key = null;
        try { key = keyOf(v.href); } catch { /* not a URL */ }
        if (evidence && day && key && v.href.startsWith('https://') && !(evidence.get(key)?.[0] > day)) {
          evidence.set(key, [day, 'verified', String(item.marketplace_url || '')]);
        }
      }
    }
    if (batch.length < 500) break;
  }
  return [...byKey.values()];
}

// The XRPL AI Hub (xrpl-ai.org, t54 Labs): the merchants paid through t54's XRPL facilitator and the APIs each one
// offers, most of them in no other registry (Oct 2026: 177 merchants, 14.6 million payments). It has no listing API, so
// its pages are read: /merchants (20 a page, "Page 1 of N") for the merchant addresses, then each merchant's page, whose
// embedded page data lists its resources ({ merchantAddr, url, name, description, network, isActive }). A page that
// can't be read is skipped; active xrpl:0 resources on https only, one entry per origin + path. Gives { resources,
// merchants }: the scan entries, and every merchant address (many get paid without listing an API; on 24 Oct 26 of
// the first 60 listed none), which the hourly XRPL payment count watches too.
const XRPL_HUB_URL = 'https://xrpl-ai.org';
// The page data a Next.js page streams in (self.__next_f.push([1, "…"]) scripts), as one string.
function nextPageData(html) {
  let out = '';
  for (const m of String(html).matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    try { out += JSON.parse(m[1]); } catch { /* not a string chunk */ }
  }
  return out;
}
// The JSON objects in `text` that start with {"id":…,"merchantAddr": (the hub's resources), parsed.
function hubResources(text) {
  const out = [];
  for (const m of text.matchAll(/\{"id":"[^"]*","merchantAddr":/g)) {
    let depth = 0, inString = false, end = -1;
    for (let i = m.index; i < text.length; i++) {
      const c = text[i];
      if (inString) { if (c === '\\') i++; else if (c === '"') inString = false; continue; }
      if (c === '"') inString = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { end = i; break; }
    }
    if (end < 0) continue;
    try { out.push(JSON.parse(text.slice(m.index, end + 1))); } catch { /* not a whole object */ }
  }
  return out;
}
async function loadXrplHub({ url = XRPL_HUB_URL, fetchImpl = fetch, maxPages = 30, maxMerchants = 500, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pauseMs = 500 } = {}) {
  const get = async (path) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(5000 * attempt);
      try {
        const res = await fetchImpl(`${url}${path}`, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(30000) });
        if (res.ok) return res.text();
        if (res.status !== 429 && res.status < 500) return null;
      } catch { /* try again */ }
    }
    return null;
  };
  const merchants = new Set();
  let pages = 1;
  for (let page = 1; page <= Math.min(pages, maxPages); page++) {
    if (page > 1) await sleep(pauseMs);
    const html = await get(`/merchants?page=${page}`);
    if (html === null) {
      if (page === 1) throw new Error('XRPL AI Hub: the merchants page did not answer');
      continue;
    }
    const total = Number(/Page \d+ of (\d+)/.exec(html)?.[1]);
    if (Number.isFinite(total) && total > pages) pages = total;
    for (const m of html.matchAll(/\/address\/(r[1-9A-HJ-NP-Za-km-z]{24,34})/g)) if (isXrplAddress(m[1])) merchants.add(m[1]);
  }
  const byKey = new Map();
  const names = {};
  for (const address of [...merchants].slice(0, maxMerchants)) {
    await sleep(pauseMs);
    const html = await get(`/address/${address}`);
    if (html === null) continue;
    const name = htmlText(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1]);
    if (name && name !== address) names[address] = name.slice(0, 80);
    for (const r of hubResources(nextPageData(html))) {
      const href = String(r.url || '');
      if (r.merchantAddr !== address || r.network !== 'xrpl:0' || r.isActive === false || !href.startsWith('https://')) continue;
      let key;
      try { key = keyOf(href); } catch { continue; }
      if (byKey.has(key)) continue;
      byKey.set(key, { key, url: href, description: String(r.description || r.name || '').slice(0, 200) });
    }
  }
  return { resources: [...byKey.values()], merchants: [...merchants], names };
}
// The text of an HTML fragment: tags dropped, the usual entities decoded, spaces collapsed.
function htmlText(html) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(html ?? '').replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(parseInt(e[1].toLowerCase() === 'x' ? e.slice(2) : e.slice(1), e[1].toLowerCase() === 'x' ? 16 : 10) || 32) : named[e.toLowerCase()] ?? m))
    .replace(/\s+/g, ' ').trim();
}

// Endpoints their sellers added on Doctor (GET /api/trust/submitted, lib/trust-submissions.js) as scan entries.
// https only, one entry per origin + path.
const SUBMISSIONS_URL = 'https://x402-doctor.fizzl.eu/api/trust/submitted';
async function loadSubmissions({ url = SUBMISSIONS_URL, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`submissions HTTP ${res.status}`);
  const data = await res.json();
  const byKey = new Map();
  for (const item of data.submissions || []) {
    const href = String(item.url || '');
    if (!href.startsWith('https://')) continue;
    let key;
    try { key = keyOf(href); } catch { continue; }
    if (byKey.has(key)) continue;
    byKey.set(key, { key, url: href, method: item.method === 'POST' ? 'POST' : item.method === 'GET' ? 'GET' : undefined, ...(item.p === 'mpp' ? { p: 'mpp' } : {}) });
  }
  return [...byKey.values()];
}

// What to scan into submitted.json today: yesterday's added endpoints plus the new submissions, without the ones a
// registry lists by now (the index has them), the ones that haven't been payable on any of their last DEAD_DAYS
// checked days, and anything over MAX_PER_HOST per host (the earliest stay).
const SUBMITTED_PER_HOST = 25;
const DEAD_DAYS = 14;
function submittedResources(previous, submissions, registryKeys, { maxPerHost = SUBMITTED_PER_HOST, deadDays = DEAD_DAYS } = {}) {
  const dead = (h) => {
    const seen = [...(h || '')].filter((c) => c !== '-');
    return seen.length >= deadDays && !seen.slice(-deadDays).some((c) => c === 'g' || c === 'c');
  };
  const out = [];
  const keys = new Set();
  const perHost = new Map();
  const take = (r) => {
    if (keys.has(r.key) || registryKeys.has(r.key)) return;
    let host;
    try { host = new URL(r.url).host; } catch { return; }
    if ((perHost.get(host) || 0) >= maxPerHost) return;
    perHost.set(host, (perHost.get(host) || 0) + 1);
    keys.add(r.key);
    out.push(r);
  };
  for (const [key, old] of Object.entries(previous?.resources || {})) {
    if (dead(old.h)) continue;
    take({ key, url: old.url, method: old.m === 'POST' ? 'POST' : old.m === 'GET' ? 'GET' : undefined, ...(old.p ? { p: old.p } : {}), ...(old.probe ? { probe: old.probe } : {}) });
  }
  for (const r of submissions) take(r);
  return out;
}

// The MPP directory as scan entries (p: 'mpp'). Paths with parameters ({id}, :id) are left out:
// there is no example value to fill in. Free routes are left out too: the directory lists a service's
// whole API, with payment null (sign-up, list, get) or an amount of "0", and those never answer 402.
// One entry per origin + path.
async function loadMppCatalog({ url = MPP_DIRECTORY_URL, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`MPP directory HTTP ${res.status}`);
  const data = await res.json();
  const services = Array.isArray(data) ? data : data.services || [];
  const byKey = new Map();
  for (const svc of services) {
    if (svc.status && svc.status !== 'active') continue;
    const base = svc.serviceUrl || svc.url;
    for (const e of svc.endpoints || []) {
      const path = String(e.path || '');
      if (!base || !path || /[{}]|\/:/.test(path)) continue;
      if ('payment' in e && (!e.payment || String(e.payment.amount) === '0')) continue;
      let href, key;
      try {
        // The path goes after the service URL's own path (https://mpp.example.com/jobs + /v1/feed =
        // https://mpp.example.com/jobs/v1/feed); new URL(path, base) would drop "/jobs".
        href = new URL(`${String(base).replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`).href;
        if (!href.startsWith('https://')) continue;
        key = keyOf(href);
      } catch {
        continue;
      }
      if (byKey.has(key)) continue;
      const method = String(e.method || 'GET').toUpperCase();
      byKey.set(key, { key, url: href, method: method === 'POST' ? 'POST' : 'GET', description: String(e.description || svc.description || '').slice(0, 200), p: 'mpp' });
    }
  }
  return [...byKey.values()];
}

// Payout addresses for the hourly count of real payments, not stored in the index: on Base (lib/onchain-payments.js),
// USDC payout addresses on Solana with the facilitator that pays their fees (lib/onchain-payments-solana.js),
// payout addresses on the XRP Ledger (lib/onchain-payments-xrpl.js), USDC payout accounts on Stellar
// (lib/onchain-payments-stellar.js), USDC payout addresses on Algorand (lib/onchain-payments-algorand.js) and
// USD₮0 or USDC payout addresses on X Layer (lib/onchain-payments-xlayer.js).
function payTosOf(options) {
  const list = [...new Set(options.filter((o) => o.network === 'eip155:8453' && isEvmAddress(o.pay_to)).map((o) => o.pay_to.toLowerCase()))];
  const onSolana = options.filter((o) => o.network === SOLANA && o.asset === USDC_MINT && isSolanaAddress(o.pay_to) && !burnAddress(o.pay_to));
  const sol = [...new Set(onSolana.map((o) => o.pay_to))];
  const fees = [...new Set(onSolana.map((o) => o.fee_payer).filter(isSolanaAddress))];
  const xrpl = [...new Set(options.filter((o) => o.network === XRPL && isXrplAddress(o.pay_to)).map((o) => o.pay_to))];
  const stellar = [...new Set(options.filter((o) => o.network === STELLAR && o.asset === STELLAR_USDC && isStellarAddress(o.pay_to, 'G')).map((o) => o.pay_to))];
  const algorand = [...new Set(options.filter((o) => isAlgorandUsdc(o.network, o.asset) && isAlgorandAddress(o.pay_to)).map((o) => o.pay_to))];
  const xlayer = [...new Set(options.filter((o) => o.network === XLAYER && XLAYER_DOLLARS.includes(String(o.asset).toLowerCase()) && isEvmAddress(o.pay_to) && !burnAddress(o.pay_to)).map((o) => o.pay_to.toLowerCase()))];
  return { ...(list.length ? { pay_tos: list } : {}), ...(sol.length ? { sol_pay_tos: sol } : {}), ...(fees.length ? { sol_fee_payers: fees } : {}), ...(xrpl.length ? { xrpl_pay_tos: xrpl } : {}), ...(stellar.length ? { stellar_pay_tos: stellar } : {}), ...(algorand.length ? { algorand_pay_tos: algorand } : {}), ...(xlayer.length ? { xlayer_pay_tos: xlayer } : {}) };
}

// The daily check for an MPP endpoint: trigger the 402, read the Payment challenge, never pay.
// go = a well-formed challenge; caution = payable but something looks off; no_go = no 402 or a challenge that can't be paid.
async function mppCheck(r, fetcher, { now = Date.now(), sanctions = null } = {}) {
  const res = await fetcher(r.url, { method: r.method, headers: r.method === 'GET' ? {} : { 'content-type': 'application/json' }, body: r.method === 'GET' ? undefined : '{}' });
  // 400/422 before any 402: the endpoint checks its input first ("symbol is required") and asks for
  // payment only for a valid request. Without example input it can't be judged: not counted as broken.
  if (res.status === 400 || res.status === 422) return { verdict: 'needs_input', codes: ['needs_input'], method: r.method, price_usd: null, networks: [] };
  if (res.status !== 402) return { verdict: 'no_go', codes: [res.status >= 500 ? 'server_error' : 'no_402'], method: r.method, price_usd: null, networks: [] };
  if (!hasPayment(res.headers)) return null; // a 402 without MPP: let the x402 check judge it
  const header = typeof res.headers.get === 'function' ? res.headers.get('www-authenticate') : res.headers['www-authenticate'];
  const all = parseChallenges(header || '');
  const ok = all.filter((c) => !c.error);
  if (!ok.length) return { verdict: 'no_go', codes: ['mpp_challenge_unreadable'], method: r.method, price_usd: null, networks: [] };
  const codes = new Set();
  const host = new URL(r.url).hostname.toLowerCase();
  let price = null;
  const networks = [];
  const payTos = new Set();
  let payable = 0;
  for (const c of ok) {
    const q = c.request, m = c.params.method;
    const exp = c.params.expires ? Date.parse(c.params.expires) : null;
    if (exp !== null && !(exp > now)) { codes.add('mpp_expired'); continue; }
    if (!c.params.expires) codes.add('mpp_no_expires');
    const realm = String(c.params.realm || '').toLowerCase();
    if (!realm || (realm !== host && !host.endsWith(`.${realm}`))) codes.add('mpp_realm_mismatch');
    const amountOk = typeof q.amount === 'string' && /^\d+$/.test(q.amount);
    const addr = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
    let fieldsOk = amountOk;
    if (m === 'tempo' || m === 'evm') fieldsOk = fieldsOk && addr(q.currency) && (addr(q.recipient) || Array.isArray(q.methodDetails?.splits)) && (m !== 'evm' || Number.isSafeInteger(q.methodDetails?.chainId));
    else if (m === 'stripe') fieldsOk = fieldsOk && /^[a-z]{3}$/i.test(String(q.currency || ''));
    if (!fieldsOk) { codes.add('mpp_bad_fields'); continue; }
    if (q.recipient && sanctions?.check(q.recipient)?.listed) { codes.add('payto_sanctioned'); continue; }
    if (burnAddress(q.recipient)) { codes.add('payto_burn'); continue; }
    payable++;
    if (m === 'evm' && q.methodDetails.chainId === 8453 && addr(q.recipient)) payTos.add(q.recipient.toLowerCase());
    networks.push(m === 'evm' ? `mpp:evm:${q.methodDetails.chainId}` : `mpp:${m}`);
    // USD price where the unit is known: 6-decimal stablecoins (USDC and Tempo's USD tokens), or Stripe in USD cents.
    const usd = m === 'stripe' ? (String(q.currency).toLowerCase() === 'usd' ? Number(q.amount) / 100 : null) : (q.methodDetails?.decimals ?? 6) === 6 ? Number(q.amount) / 1e6 : null;
    if (usd !== null && (price === null || usd < price)) price = usd;
  }
  const verdict = payable === 0 || codes.has('payto_sanctioned') ? 'no_go' : codes.size ? 'caution' : 'go';
  return { verdict, codes: [...codes], method: r.method, price_usd: price, networks: [...new Set(networks)], ...(payTos.size ? { pay_tos: [...payTos] } : {}) };
}

// safeFetch wrapper: User-Agent, per-host concurrency limit, one /openapi.json
// fetch per origin, and one Retry-After retry on 429/503. URLs that stay rate
// limited are collected in fetcher.rateLimited.
function politeFetch(safeFetch, { perHost = 2, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), jitterMs = 1000, hostBudgetMs = HOST_WAIT_BUDGET_MS, slowMs = SLOW_MS, slowStreak = SLOW_STREAK, scanBudgetMs = HOST_SCAN_BUDGET_MS } = {}) {
  const active = new Map();
  const queues = new Map();
  const openapi = new Map();

  async function withSlot(host, fn) {
    if ((active.get(host) || 0) >= perHost) {
      await new Promise((resolve) => {
        if (!queues.has(host)) queues.set(host, []);
        queues.get(host).push(resolve);
      });
    }
    active.set(host, (active.get(host) || 0) + 1);
    try {
      return await fn();
    } finally {
      active.set(host, active.get(host) - 1);
      const next = queues.get(host)?.shift();
      if (next) next();
    }
  }

  const rateLimited = new Set();
  const waitedMs = new Map();
  // Per host, how many answers had each status other than 402 (for the scan log: why a seller came out no_go).
  const statuses = new Map();
  const count = (host, res) => {
    if (!res || res.status === 402) return;
    const key = challenged(res) ? `${res.status} challenge` : String(res.status);
    if (!statuses.has(host)) statuses.set(host, new Map());
    const m = statuses.get(host);
    m.set(key, (m.get(key) || 0) + 1);
  };
  // Per host: slow requests in a row, and time spent in requests in all.
  const health = new Map();
  // Per host: answers in a row from its firewall instead of the endpoint, and which one.
  const walls = new Map();
  const fetcher = (target, options = {}) => {
    const url = new URL(target);
    const once = async () => {
      const started = Date.now();
      try {
        const res = await safeFetch(url.href, { ...options, headers: { ...(options.headers || {}), 'user-agent': USER_AGENT } });
        count(url.host, res);
        return res;
      } finally {
        const ms = Date.now() - started;
        const h = health.get(url.host) || { streak: 0, ms: 0 };
        h.streak = ms >= slowMs ? h.streak + 1 : 0;
        h.ms += ms;
        health.set(url.host, h);
      }
    };
    // The wait happens inside the host's slot, so a busy seller gets fewer requests, not more.
    const run = () => withSlot(url.host, async () => {
      let first;
      try {
        first = await once();
      } catch (err) {
        // A server waking from sleep (a cold start on Fly, Workers, Supabase and the like) can miss the first timeout
        // and answer the next request at once: ask once more before calling it unreachable, unless the host is
        // already slow. On 26 Oct 2026, 9 of 40 endpoints the scan found unreachable answered go minutes later.
        if (!/^timed out/.test(err.message) || fetcher.slow(url.host)) throw err;
        first = await once();
      }
      // A bot challenge or a firewall rule (Cloudflare, Vercel) says nothing about the endpoint and a retry won't pass
      // it: not checked today, never down.
      const wall = challenged(first);
      walls.set(url.host, wall ? { streak: (walls.get(url.host)?.streak || 0) + 1, by: wall } : { streak: 0 });
      if (wall) {
        rateLimited.add(url.href);
        return first;
      }
      if (!RETRY_STATUSES.has(first.status)) return first;
      const wait = retryAfterMs(first.headers?.get?.('retry-after')) + Math.random() * jitterMs;
      const waited = waitedMs.get(url.host) || 0;
      if (waited + wait > hostBudgetMs) {
        // This host has had its share of waiting in this scan: record it, don't hammer or stall.
        rateLimited.add(url.href);
        return first;
      }
      waitedMs.set(url.host, waited + wait);
      await sleep(wait);
      const second = await once();
      if (RETRY_STATUSES.has(second.status)) rateLimited.add(url.href);
      return second;
    });
    if (url.pathname === '/openapi.json') {
      if (!openapi.has(url.origin)) openapi.set(url.origin, run().catch((err) => ({ status: 0, text: '', error: err.message })));
      return openapi.get(url.origin);
    }
    return run();
  };
  fetcher.rateLimited = rateLimited;
  fetcher.statuses = statuses;
  // Why a host should not be asked again in this scan, or null.
  fetcher.slow = (host) => {
    const h = health.get(host);
    if (h?.streak >= slowStreak) return `${slowStreak} requests in a row took ${Math.round(slowMs / 1000)} s or more`;
    if (h?.ms >= scanBudgetMs) return `${Math.round(scanBudgetMs / 60_000)} minutes of requests`;
    return null;
  };
  // Why a host's firewall keeps the scan out, or null.
  fetcher.blocked = (host) => {
    const w = walls.get(host);
    return w?.streak >= BLOCK_STREAK ? `its firewall turned the scan away ${w.streak} times in a row (${w.by})` : null;
  };
  return fetcher;
}

// A challenge page or a firewall's refusal instead of an answer, and whose: Cloudflare marks a challenge with
// cf-mitigated: challenge, Vercel's firewall marks what it blocked or challenged with x-vercel-mitigated (deny,
// challenge). Since 19 Oct 2026 one seller's Vercel firewall denies the scan's user agent, while agents get the 402.
function challenged(res) {
  const header = (name) => String(res.headers?.get?.(name) || '').toLowerCase();
  if ((res.status === 403 || res.status === 503) && header('cf-mitigated') === 'challenge') return 'Cloudflare challenge';
  const vercel = header('x-vercel-mitigated');
  if (res.status !== 402 && (vercel === 'deny' || vercel === 'challenge')) return `Vercel firewall: ${vercel}`;
  return null;
}

// The hosts with the most non-402 answers in a scan, for the log: [{ host, total, statuses: { '404': n, … } }].
function statusReport(fetcher, top = 10) {
  return [...(fetcher.statuses || new Map())]
    .map(([host, m]) => ({ host, total: [...m.values()].reduce((a, b) => a + b, 0), statuses: Object.fromEntries(m) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, top);
}

// Indices taken host by host in turn (each host's own order kept), so the workers spread over many sellers instead of
// queueing behind one host's per-host limit. With rotateBy(key), each host's list starts at that offset instead (the
// scan turns it by the day: a seller cut short after HOST_SCAN_BUDGET_MS, one with tens of thousands of endpoints, then
// leaves different endpoints unchecked each day instead of always the same last ones).
function interleave(items, keyOf, rotateBy = null) {
  const groups = new Map();
  items.forEach((item) => {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  const lists = [...groups].map(([key, list]) => {
    const by = rotateBy ? rotateBy(key) % list.length : 0;
    return by ? [...list.slice(by), ...list.slice(0, by)] : list;
  });
  const out = [];
  for (let round = 0; out.length < items.length; round++) for (const list of lists) if (round < list.length) out.push(list[round]);
  return out;
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

// Networks an endpoint offers over x402 but that would not settle today, each with its first problem (kept short):
// lets per-network pages (e.g. /xrpl) show "offers XRPL, but the payout account has no RLUSD trust line".
function unpayableOf(options) {
  const payable = new Set(options.filter((o) => o.payable).map((o) => o.network));
  const out = {};
  for (const o of options) {
    if (o.protocol !== 'x402' || !o.network || o.payable || payable.has(o.network) || out[o.network]) continue;
    out[o.network] = String(o.problems?.[0] || 'not payable').slice(0, 160);
  }
  return Object.keys(out).length ? { unpayable: out } : {};
}

// A number from a text (the first 32 bits of its SHA-1): a host's share of the scan, a host's turn for the day.
const hashOf = (text) => parseInt(crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 8), 16);
// Which of `shares` parallel jobs scans a host (scripts/trust-scan.js --shard): all of a seller's endpoints in the same
// job, so it still gets at most PER_HOST requests at a time.
const shareOf = (host, shares) => hashOf(host) % shares;
const hostOf = (r) => { try { return new URL(r.probe || r.url).host; } catch { return ''; } };

// Today's sample of the sellers with more than `above` endpoints: per such host, the endpoints whose key hashes to
// today's turn out of `turns` (turns = how many days it takes to check them all, at most `days`, with at least `above`
// a day). A hash of the key, not the position in the list, so a new listing doesn't shift every other one's day.
// Returns the indices to leave alone today and, per sampled host, how many are checked of how many.
function sampleOf(resources, { day = null, above = SAMPLE_ABOVE, days = SAMPLE_DAYS } = {}) {
  const byHost = new Map();
  resources.forEach((r, i) => {
    const host = hostOf(r);
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(i);
  });
  const dayNumber = day ? Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000) : 0;
  const skip = new Set();
  const hosts = [];
  for (const [host, list] of byHost) {
    if (!(above > 0) || list.length <= above) continue;
    const turns = Math.ceil(list.length / Math.max(above, Math.ceil(list.length / days)));
    if (turns < 2) continue;
    const turn = ((dayNumber % turns) + turns) % turns;
    let checked = 0;
    for (const i of list) {
      if (hashOf(resources[i].key ?? resources[i].url) % turns === turn) checked++;
      else skip.add(i);
    }
    hosts.push({ host, checked, of: list.length, turns });
  }
  return { skip, hosts };
}

async function scan(resources, { safeFetch, rpcUrl, concurrency = 24, perHost = 2, onProgress, onStatuses, onSlowHosts, onSampled, sampleAbove = SAMPLE_ABOVE, sampleDays = SAMPLE_DAYS, sleep, sanctions = null, slowMs, slowStreak, scanBudgetMs, day = null, statusTop = 10 } = {}) {
  const fetcher = politeFetch(safeFetch, { perHost, ...(sleep ? { sleep } : {}), ...(slowMs ? { slowMs } : {}), ...(slowStreak ? { slowStreak } : {}), ...(scanBudgetMs ? { scanBudgetMs } : {}) });
  const results = new Array(resources.length);
  // Hosts whose undeclared endpoints turned out to ask for payment on POST only: try POST first for the rest of
  // them, so a seller with thousands of POST routes gets one request per route instead of two.
  const learned = new Map();
  // Hosts cut short in this scan, with the reason (see SLOW_MS).
  const cut = new Map();
  let done = 0;
  const sampled = sampleOf(resources, { day, above: sampleAbove, days: sampleDays });
  for (const i of sampled.skip) {
    const r = resources[i];
    results[i] = { key: r.key, url: r.url, ...(r.p ? { p: r.p } : {}), method: r.method ?? null, verdict: 'not_checked', codes: ['sampled'], price_usd: null, networks: [], ms: 0 };
  }
  if (onSampled && sampled.hosts.length) onSampled(sampled.hosts);
  done += sampled.skip.size;
  const order = interleave(resources.map((_, i) => i).filter((i) => !sampled.skip.has(i)), (i) => hostOf(resources[i]), day ? (host) => hashOf(`${day} ${host}`) : null);
  await mapLimit(order, concurrency, async (i) => {
    const r = resources[i];
    const host = hostOf(r);
    const started = Date.now();
    const slow = fetcher.slow(host);
    const blocked = !slow && fetcher.blocked(host);
    if ((slow || blocked) && !cut.has(host)) cut.set(host, slow || blocked);
    if (slow || blocked) {
      results[i] = { key: r.key, url: r.url, ...(r.p ? { p: r.p } : {}), method: r.method ?? null, verdict: 'not_checked', codes: [slow ? 'host_slow' : 'scan_blocked'], price_usd: null, networks: [], ms: 0 };
      done++;
      if (onProgress && done % 500 === 0) onProgress(done, resources.length);
      return;
    }
    try {
      if (r.p === 'mpp') {
        const m = await mppCheck(r, fetcher, { sanctions });
        if (m) {
          const limited = fetcher.rateLimited.has(new URL(r.url).href) && m.verdict === 'no_go';
          results[i] = { key: r.key, url: r.url, p: 'mpp', method: m.method, verdict: limited ? 'rate_limited' : m.verdict, codes: limited ? ['rate_limited'] : m.codes, price_usd: m.price_usd, networks: m.networks, ...(m.pay_tos ? { pay_tos: m.pay_tos } : {}), ms: Date.now() - started };
          return;
        }
      }
      // A listed path template without an example value: nothing valid to ask for.
      if (r.template) {
        results[i] = { key: r.key, url: r.url, method: r.method ?? null, verdict: 'needs_input', codes: ['needs_input'], price_usd: null, networks: [], ms: 0 };
        return;
      }
      // The declared method goes first, the other one after it: a wrong declaration shouldn't mark a live endpoint dead.
      const target = r.probe || r.url;
      const host = new URL(target).host;
      const p = await preflight(target, { safeFetch: fetcher, preferMethod: r.method || learned.get(host), rpcUrl, sanctions });
      if (!r.method && p.method === 'POST') learned.set(host, 'POST');
      const best = p.recommended_option === null ? null : p.options[p.recommended_option];
      const limited = fetcher.rateLimited.has(new URL(target).href) && p.verdict !== 'go' && p.verdict !== 'caution';
      const has = (code) => p.reasons.some((x) => x.code === code);
      results[i] = {
        key: r.key,
        url: r.url,
        ...(r.probe ? { probe: r.probe } : {}),
        method: p.method,
        // Input checked before the 402 (POST 400/422 to {}, and no example in the seller's openapi.json): not judged, as for MPP.
        // A free trial that answered every time: not judged either, the last real verdict stays. A timeout next to a
        // 404/405 for the other method: unreachable, as when the check itself fails.
        verdict: limited ? 'rate_limited' : p.verdict === 'caution' && has('needs_input') ? 'needs_input' : has('free_trial') ? 'not_checked' : has('unreachable') ? 'error' : p.verdict,
        codes: limited ? ['rate_limited'] : p.reasons.filter((x) => x.level !== 'info').map((x) => x.code),
        price_usd: best?.usd ?? null,
        networks: [...new Set(p.options.filter((o) => o.payable).map((o) => o.network))],
        ...unpayableOf(p.options),
        ...payTosOf(p.options),
        ms: Date.now() - started,
      };
    } catch (err) {
      results[i] = { key: r.key, url: r.url, ...(r.p ? { p: r.p } : {}), method: r.method ?? null, verdict: 'error', codes: ['unreachable'], error: String(err.message).slice(0, 120), price_usd: null, networks: [], ms: Date.now() - started };
    }
    done++;
    if (onProgress && done % 500 === 0) onProgress(done, resources.length);
  });
  if (onStatuses) onStatuses(statusReport(fetcher, statusTop));
  if (onSlowHosts && cut.size) onSlowHosts([...cut].map(([host, why]) => ({ host, why, skipped: results.filter((x) => x?.verdict === 'not_checked' && hostOf(x) === host).length })));
  return results;
}

// Rolls today's results into the 30-day index. Each history string lines up
// with index.days (one letter per day); re-running on the same date replaces
// that day. A resource not seen for the whole window is dropped.
function mergeIndex(previous, results, { date, descriptions = new Map() } = {}) {
  const prevDays = previous?.days || [];
  const days = [...prevDays.filter((d) => d !== date), date].sort().slice(-HISTORY_DAYS);
  const byDate = (old) => {
    const map = new Map();
    prevDays.forEach((d, i) => map.set(d, old?.h?.[i] ?? '-'));
    return map;
  };
  const history = (old, todayLetter) => {
    const map = byDate(old);
    return days.map((d) => (d === date ? todayLetter : map.get(d) ?? '-')).join('');
  };
  const today = new Map(results.map((r) => [r.key, r]));
  const resources = {};

  for (const [key, old] of Object.entries(previous?.resources || {})) {
    if (today.has(key)) continue;
    const h = history(old, '-');
    if (/[^-]/.test(h)) resources[key] = { ...old, h };
  }
  for (const r of results) {
    const old = previous?.resources?.[r.key];
    resources[r.key] = {
      url: r.url,
      ...(r.probe ? { probe: r.probe } : {}),
      ...(r.p ? { p: r.p } : {}),
      m: r.method,
      h: history(old, LETTER[r.verdict] || 'x'),
      // Not checked today (its seller was too slow): keep the last real verdict for pages and lookups.
      last: r.verdict === 'not_checked' && old?.last ? old.last : { verdict: r.verdict, codes: r.codes, price_usd: r.price_usd, networks: r.networks, ...(r.unpayable ? { unpayable: r.unpayable } : {}), ms: r.ms },
      d: descriptions.get(r.key) || old?.d || '',
    };
  }
  return { version: 1, updated: new Date().toISOString(), days, resources };
}

// Track record from a history string: checked days, days payable (go or
// caution), and the current streak of the latest outcome.
function trackRecord(h) {
  const seen = [...(h || '')].filter((c) => c !== '-');
  if (seen.length === 0) return null;
  const ok = seen.filter((c) => c === 'g' || c === 'c').length;
  let streak = 0;
  for (let i = seen.length - 1; i >= 0 && (seen[i] === 'g' || seen[i] === 'c') === (seen[seen.length - 1] === 'g' || seen[seen.length - 1] === 'c'); i--) streak++;
  return { days_checked: seen.length, days_payable: ok, payable_ratio: Math.round((ok / seen.length) * 100) / 100, last: seen[seen.length - 1], streak };
}

function summarize(index) {
  const counts = { g: 0, c: 0, n: 0, x: 0 };
  const codes = {};
  for (const r of Object.values(index.resources)) {
    const last = r.h.slice(-1);
    if (last in counts) counts[last]++;
    if (last !== '-') for (const c of r.last?.codes || []) codes[c] = (codes[c] || 0) + 1;
  }
  // Resources whose payout address is on the OFAC SDN list, or a burn address (always reported, also when it is 0).
  return { date: index.days[index.days.length - 1], resources: Object.keys(index.resources).length, today: counts, top_reasons: Object.entries(codes).sort((a, b) => b[1] - a[1]).slice(0, 10), payto_sanctioned: codes.payto_sanctioned || 0, payto_burn: codes.payto_burn || 0, sanctions: index.sanctions ?? null };
}

// The index as lines for index.ndjson: a header (everything but the resources), then one [key, resource] per line.
// The server reads it line by line (lib/trust-index.js readIndex).
function* indexLines(index) {
  const { resources, ...head } = index;
  yield JSON.stringify(head);
  for (const [key, resource] of Object.entries(resources || {})) yield JSON.stringify([key, resource]);
}

module.exports = { indexLines, shareOf, hostOf, sampleOf, unpayableOf, payTosOf, interleave, loadCatalog, loadCatalogItems, loadMppCatalog, loadGoPlausibleCatalog, loadCircleCatalog, loadNohumansCatalog, loadPayApiCatalog, loadXrplHub, nextPageData, hubResources, loadSubmissions, submittedResources, mppCheck, politeFetch, retryAfterMs, scan, statusReport, mergeIndex, trackRecord, summarize, USER_AGENT, HISTORY_DAYS };
