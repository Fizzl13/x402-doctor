// Sellers add their own endpoint to the x402 Trust Index (POST /api/trust/submit). Doctor first checks that it answers
// 402 with a payment challenge (x402, MPP or L402); the next daily scan (scripts/trust-scan.js) then picks it up from
// GET /api/trust/submitted. Accepted submissions are kept in the usage log repo (events/trust-submit/<day>.jsonl), so
// they survive a restart without a new store or key. The scan writes them to submitted.json, apart from the registry
// index, so the public numbers keep counting what the registries list.

'use strict';

const { keyOf } = require('./bazaar-index');

const SERVICE = 'trust-submit';
const MAX_PER_HOST = 25;
const MAX_URL = 300; // the usage log cuts longer strings
const DAYS = 30;
const CACHE_MS = 10 * 60 * 1000;
const RETRY_MS = 60 * 1000;

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

function createTrustSubmissions({ usageLog, usageReader, publicUrl = 'https://x402-doctor.fizzl.eu', now = () => Date.now(), log = console } = {}) {
  // Accepted by this process: the log is read back at most every 10 minutes, and not at all without a token.
  const recent = new Map(); // key -> submission
  let cache = null; // { until, events }
  let loading = null;

  function readLog() {
    if (!loading) {
      loading = (async () => {
        try {
          const data = usageReader && usageReader.configured ? await usageReader.load({ days: DAYS, service: SERVICE }) : { events: [] };
          cache = { until: now() + CACHE_MS, events: (data.events || []).filter((e) => e.route === 'trust submit' && e.result && e.result.accepted && e.input && e.input.url) };
        } catch (err) {
          log.error(`[trust-submissions] reading the log failed: ${err.message}`);
          cache = { until: now() + RETRY_MS, events: cache ? cache.events : [] };
        }
      })().finally(() => {
        loading = null;
      });
    }
    return loading;
  }

  // Every accepted submission of the last 30 days, oldest first, one per origin + path.
  async function list() {
    if (!cache || now() > cache.until) await readLog();
    const byKey = new Map();
    const logged = [...cache.events].sort((a, b) => (a.t < b.t ? -1 : 1));
    for (const e of logged) {
      let key;
      try { key = keyOf(e.input.url); } catch { continue; }
      if (!byKey.has(key)) byKey.set(key, { url: e.input.url, ...(e.input.method ? { method: e.input.method } : {}), ...(e.input.p ? { p: e.input.p } : {}), t: e.t });
    }
    for (const [key, s] of recent) if (!byKey.has(key)) byKey.set(key, s);
    return [...byKey.values()];
  }

  async function find(url) {
    const key = keyOf(url);
    return (await list()).find((s) => keyOf(s.url) === key) || null;
  }

  // Answers { status, body } for POST /api/trust/submit. check(url) is the pre-payment check (lib/preflight.js);
  // trustIndex says what the index already has.
  async function submit(target, { check, trustIndex }) {
    let u;
    try {
      u = new URL(String(target));
    } catch {
      return { status: 400, body: { error: 'send {"url": "https://…"}: the full URL of the paid endpoint' } };
    }
    if (u.protocol !== 'https:') return { status: 400, body: { error: 'the URL must start with https://' } };
    const href = u.href;
    if (href.length > MAX_URL) return { status: 400, body: { error: `the URL is longer than ${MAX_URL} characters` } };
    const checkUrl = `${publicUrl}/?url=${encodeURIComponent(href)}`;

    const record = trustIndex ? await trustIndex.lookup(href, { waitMs: 5000 }) : null;
    if (record) {
      return { status: 200, body: { status: record.submitted ? 'submitted' : 'listed', url: href, message: record.submitted ? 'Already added: the daily scan checks it.' : 'Already in the Trust Index: a registry lists it and the daily scan checks it.' } };
    }
    const earlier = await find(href);
    if (earlier) return { status: 200, body: { status: 'submitted', url: href, submitted_at: earlier.t, message: 'Already added: the next daily scan checks it.' } };

    const host = u.host;
    const keys = new Set((await list()).filter((s) => hostOf(s.url) === host).map((s) => keyOf(s.url)));
    for (const k of trustIndex && trustIndex.submittedKeys ? trustIndex.submittedKeys(host) : []) keys.add(k);
    if (keys.size >= MAX_PER_HOST) {
      return { status: 429, body: { error: `${host} already has ${MAX_PER_HOST} endpoints added by hand. List the rest in the CDP Bazaar, Circle's Agent Marketplace, GoPlausible's discovery list or the MPP directory.` } };
    }

    const p = await check(href);
    if (!p || !Array.isArray(p.options) || p.options.length === 0) {
      const why = (p && p.reasons ? p.reasons.filter((r) => r.level === 'no_go').map((r) => r.message) : [])[0] || 'No payment challenge came back.';
      return { status: 422, body: { error: `Not added: ${why}`, check: checkUrl } };
    }
    const mppOnly = p.options.every((o) => o.protocol === 'mpp');
    const method = p.method === 'POST' ? 'POST' : 'GET';
    const entry = { url: href, method, ...(mppOnly ? { p: 'mpp' } : {}), t: new Date(now()).toISOString() };
    recent.set(keyOf(href), entry);
    if (usageLog) {
      usageLog.record({ route: 'trust submit', via: 'web', input: { url: href, method, ...(mppOnly ? { p: 'mpp' } : {}) }, result: { accepted: true, verdict: p.verdict } });
      // One commit per submission (they are rare): nothing waits in memory for a restart to lose.
      if (usageLog.flush) usageLog.flush().catch(() => {});
    }
    return { status: 201, body: { status: 'added', url: href, verdict: p.verdict, message: 'Added. The next daily scan checks it, and from then on it has a track record here.', check: checkUrl } };
  }

  return { list, find, submit };
}

module.exports = { createTrustSubmissions, MAX_PER_HOST, SERVICE };
