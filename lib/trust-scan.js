// x402 Trust Index: a daily scan of every resource in the CDP Bazaar with the
// pre-payment check, kept as a rolling 30-day history per resource.
//
// Politeness: the scan only ever triggers the 402 challenge (it never pays),
// at most PER_HOST requests run against one host at a time, /openapi.json is
// fetched once per origin, Solana payout lookups are cached, and every request
// carries a User-Agent that explains the scan.

const { preflight } = require('./preflight');
const { keyOf } = require('./bazaar-index');

const DISCOVERY_URL = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources';
const USER_AGENT = 'x402-doctor-trust-scan/1.0 (+https://x402-doctor.onrender.com/trust; probes the 402 challenge once a day, never pays)';
const HISTORY_DAYS = 30;

// One letter per day: g = go, c = caution, n = no_go, x = unreachable or
// error, - = not checked that day.
const LETTER = { go: 'g', caution: 'c', no_go: 'n' };

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

// safeFetch wrapper: User-Agent, per-host concurrency limit, and one
// /openapi.json fetch per origin.
function politeFetch(safeFetch, { perHost = 2 } = {}) {
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

  return (target, options = {}) => {
    const url = new URL(target);
    const run = () => withSlot(url.host, () => safeFetch(url.href, { ...options, headers: { ...(options.headers || {}), 'user-agent': USER_AGENT } }));
    if (url.pathname === '/openapi.json') {
      if (!openapi.has(url.origin)) openapi.set(url.origin, run().catch((err) => ({ status: 0, text: '', error: err.message })));
      return openapi.get(url.origin);
    }
    return run();
  };
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

async function scan(resources, { safeFetch, rpcUrl, concurrency = 24, perHost = 2, onProgress } = {}) {
  const fetcher = politeFetch(safeFetch, { perHost });
  const results = new Array(resources.length);
  let done = 0;
  await mapLimit(resources, concurrency, async (r, i) => {
    const started = Date.now();
    try {
      const p = await preflight(r.url, { safeFetch: fetcher, method: r.method, rpcUrl });
      const best = p.recommended_option === null ? null : p.options[p.recommended_option];
      results[i] = {
        key: r.key,
        url: r.url,
        method: p.method,
        verdict: p.verdict,
        codes: p.reasons.filter((x) => x.level !== 'info').map((x) => x.code),
        price_usd: best?.usd ?? null,
        networks: [...new Set(p.options.filter((o) => o.payable).map((o) => o.network))],
        ms: Date.now() - started,
      };
    } catch (err) {
      results[i] = { key: r.key, url: r.url, method: r.method ?? null, verdict: 'error', codes: ['unreachable'], error: String(err.message).slice(0, 120), price_usd: null, networks: [], ms: Date.now() - started };
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
      m: r.method,
      h: history(old, LETTER[r.verdict] || 'x'),
      last: { verdict: r.verdict, codes: r.codes, price_usd: r.price_usd, networks: r.networks, ms: r.ms },
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

module.exports = { loadCatalog, politeFetch, scan, mergeIndex, trackRecord, summarize, USER_AGENT, HISTORY_DAYS };
