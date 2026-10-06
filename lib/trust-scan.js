// x402 Trust Index: a daily scan of every resource in the CDP Bazaar (plus the MPP directory and the GoPlausible
// facilitator's Algorand listings) with the
// pre-payment check, kept as a rolling 30-day history per resource.
//
// Politeness: the scan only ever triggers the 402 challenge (it never pays),
// at most PER_HOST requests run against one host at a time, /openapi.json is
// fetched once per origin, Solana payout lookups are cached, and every request
// carries a User-Agent that explains the scan. A 429 or 503 is retried once after
// the seller's Retry-After (capped, with jitter); a seller that is still rate
// limited is recorded as not checked that day, never as down.

const { preflight } = require('./preflight');
const { keyOf } = require('./bazaar-index');
const { parseChallenges, hasPayment } = require('./mpp');

const DISCOVERY_URL = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources';
// The MPP (Stripe + Tempo) service directory: services with their endpoints, method and path.
const MPP_DIRECTORY_URL = 'https://mpp.dev/api/services';
// The GoPlausible facilitator's discovery list: mostly x402 on Algorand (USDC ASA), which the CDP Bazaar doesn't list.
const GOPLAUSIBLE_DISCOVERY_URL = 'https://facilitator.goplausible.xyz/discovery/resources';
const USER_AGENT = 'x402-doctor-trust-scan/1.0 (+https://x402-doctor.fizzl.eu/trust; probes the 402 challenge once a day, never pays)';
const HISTORY_DAYS = 30;
const RETRY_STATUSES = new Set([429, 503]);
const MAX_RETRY_AFTER_MS = 60_000;
const DEFAULT_RETRY_AFTER_MS = 5_000;
const HOST_WAIT_BUDGET_MS = 120_000; // total Retry-After waiting per host per scan

// One letter per day: g = go, c = caution, n = no_go, x = unreachable or
// error, - = not checked that day.
// rate_limited counts as '-': the seller asked us to come back later.
// Not judged today ('-'): rate limited, or an MPP endpoint that checks its input before asking for payment.
const LETTER = { go: 'g', caution: 'c', no_go: 'n', rate_limited: '-', needs_input: '-' };

// Retry-After is seconds or an HTTP date; missing or unreadable falls back to a short default.
function retryAfterMs(value, now = Date.now()) {
  if (value == null || value === '') return DEFAULT_RETRY_AFTER_MS;
  const ms = /^\d+$/.test(String(value).trim()) ? Number(value) * 1000 : Date.parse(value) - now;
  if (!Number.isFinite(ms)) return DEFAULT_RETRY_AFTER_MS;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, ms));
}

async function loadCatalog({ url = DISCOVERY_URL, fetchImpl = fetch, maxPages = 200 } = {}) {
  const items = [];
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchImpl(`${url}?type=http&limit=500&offset=${page * 500}`, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`CDP discovery HTTP ${res.status}`);
    const batch = (await res.json()).items || [];
    items.push(...batch);
    if (batch.length < 500) break;
  }
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
    byKey.set(key, { key, url: item.resource, method: declared === 'GET' || declared === 'POST' ? declared : undefined, description: String(item.description || '').slice(0, 200) });
  }
  return [...byKey.values()];
}

// The GoPlausible discovery list as scan entries (checked like Bazaar resources, with the x402 preflight). Its
// items name the URL resourceUrl and carry the declared method; pages follow pagination.total. https only, one
// entry per origin + path.
async function loadGoPlausibleCatalog({ url = GOPLAUSIBLE_DISCOVERY_URL, fetchImpl = fetch, maxPages = 40 } = {}) {
  const byKey = new Map();
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchImpl(`${url}?limit=500&offset=${page * 500}`, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(30000) });
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
    const total = Number(data.pagination?.total);
    if (batch.length < 500 || (Number.isFinite(total) && (page + 1) * 500 >= total)) break;
  }
  return [...byKey.values()];
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

// The daily check for an MPP endpoint: trigger the 402, read the Payment challenge, never pay.
// go = a well-formed challenge; caution = payable but something looks off; no_go = no 402 or a challenge that can't be paid.
async function mppCheck(r, fetcher, { now = Date.now() } = {}) {
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
    payable++;
    networks.push(m === 'evm' ? `mpp:evm:${q.methodDetails.chainId}` : `mpp:${m}`);
    // USD price where the unit is known: 6-decimal stablecoins (USDC and Tempo's USD tokens), or Stripe in USD cents.
    const usd = m === 'stripe' ? (String(q.currency).toLowerCase() === 'usd' ? Number(q.amount) / 100 : null) : (q.methodDetails?.decimals ?? 6) === 6 ? Number(q.amount) / 1e6 : null;
    if (usd !== null && (price === null || usd < price)) price = usd;
  }
  const verdict = payable === 0 ? 'no_go' : codes.size ? 'caution' : 'go';
  return { verdict, codes: [...codes], method: r.method, price_usd: price, networks: [...new Set(networks)] };
}

// safeFetch wrapper: User-Agent, per-host concurrency limit, one /openapi.json
// fetch per origin, and one Retry-After retry on 429/503. URLs that stay rate
// limited are collected in fetcher.rateLimited.
function politeFetch(safeFetch, { perHost = 2, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), jitterMs = 1000, hostBudgetMs = HOST_WAIT_BUDGET_MS } = {}) {
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
  const fetcher = (target, options = {}) => {
    const url = new URL(target);
    const once = () => safeFetch(url.href, { ...options, headers: { ...(options.headers || {}), 'user-agent': USER_AGENT } });
    // The wait happens inside the host's slot, so a busy seller gets fewer requests, not more.
    const run = () => withSlot(url.host, async () => {
      const first = await once();
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
  return fetcher;
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

async function scan(resources, { safeFetch, rpcUrl, concurrency = 24, perHost = 2, onProgress, sleep } = {}) {
  const fetcher = politeFetch(safeFetch, { perHost, ...(sleep ? { sleep } : {}) });
  const results = new Array(resources.length);
  let done = 0;
  await mapLimit(resources, concurrency, async (r, i) => {
    const started = Date.now();
    try {
      if (r.p === 'mpp') {
        const m = await mppCheck(r, fetcher);
        if (m) {
          const limited = fetcher.rateLimited.has(new URL(r.url).href) && m.verdict === 'no_go';
          results[i] = { key: r.key, url: r.url, p: 'mpp', method: m.method, verdict: limited ? 'rate_limited' : m.verdict, codes: limited ? ['rate_limited'] : m.codes, price_usd: m.price_usd, networks: m.networks, ms: Date.now() - started };
          return;
        }
      }
      // The declared method goes first, the other one after it: a wrong declaration shouldn't mark a live endpoint dead.
      const p = await preflight(r.url, { safeFetch: fetcher, preferMethod: r.method, rpcUrl });
      const best = p.recommended_option === null ? null : p.options[p.recommended_option];
      const limited = fetcher.rateLimited.has(new URL(r.url).href) && p.verdict !== 'go' && p.verdict !== 'caution';
      results[i] = {
        key: r.key,
        url: r.url,
        method: p.method,
        verdict: limited ? 'rate_limited' : p.verdict,
        codes: limited ? ['rate_limited'] : p.reasons.filter((x) => x.level !== 'info').map((x) => x.code),
        price_usd: best?.usd ?? null,
        networks: [...new Set(p.options.filter((o) => o.payable).map((o) => o.network))],
        ...unpayableOf(p.options),
        ms: Date.now() - started,
      };
    } catch (err) {
      results[i] = { key: r.key, url: r.url, ...(r.p ? { p: r.p } : {}), method: r.method ?? null, verdict: 'error', codes: ['unreachable'], error: String(err.message).slice(0, 120), price_usd: null, networks: [], ms: Date.now() - started };
    }
    done++;
    if (onProgress && done % 500 === 0) onProgress(done, resources.length);
  });
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
      ...(r.p ? { p: r.p } : {}),
      m: r.method,
      h: history(old, LETTER[r.verdict] || 'x'),
      last: { verdict: r.verdict, codes: r.codes, price_usd: r.price_usd, networks: r.networks, ...(r.unpayable ? { unpayable: r.unpayable } : {}), ms: r.ms },
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
  return { date: index.days[index.days.length - 1], resources: Object.keys(index.resources).length, today: counts, top_reasons: Object.entries(codes).sort((a, b) => b[1] - a[1]).slice(0, 10) };
}

module.exports = { unpayableOf, loadCatalog, loadMppCatalog, loadGoPlausibleCatalog, mppCheck, politeFetch, retryAfterMs, scan, mergeIndex, trackRecord, summarize, USER_AGENT, HISTORY_DAYS };
