// One payment, one purchase. x402's "exact" flow verifies a payment before the handler runs and settles it after, so
// requests that carry the same payment at the same moment all pass verification and all run; only one of them then
// settles. On most routes that serves one answer twice. On the inkoper each run pays a seller, so the same $0.02
// sent ten times at once would buy ten answers with the inkoper's money. This guard sits before the paywall: a
// payment already in use is refused (409) until its request ends; after a delivered purchase it stays refused (it is
// settled, and the facilitator would refuse it too); after a failed one (nothing was charged) it may be sent again.
'use strict';

const crypto = require('node:crypto');

const KEEP_MS = 60 * 60 * 1000;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// What makes a payment unique, from its header (PAYMENT-SIGNATURE in x402 v2, X-PAYMENT in v1), or null when it
// can't be read (the paywall refuses those). EVM: the payer and the authorization's nonce; Solana: the signed
// transaction; anything else: the whole payload.
function paymentKey(header) {
  let p;
  try { p = JSON.parse(Buffer.from(String(header), 'base64').toString('utf8')); } catch { return null; }
  const payload = p?.payload;
  if (!payload || typeof payload !== 'object') return null;
  const network = p.accepted?.network ?? p.network ?? '';
  const auth = payload.authorization;
  if (auth?.nonce) return `${network}:${String(auth.from || '').toLowerCase()}:${String(auth.nonce).toLowerCase()}`;
  if (typeof payload.transaction === 'string') return `${network}:tx:${sha(payload.transaction)}`;
  return `${network}:${sha(JSON.stringify(payload))}`;
}

// Express middleware for the paid route(s): { path: '/v1/buy' }.
function createOncePerPayment({ paths, keepMs = KEEP_MS, now = () => Date.now() } = {}) {
  const used = new Map(); // key -> Infinity while in flight, else the time it may be forgotten
  const sweep = () => { const t = now(); for (const [k, until] of used) if (until <= t) used.delete(k); };
  return (req, res, next) => {
    if (req.method !== 'POST' || !paths.includes(req.path)) return next();
    const header = req.get('payment-signature') || req.get('x-payment');
    const key = header ? paymentKey(header) : null;
    if (!key) return next();
    if (used.size > 1000) sweep();
    const until = used.get(key);
    if (until !== undefined && until > now()) {
      return res.status(409).json({ error: until === Infinity ? 'This payment is already in use by another request. One payment buys one answer; wait for that request.' : 'This payment was already used for a purchase. Sign a new payment.' });
    }
    used.set(key, Infinity);
    res.once('close', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) used.set(key, now() + keepMs);
      else used.delete(key);
    });
    next();
  };
}

module.exports = { createOncePerPayment, paymentKey, KEEP_MS };
