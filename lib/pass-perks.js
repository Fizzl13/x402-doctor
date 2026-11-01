// Fizzl Pass extras: free delivery checks each month (Silver 1, Gold 3).
//
// A delivery check (lib/delivery-checks.js, normally $0.25) ordered with the X-Fizzl-Pass header and no payment uses
// one of the pass's checks for the current UTC month, while it has any left. The check before payment runs first, so
// a refused endpoint never uses one, and a check that ends in an error gives it back. Without checks left the order
// gets the normal 402. Counted per pass (its first wallet) and month, in the same Redis as the vault; off without it.
'use strict';

const DELIVERY_CHECKS = { silver: 1, gold: 3 };
const KEEP_S = 40 * 86400;

const monthOf = (now) => new Date(now).toISOString().slice(0, 7);
const walletOf = (claims) => String((claims?.wallets || [])[0] || '').toLowerCase();

function memoryPerks() {
  const counts = new Map();
  return {
    ready: true,
    async use(key, max) { const n = (counts.get(key) || 0) + 1; if (n > max) return { ok: false, used: n - 1 }; counts.set(key, n); return { ok: true, used: n }; },
    async giveBack(key) { counts.set(key, Math.max(0, (counts.get(key) || 0) - 1)); },
    async used(key) { return counts.get(key) || 0; },
  };
}

// Uses one atomically, only below max.
const USE = "local n = tonumber(redis.call('GET', KEYS[1]) or '0') if n >= tonumber(ARGV[1]) then return -1 - n end n = redis.call('INCR', KEYS[1]) redis.call('EXPIRE', KEYS[1], ARGV[2]) return n";
const GIVE_BACK = "local n = tonumber(redis.call('GET', KEYS[1]) or '0') if n > 0 then return redis.call('DECR', KEYS[1]) end return 0";

// getClient: the vault's connected Redis client (lib/fizzl-vault.js redisVault().client).
function redisPerks(getClient) {
  const store = {};
  Object.defineProperty(store, 'ready', { get: () => { const c = getClient(); return Boolean(c && c.isReady !== false); }, enumerable: true });
  const k = (key) => `fizzl-perks:${key}`;
  Object.assign(store, {
    async use(key, max) { const r = Number(await getClient().eval(USE, { keys: [k(key)], arguments: [String(max), String(KEEP_S)] })); return r < 0 ? { ok: false, used: -1 - r } : { ok: true, used: r }; },
    async giveBack(key) { await getClient().eval(GIVE_BACK, { keys: [k(key)], arguments: [] }); },
    async used(key) { return Number(await getClient().get(k(key))) || 0; },
  });
  return store;
}

const carriesPayment = (req) => Boolean(req.headers['payment-signature'] || req.headers['x-payment'] || req.headers['x-credit-key'] || /^payment\s/i.test(req.headers.authorization || ''));

function createPassPerks({ pass, store, now = () => Date.now(), log = console } = {}) {
  const enabled = () => Boolean(pass && store && store.ready);
  const keyFor = (claims) => `delivery:${walletOf(claims)}:${monthOf(now())}`;

  // Before the paywall on the delivery-check route, after its check before payment (req.deliveryJob).
  function deliveryChecks() {
    return async (req, res, next) => {
      if (!enabled() || req.fizzlCredits || !req.deliveryJob || !req.headers['x-fizzl-pass'] || carriesPayment(req)) return next();
      const claims = await pass.fromRequest(req).catch(() => null);
      const max = DELIVERY_CHECKS[claims?.tier];
      if (!max || !walletOf(claims)) return next();
      const key = keyFor(claims);
      let got;
      try { got = await store.use(key, max); } catch (err) { log.warn(`[perks] ${err.message}`); return next(); }
      res.set('x-fizzl-pass-delivery-checks', `${Math.max(0, max - got.used)} of ${max} left this month`);
      if (!got.ok) return next(); // none left: the normal 402
      req.fizzlCredits = { perk: 'delivery-check', tier: claims.tier, cost: 0 };
      res.locals.noVaultCredit = true;
      res.on('finish', () => { if (res.statusCode >= 400) store.giveBack(key).catch(() => {}); });
      next();
    };
  }

  // How many a pass has left this month (GET with the X-Fizzl-Pass header).
  function status() {
    return async (req, res) => {
      res.set('Cache-Control', 'private, no-store');
      const claims = pass && req.headers['x-fizzl-pass'] ? await pass.fromRequest(req).catch(() => null) : null;
      const base = { perks: { delivery_checks_per_month: DELIVERY_CHECKS }, how: 'Order GET /api/v1/delivery-check?url=… with your X-Fizzl-Pass header and no payment; it uses one of your checks while you have any left this month (UTC).' };
      if (!claims) return res.status(claims === null && req.headers['x-fizzl-pass'] ? 401 : 200).json(req.headers['x-fizzl-pass'] ? { error: 'the pass proof is not valid', ...base } : base);
      const max = DELIVERY_CHECKS[claims.tier] || 0;
      const used = max && enabled() ? await store.used(keyFor(claims)).catch(() => null) : 0;
      res.json({ tier: claims.tier, month: monthOf(now()), delivery_checks: { per_month: max, used, left: used === null ? null : Math.max(0, max - used) }, ...base });
    };
  }

  return { deliveryChecks, status, enabled };
}

module.exports = { createPassPerks, memoryPerks, redisPerks, DELIVERY_CHECKS, monthOf };
