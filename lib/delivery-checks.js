// Delivery check: anyone (usually the seller) pays x402 Doctor to have one x402 endpoint bought once, with the
// example input its own listing declares, and gets a public answer to "paid and delivered?", the charge measured
// on chain.
//
// No purchase runs on this server and no wallet key is here. The paid route only checks the endpoint before
// payment and queues the job (Redis, CREDITS_REDIS_URL). .github/workflows/delivery-check.yml takes the queue from
// GET /api/v1/delivery-check/queue every 10 minutes, buys with the spot-buy wallet (SPOT_BUY_KEY, the same steps
// as the weekly spot-buy: fresh preflight with the payout screen, the charge measured on chain) and writes the
// result to the delivery-data branch, which this server reads back (lib/delivery-results.js).

const { randomBytes } = require('crypto');
const { normalizeRedisUrl } = require('./credits');

const DELIVERY_ROUTE = '/api/v1/delivery-check';
const QUEUE_ROUTE = `${DELIVERY_ROUTE}/queue`;
const DEFAULT_DELIVERY_PRICE = '$0.25';
const CAP_USD = 0.1; // the endpoint's own price, paid from the wallet (the spot-buy's hard ceiling)
const DAILY_MAX = 20; // jobs queued per UTC day, whoever orders them
const JOB_TTL_DAYS = 30;
const BASE = 'eip155:8453';
const OWN_HOST = /(^|\.)fizzl\.eu$/i;
// The example input the route declares (Bazaar, openapi): someone else's endpoint, since fizzl.eu ones are refused.
// CoinCap's: "go" every day of the Trust Index's 20-day history and delivered in the spot-buy of 12 Oct 2026, $0.002.
const DELIVERY_EXAMPLE = 'https://rest.coincap.io/v3/agentFriendly/full_assets_by_slug';

const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const newId = () => randomBytes(8).toString('base64url').replace(/[-_]/g, 'x').slice(0, 10).toLowerCase();
const isId = (id) => typeof id === 'string' && /^[a-z0-9]{10}$/.test(id);

// In-memory store, for tests and local runs only.
function memoryStore({ now = () => Date.now() } = {}) {
  const jobs = new Map();
  const days = new Map();
  return {
    ready: true,
    async add(job) { jobs.set(job.id, job); days.set(day(now()), (days.get(day(now())) || 0) + 1); },
    async update(id, patch) { const j = jobs.get(id); if (j) jobs.set(id, { ...j, ...patch }); },
    async get(id) { return jobs.get(id) || null; },
    async list() { return [...jobs.values()].filter((j) => now() - Date.parse(j.queued_at) < JOB_TTL_DAYS * 86400e3).sort((a, b) => b.queued_at.localeCompare(a.queued_at)); },
    async countToday() { return days.get(day(now())) || 0; },
  };
}

// Redis, the same instance as the credits (CREDITS_REDIS_URL). ready stays false until the connection works; the
// route then answers 503 before payment.
function redisStore(rawUrl, { log = console, connect = null } = {}) {
  const url = normalizeRedisUrl(rawUrl);
  const store = { ready: false };
  if (!url) return store;
  let client = null;
  const need = () => { if (!store.ready) throw new Error('delivery store not connected'); return client; };
  (async () => {
    const { createClient } = connect ? { createClient: connect } : require('redis');
    client = createClient({ url, socket: { reconnectStrategy: (tries) => Math.min(tries * 200, 5000) } });
    client.on('error', (err) => log.warn(`[delivery] redis: ${err.message}`));
    await client.connect();
    store.ready = true;
  })().catch((err) => log.warn(`[delivery] off: ${err.message}`));
  Object.assign(store, {
    async add(job) {
      const c = need();
      await c.set(`doctor-delivery:job:${job.id}`, JSON.stringify(job), { EX: JOB_TTL_DAYS * 86400 });
      await c.zAdd('doctor-delivery:jobs', { score: Date.parse(job.queued_at), value: job.id });
      await c.zRemRangeByScore('doctor-delivery:jobs', 0, Date.now() - JOB_TTL_DAYS * 86400e3);
      const k = `doctor-delivery:day:${day()}`;
      await c.incr(k);
      await c.expire(k, 2 * 86400);
    },
    async update(id, patch) {
      const c = need();
      const raw = await c.get(`doctor-delivery:job:${id}`);
      if (raw) await c.set(`doctor-delivery:job:${id}`, JSON.stringify({ ...JSON.parse(raw), ...patch }), { KEEPTTL: true });
    },
    async get(id) { const raw = await need().get(`doctor-delivery:job:${id}`); return raw ? JSON.parse(raw) : null; },
    async list() {
      const c = need();
      const ids = await c.zRange('doctor-delivery:jobs', 0, 199, { REV: true });
      if (!ids.length) return [];
      const raws = await c.mGet(ids.map((id) => `doctor-delivery:job:${id}`));
      return raws.filter(Boolean).map((r) => JSON.parse(r));
    },
    async countToday() { return Number(await need().get(`doctor-delivery:day:${day()}`)) || 0; },
  });
  return store;
}

// The pre-payment checks: one public https endpoint, not ours, that a buyer could pay on Base within the cap.
// { status: 0, … } when it can be checked, else { status, error } to answer before any payment; form marks a request
// that is malformed whatever the endpoint's state (validate answers those to a probe without payment too).
async function deliveryError(query, { store, runPreflight }) {
  const { url, method } = query;
  if (Array.isArray(url)) return { status: 400, form: true, error: 'give one url' };
  let parsed;
  try { parsed = new URL(String(url)); } catch { return { status: 400, form: true, error: 'url is not a valid URL' }; }
  if (parsed.protocol !== 'https:') return { status: 400, form: true, error: 'url must be https' };
  if (OWN_HOST.test(parsed.hostname)) return { status: 400, form: true, error: 'fizzl.eu endpoints are not checked this way' };
  if (method !== undefined && !['GET', 'POST'].includes(method)) return { status: 400, form: true, error: 'method must be GET or POST' };
  if (!store?.ready) return { status: 503, error: 'delivery checks are not available right now; nothing was charged' };
  if (await store.countToday() >= DAILY_MAX) return { status: 503, error: `today's ${DAILY_MAX} delivery checks are taken; try again tomorrow (UTC); nothing was charged` };
  const pf = await runPreflight(parsed.href, { method, network: BASE, maxUsd: CAP_USD });
  const best = pf.recommended_option === null || pf.recommended_option === undefined ? null : pf.options?.[pf.recommended_option];
  if (pf.verdict !== 'go' || !best || best.network !== BASE) {
    return { status: 400, error: `this endpoint can't be bought now (${pf.summary || pf.verdict}); a delivery check needs a "go" from the pre-payment check, payable in USDC on Base`, preflight: { verdict: pf.verdict, reasons: (pf.reasons || []).filter((r) => r.level !== 'info').map((r) => r.code) } };
  }
  if (!(best.usd > 0 && best.usd <= CAP_USD)) return { status: 400, error: `the endpoint costs $${best.usd}; delivery checks buy endpoints of at most $${CAP_USD}` };
  return { status: 0, url: parsed.href, method: method || null, price_usd: best.usd };
}

// The settlement the x402 middleware reported (PAYMENT-RESPONSE): the transaction ('' when it named none), or null
// when the payment was not settled.
function settledTx(res) {
  const header = res.getHeader('payment-response') || res.getHeader('x-payment-response');
  if (!header) return null;
  try {
    const r = JSON.parse(Buffer.from(String(header), 'base64').toString('utf8'));
    return r.success === false ? null : String(r.transaction || '');
  } catch { return null; }
}

// A job as the queue and the status route show it, with its result once the workflow has run it.
function viewOf(job, result, publicUrl) {
  return {
    id: job.id,
    url: job.url,
    method: job.method,
    status: result ? 'done' : job.settled === false ? 'awaiting_payment' : 'queued',
    queued_at: job.queued_at,
    endpoint_price_usd: job.price_usd,
    ...(result ? { result } : { eta: 'usually within 30 minutes' }),
    status_url: `${publicUrl}${DELIVERY_ROUTE}/${job.id}`,
  };
}

// The routes. validate runs before the paywall (a bare probe goes on to the 402, as on the other paid routes);
// order is the paid handler; free is a router for the queue and the status pages, mounted before the paywall.
// A probe without a payment only wants the 402: agents, the CDP Bazaar's validator, indexer and health probe (which
// give up after 10 seconds), and uptime monitors that fill url with a placeholder such as https://example.com. Its
// check before payment (a fresh pre-payment check of the endpoint, often 4 s, sometimes more) gets PROBE_BUDGET_MS;
// when it takes longer the probe goes on to the 402. Without a payment only a malformed request is refused here; an
// endpoint that can't be bought now, a full day or the hourly limit still get the 402. A request that carries a
// payment always waits for the whole check and is refused on any of them before anything settles, so nobody pays
// for an endpoint that cannot be bought (and the pre-payment check is cached by then). A caller that wants that
// answer before it pays sends X-Delivery-Precheck: the homepage does, before it asks the visitor's wallet.
const PROBE_BUDGET_MS = 5000;
const headerOf = (req, name) => (typeof req.get === 'function' ? req.get(name) : req.headers?.[name]);
const carriesPayment = (req) => {
  const header = (name) => headerOf(req, name);
  return Boolean(header('payment-signature') || header('x-payment') || header('x-credit-key') || /^payment\s/i.test(header('authorization') || ''));
};
const wantsPrecheck = (req) => Boolean(headerOf(req, 'x-delivery-precheck'));

function createDelivery({ express, store, results, runPreflight, publicUrl = 'https://x402-doctor.fizzl.eu', now = () => Date.now(), checksPerHour = 20, onSettled = null, probeBudgetMs = PROBE_BUDGET_MS }) {
  // The check before payment runs a pre-payment check for free, so it is rate-limited per caller (like the free web
  // check); the paid retry passes through it too, hence the room.
  const seen = new Map();
  const limited = (ip) => {
    const hour = Math.floor(now() / 3600e3);
    const e = seen.get(ip);
    const n = e && e.hour === hour ? e.n + 1 : 1;
    seen.set(ip, { hour, n });
    if (seen.size > 10000) for (const [k, v] of seen) if (v.hour !== hour) seen.delete(k);
    return n > checksPerHour;
  };

  // The steps of an order, shared by the HTTP route and the MCP tool (lib/mcp.js x402_delivery_check): the check
  // before payment (rate-limited per caller), the job queued while the payment is pending, released once it settled.
  async function precheck(query, ip = 'unknown') {
    if (limited(ip)) return { status: 429, error: `at most ${checksPerHour} delivery-check requests an hour; nothing was charged` };
    return deliveryError(query, { store, runPreflight });
  }
  async function queue({ url, method, price_usd: priceUsd }) {
    const job = { id: newId(), url, method, price_usd: priceUsd, queued_at: new Date(now()).toISOString(), settled: false };
    await store.add(job);
    return job;
  }
  // Settled: the job is in the queue now, so the workflow can be started for it (lib/delivery-dispatch.js).
  async function settle(job, tx) {
    await store.update(job.id, { settled: true, payment_tx: tx || null });
    onSettled?.(job);
  }
  async function status(id) {
    if (!isId(id)) return null;
    const [job, result] = await Promise.all([store?.ready ? store.get(id) : null, results ? results.forId(id, { waitMs: 3000 }) : null]);
    if (!job && !result) return null;
    const base = job || { id, url: result.url, method: null, queued_at: result.queued_at || null, price_usd: result.price_usd ?? null };
    return viewOf(base, result, publicUrl);
  }

  async function validate(req, res, next) {
    const { url } = req.query;
    if (url === undefined || (typeof url === 'string' && url.trim() === '')) return next();
    // A Fizzl Pass order (lib/pass-perks.js) may be paid from the pass's free checks: check before that too.
    const strict = carriesPayment(req) || wantsPrecheck(req) || Boolean(headerOf(req, 'x-fizzl-pass'));
    try {
      const pending = precheck(req.query, req.ip || 'unknown');
      let timer;
      const check = strict ? await pending : await Promise.race([pending, new Promise((resolve) => { timer = setTimeout(resolve, probeBudgetMs, null); })]);
      clearTimeout(timer);
      if (check === null) {
        pending.catch(() => {}); // still running: it warms the pre-payment cache for the paid request
        return next(); // a slow check on a probe without payment: on to the 402
      }
      if (check.status && !strict && !check.form) return next(); // refused once a payment comes, before it settles
      if (check.status) return res.status(check.status).json({ error: check.error, ...(check.preflight ? { preflight: check.preflight } : {}) });
      req.deliveryJob = check;
      next();
    } catch (err) {
      if (!strict) return next();
      res.status(502).json({ error: `could not check the endpoint (${err.message}); nothing was charged` });
    }
  }

  async function order(req, res) {
    if (!req.deliveryJob) return res.status(400).json({ error: 'url is required, e.g. ?url=https://api.example.com/paid' });
    let job;
    try {
      job = await queue(req.deliveryJob);
    } catch (err) {
      return res.status(503).json({ error: `could not queue the check (${err.message}); the payment is not settled` });
    }
    // The x402 middleware settles after this answer. Only a settled payment releases the job to the queue, so a
    // payment that verifies but fails to settle never gets an endpoint bought.
    res.on('finish', () => {
      // One of a Fizzl Pass's free checks this month (lib/pass-perks.js): no payment to wait for.
      const tx = req.fizzlCredits?.perk === 'delivery-check' ? `fizzl-pass-${req.fizzlCredits.tier}` : settledTx(res);
      if (res.statusCode !== 200 || tx === null) return;
      settle(job, tx).catch((err) => console.error('[delivery] settle mark failed:', err.message));
    });
    res.json({ ...viewOf(job, null, publicUrl), results: 'https://github.com/Fizzl13/x402-doctor/tree/delivery-data' });
  }

  const free = express.Router();
  // The workflow's work list: queued jobs without a result yet, oldest first.
  free.get(QUEUE_ROUTE, async (_req, res) => {
    if (!store?.ready) return res.status(503).json({ error: 'delivery store not available' });
    try {
      const [jobs, done] = await Promise.all([store.list(), results ? results.ids({ waitMs: 5000 }) : new Set()]);
      const pending = jobs.filter((j) => j.settled && !done.has(j.id)).sort((a, b) => a.queued_at.localeCompare(b.queued_at));
      res.set('cache-control', 'no-store').json({ cap_usd: CAP_USD, jobs: pending.map((j) => ({ id: j.id, url: j.url, method: j.method, queued_at: j.queued_at })) });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });
  free.get(`${DELIVERY_ROUTE}/:id`, async (req, res) => {
    try {
      const view = await status(req.params.id);
      if (!view) return res.status(404).json({ error: 'unknown delivery check' });
      res.set('cache-control', 'no-store').json(view);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  return { validate, order, free, precheck, queue, settle, status, view: (job) => viewOf(job, null, publicUrl), ready: () => Boolean(store?.ready) };
}

module.exports = { createDelivery, deliveryError, memoryStore, redisStore, viewOf, isId, settledTx, DELIVERY_ROUTE, QUEUE_ROUTE, DEFAULT_DELIVERY_PRICE, CAP_USD, DAILY_MAX, DELIVERY_EXAMPLE };
