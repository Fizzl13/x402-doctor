// One payment, one purchase. x402's "exact" flow verifies a payment before the handler runs and settles it after, so
// requests that carry the same payment at the same moment all pass verification and all run; only one of them then
// settles. On most routes that serves one answer twice. On the inkoper each run pays a seller, so the same $0.02
// sent ten times at once would buy ten answers with the inkoper's money. A payment already in use is refused until
// its request ends; after a settled purchase it stays refused (the facilitator would refuse it too); after a failed
// one (nothing was charged) it may be sent again. The HTTP route (createOncePerPayment, before the paywall) and the
// paid MCP tool (buy-server.js) share one set of locks, so a payment can't be used once over each either.
'use strict';

const crypto = require('node:crypto');

const KEEP_MS = 60 * 60 * 1000;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const REFUSED = {
  in_use: 'This payment is already in use by another request. One payment buys one answer; wait for that request.',
  used: 'This payment was already used for a purchase. Sign a new payment.',
};

// What makes a payment payload unique (the decoded PAYMENT-SIGNATURE / X-PAYMENT, or MCP's _meta["x402/payment"]),
// or null when it can't be read (the paywall refuses those). EVM: the payer and the authorization's nonce; Solana:
// the signed transaction; anything else: the whole payload.
function keyOf(p) {
  const payload = p && p.payload;
  if (!payload || typeof payload !== 'object') return null;
  const network = (p.accepted && p.accepted.network) || p.network || '';
  const auth = payload.authorization;
  if (auth && auth.nonce) return `${network}:${String(auth.from || '').toLowerCase()}:${String(auth.nonce).toLowerCase()}`;
  if (typeof payload.transaction === 'string') return `${network}:tx:${sha(payload.transaction)}`;
  return `${network}:${sha(JSON.stringify(payload))}`;
}

// The same from a payment header (PAYMENT-SIGNATURE in x402 v2, X-PAYMENT in v1).
function paymentKey(header) {
  let p;
  try { p = JSON.parse(Buffer.from(String(header), 'base64').toString('utf8')); } catch { return null; }
  return keyOf(p);
}

// take(key): null when the payment may be used now (it is then in use), else 'in_use' or 'used'.
// done(key, settled): the request ended; a settled payment stays refused for keepMs.
function createPaymentLocks({ keepMs = KEEP_MS, now = () => Date.now() } = {}) {
  const used = new Map(); // key -> Infinity while in flight, else the time it may be forgotten
  const sweep = () => { const t = now(); for (const [k, until] of used) if (until <= t) used.delete(k); };
  return {
    take(key) {
      if (used.size > 1000) sweep();
      const until = used.get(key);
      if (until !== undefined && until > now()) return until === Infinity ? 'in_use' : 'used';
      used.set(key, Infinity);
      return null;
    },
    done(key, settled) {
      if (settled) used.set(key, now() + keepMs);
      else used.delete(key);
    },
  };
}

// Express middleware for the paid HTTP route(s), before the paywall: a payment in use or used gets a 409.
function createOncePerPayment({ paths, locks = createPaymentLocks() } = {}) {
  return (req, res, next) => {
    if (req.method !== 'POST' || !paths.includes(req.path)) return next();
    const header = req.get('payment-signature') || req.get('x-payment');
    const key = header ? paymentKey(header) : null;
    if (!key) return next();
    const refused = locks.take(key);
    if (refused) return res.status(409).json({ error: REFUSED[refused] });
    res.once('close', () => locks.done(key, res.statusCode >= 200 && res.statusCode < 300));
    next();
  };
}

module.exports = { createOncePerPayment, createPaymentLocks, paymentKey, keyOf, REFUSED, KEEP_MS };
