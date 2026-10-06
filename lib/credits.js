// Prepaid credit packs: an agent buys 1000 or 10000 credits in one x402 payment
// (cheaper than paying per call) and gets a credit key. Sending that key in the
// x-credit-key header then pays for calls without a new payment. A credit is a
// tenth of a cent ($0.001, the price of a preflight), so a preflight costs 1, a
// batch 5, a deep preflight or a diagnosis 10 and the fix 50. A call that fails
// (any 4xx or 5xx) gives its credits back. With no key, a wrong key or too few
// credits the normal 402 applies.
//
// Balances live in Redis (CREDITS_REDIS_URL, a persistent instance such as
// Upstash; Render only; the same instance as presign-guard is fine, the keys are
// apart). The connection is made in the background; until it is up, packs are
// not sold (503), so nobody can buy credits that would vanish. Only a SHA-256 of
// each key is stored, never the key itself.
'use strict';

const { createHash, randomBytes } = require('node:crypto');

const CREDIT_HEADER = 'x-credit-key';
const CREDIT_USD = 0.001;
const PACKS = {
  1000: { credits: 1000, price: '0.80' },
  10000: { credits: 10000, price: '7.00' },
};
const CREDIT_TTL_DAYS = 365;
const PACK_ROUTE = '/api/v1/credits';
const KEY_RE = /^xdc_[A-Za-z0-9_-]{43}$/;

const hashKey = (key) => createHash('sha256').update(key).digest('hex');
const newKey = () => `xdc_${randomBytes(32).toString('base64url')}`;
const isKey = (key) => typeof key === 'string' && KEY_RE.test(key);

// What a call costs in credits: its price in tenths of a cent ("$0.005" -> 5).
function creditCosts(prices) {
  const costs = {};
  for (const [route, price] of Object.entries(prices)) {
    const n = Math.round(Number(String(price).replace('$', '')) / CREDIT_USD);
    if (Number.isInteger(n) && n > 0) costs[route] = n;
  }
  return costs;
}

// In-memory store, for tests and local runs only.
function memoryStore({ now = () => Date.now() } = {}) {
  const balances = new Map();
  const live = (h) => {
    const e = balances.get(h);
    if (e && e.expiresAt <= now()) { balances.delete(h); return null; }
    return e;
  };
  return {
    ready: true,
    async issue(hash, credits, ttlDays) { balances.set(hash, { credits, expiresAt: now() + ttlDays * 86400e3 }); },
    async balance(hash) { const e = live(hash); return e ? { credits: e.credits, expiresAt: e.expiresAt } : null; },
    async take(hash, n) {
      const e = live(hash);
      if (!e) return { ok: false, reason: 'unknown' };
      if (e.credits < n) return { ok: false, reason: 'insufficient', credits: e.credits };
      e.credits -= n;
      return { ok: true, credits: e.credits };
    },
    async refund(hash, n) { const e = live(hash); if (e) e.credits += n; },
  };
}

// Atomic: only take the credits when there are enough.
const TAKE = `local b = redis.call('GET', KEYS[1])
if not b then return -1 end
b = tonumber(b)
local n = tonumber(ARGV[1])
if b < n then return -2 - b end
return redis.call('DECRBY', KEYS[1], n)`;

// Forgiving about what gets pasted into the dashboard: quotes, spaces, a whole
// "redis-cli --tls -u redis://…" line, or redis:// for an Upstash host (needs TLS).
function normalizeRedisUrl(raw) {
  const m = /rediss?:\/\/[^\s"'`)]+/.exec(String(raw ?? '').trim());
  if (!m) return null;
  try {
    const u = new URL(m[0]);
    return u.protocol === 'redis:' && /\.upstash\.io$/i.test(u.hostname) ? `rediss:${m[0].slice('redis:'.length)}` : m[0];
  } catch { return null; }
}

// For logs: protocol and host only, never the password.
const describeRedisUrl = (url) => { try { const u = new URL(url); return `${u.protocol}//${u.hostname}:${u.port || 6379}`; } catch { return 'unparseable'; } };

// A Redis-backed store that connects in the background. ready stays false until
// the connection works; take/balance then throw, so calls fall through to the 402.
function redisStore(rawUrl, { log = console, connect = null } = {}) {
  const url = normalizeRedisUrl(rawUrl);
  const store = { ready: false, url };
  if (!url) { log.warn('[credits] off: CREDITS_REDIS_URL is not a redis:// or rediss:// URL'); return store; }
  let client = null;
  const k = (hash) => `doctor-credits:${hash}`;
  const need = () => { if (!store.ready) throw new Error('credits store not connected'); return client; };
  (async () => {
    const { createClient } = connect ? { createClient: connect } : require('redis');
    client = createClient({ url, socket: { reconnectStrategy: (tries) => Math.min(tries * 200, 5000) } });
    client.on('error', (err) => log.warn(`[credits] redis: ${err.message}`));
    await client.connect();
    await client.ping();
    store.ready = true;
    log.log(`[credits] on: ${describeRedisUrl(url)}`);
  })().catch((err) => log.warn(`[credits] off: ${err.message}`));
  Object.assign(store, {
    async issue(hash, credits, ttlDays) { await need().set(k(hash), String(credits), { EX: ttlDays * 86400 }); },
    async balance(hash) {
      const c = need();
      const [credits, ttl] = await Promise.all([c.get(k(hash)), c.ttl(k(hash))]);
      return credits === null ? null : { credits: Number(credits), expiresAt: ttl > 0 ? Date.now() + ttl * 1000 : null };
    },
    async take(hash, n) {
      const r = Number(await need().eval(TAKE, { keys: [k(hash)], arguments: [String(n)] }));
      if (r === -1) return { ok: false, reason: 'unknown' };
      if (r < -1) return { ok: false, reason: 'insufficient', credits: -2 - r };
      return { ok: true, credits: r };
    },
    async refund(hash, n) { await need().eval("if redis.call('EXISTS', KEYS[1]) == 1 then return redis.call('INCRBY', KEYS[1], ARGV[1]) end return 0", { keys: [k(hash)], arguments: [String(n)] }); },
  });
  return store;
}

const packPath = (size) => `${PACK_ROUTE}/${size}`;

// The x402 route entries that sell the packs.
function packRoutes(acceptsFor) {
  const routes = {};
  for (const [size, pack] of Object.entries(PACKS)) {
    routes[`GET ${packPath(size)}`] = {
      accepts: acceptsFor(`$${pack.price}`),
      description: `${pack.credits} prepaid x402 Doctor credits (1 credit = $0.001: a preflight costs 1, a diagnosis 10), valid ${CREDIT_TTL_DAYS} days. Returns a credit key for the ${CREDIT_HEADER} header.`,
      mimeType: 'application/json',
    };
  }
  return routes;
}

// Before the paywall: no pack sale while the store is down.
function packGate(store) {
  return (req, res, next) => {
    if (req.method === 'GET' && Object.keys(PACKS).some((s) => req.path === packPath(s)) && !store.ready) {
      return res.status(503).json({ error: 'credits_unavailable', message: 'Credit packs are not on sale right now; pay per call instead.' });
    }
    next();
  };
}

// Before the paywall: pay a call from credits when a valid key with enough credits
// is sent. Sets req.fizzlCredits; refunds when the call fails.
function payWithCredits({ store, costs }) {
  return async (req, res, next) => {
    const key = req.get(CREDIT_HEADER);
    const cost = costs[`${req.method} ${req.path}`];
    if (!key || !cost) return next();
    if (!isKey(key)) { res.set('x-credit-status', 'invalid'); return next(); }
    const hash = hashKey(key);
    let taken;
    try { taken = await store.take(hash, cost); } catch (err) {
      res.set('x-credit-status', 'unavailable');
      return next();
    }
    if (!taken.ok) {
      res.set('x-credit-status', taken.reason);
      if (taken.reason === 'insufficient') res.set('x-credits-remaining', String(taken.credits));
      return next(); // falls through to the normal 402
    }
    req.fizzlCredits = { cost };
    res.set('x-credit-status', 'paid');
    res.set('x-credits-remaining', String(taken.credits));
    res.on('finish', () => {
      if (res.statusCode >= 400) store.refund(hash, cost).catch(() => {});
    });
    next();
  };
}

// Free: prices and how many credits a key has left. Paid (after the paywall): issue a pack.
function creditsRouter(express, { store, costs, publicUrl }) {
  const router = express.Router();
  const info = () => ({
    unit_usd: CREDIT_USD,
    costs,
    header: CREDIT_HEADER,
    on_sale: Boolean(store.ready),
    packs: Object.fromEntries(Object.entries(PACKS).map(([s, p]) => [s, { credits: p.credits, price_usd: p.price, buy: `${publicUrl}${packPath(s)}` }])),
  });
  router.get(PACK_ROUTE, async (req, res) => {
    const key = req.get(CREDIT_HEADER);
    if (!key) return res.json({ ...info(), credits: null });
    if (!isKey(key)) return res.status(400).json({ error: 'invalid_key', message: `${CREDIT_HEADER} is not an x402 Doctor credit key` });
    let b;
    try { b = await store.balance(hashKey(key)); } catch { return res.status(503).json({ error: 'credits_unavailable' }); }
    if (!b) return res.status(404).json({ error: 'unknown_key', message: 'No credits for this key (never bought, used up and expired, or mistyped).' });
    res.json({ ...info(), credits: b.credits, expires_at: b.expiresAt ? new Date(b.expiresAt).toISOString() : null });
  });
  router.get(`${PACK_ROUTE}/:size`, async (req, res, next) => {
    const pack = PACKS[req.params.size];
    if (!pack) return next();
    const key = newKey();
    await store.issue(hashKey(key), pack.credits, CREDIT_TTL_DAYS);
    res.json({
      credit_key: key,
      credits: pack.credits,
      expires_at: new Date(Date.now() + CREDIT_TTL_DAYS * 86400e3).toISOString(),
      how_to_use: `Send the header "${CREDIT_HEADER}: <credit_key>" with any paid call; it is paid from your credits instead of a new payment. Costs per call: ${Object.entries(costs).map(([r, c]) => `${r} ${c}`).join(', ')}. Check your balance with GET ${publicUrl}${PACK_ROUTE} and the same header.`,
      keep_it_secret: 'Anyone with this key can spend these credits. It is not stored on our side, so it cannot be recovered.',
    });
  });
  return router;
}

// A short "cheaper in bulk" hint on each paid route's description, only where it
// fits: the CDP facilitator rejects a resource description over 500 characters.
const CREDITS_HINT = 'Bulk: 1000 credits for $0.80 via /api/v1/credits.';
const withCreditsHint = (description) => {
  const longer = `${description.replace(/\.?$/, '.')} ${CREDITS_HINT}`;
  return [...longer].length <= 480 ? longer : description;
};

module.exports = {
  CREDIT_HEADER, CREDIT_USD, PACKS, CREDIT_TTL_DAYS, PACK_ROUTE, CREDITS_HINT,
  hashKey, newKey, isKey, creditCosts, memoryStore, redisStore, normalizeRedisUrl,
  packRoutes, packGate, payWithCredits, creditsRouter, withCreditsHint,
};
