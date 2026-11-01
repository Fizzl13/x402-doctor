// Fizzl Pass sold over x402: an agent buys a pass for its own wallet, without an account at the Agent Wallet.
//
//   GET /api/v1/pass            free: the tiers, prices and what a pass gives
//   GET /api/v1/pass/<tier>     $5 Bronze (30 days), $20 Silver (90 days), $60 Gold (180 days), over x402 or MPP
//
// The paid answer has a claim id. Only after the payment has settled (the response is sent) does this service hand
// the sale to the Agent Wallet (POST wallet.fizzl.eu/hooks/pass-sale, with PASS_SALE_KEY), which records the pass
// for the paying wallet and keeps the signed proof under the claim id; the buyer fetches it at
// GET wallet.fizzl.eu/v1/pass/claim/<id>. So a payment that fails to settle never grants a pass. Off without
// PASS_SALE_KEY. A pass purchase earns no credit back (res.locals.noVaultCredit).
'use strict';

const crypto = require('node:crypto');

const PASS_ROUTE = '/api/v1/pass';
const PASS_SALE = {
  bronze: { name: 'Fizzl Pass Bronze', price: '5', days: 30, limits: 5, back: 10, delivery: 0 },
  silver: { name: 'Fizzl Pass Silver', price: '20', days: 90, limits: 10, back: 20, delivery: 1 },
  gold: { name: 'Fizzl Pass Gold', price: '60', days: 180, limits: 25, back: 30, delivery: 3 },
};
const DEFAULT_WALLET = 'https://wallet.fizzl.eu';

function decodeBase64Json(value) {
  if (!value) return null;
  try { return JSON.parse(Buffer.from(String(value), 'base64').toString('utf8')); } catch { return null; }
}

// Who paid, and in which transaction, once the response is sent: the x402 settlement header, or an MPP payment.
function settledSale(res) {
  if (res.statusCode >= 400) return null;
  const mpp = res.locals && res.locals.mppPayment;
  if (mpp) return mpp.payer && mpp.tx ? { payer: mpp.payer, tx: String(mpp.tx) } : null;
  const s = decodeBase64Json(res.getHeader('PAYMENT-RESPONSE') || res.getHeader('X-PAYMENT-RESPONSE'));
  return s && s.success !== false && s.payer && s.transaction ? { payer: s.payer, tx: String(s.transaction) } : null;
}

const describe = (tier) => {
  const t = PASS_SALE[tier];
  return `${t.name} for the paying wallet, ${t.days} days: ${t.limits} times the free limits and ${t.back}% of every paid call back as credit on x402 Doctor, presign-guard, Ichimoku Signal and Fizzl Buy${t.delivery ? `, plus ${t.delivery} free x402 Doctor delivery check${t.delivery > 1 ? 's' : ''} a month` : ''}. No account needed. Returns a claim_url with the signed proof for the X-Fizzl-Pass header.`;
};

// The x402 route entries that sell the passes.
function passSaleRoutes(acceptsFor) {
  const routes = {};
  for (const [tier, t] of Object.entries(PASS_SALE)) {
    routes[`GET ${PASS_ROUTE}/${tier}`] = { accepts: acceptsFor(`$${t.price}`), description: describe(tier), mimeType: 'application/json' };
  }
  return routes;
}

function createPassSale({ key = null, walletUrl = DEFAULT_WALLET, fetchImpl = globalThis.fetch, log = console, retryMs = [1000, 5000, 30000] } = {}) {
  const base = String(walletUrl).replace(/\/$/, '');
  const enabled = Boolean(key);

  async function handIn(sale) {
    for (let i = 0; i <= retryMs.length; i++) {
      try {
        const r = await fetchImpl(`${base}/hooks/pass-sale`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(sale), signal: AbortSignal.timeout(10000) });
        if (r.ok) return true;
        if (r.status >= 400 && r.status < 500) { log.warn(`[pass-sale] refused by the wallet (${r.status}) for tx ${sale.tx}`); return false; }
      } catch (err) {
        if (i === retryMs.length) log.warn(`[pass-sale] could not reach the wallet for tx ${sale.tx}: ${err.message}`);
      }
      if (i < retryMs.length) await new Promise((r) => setTimeout(r, retryMs[i]));
    }
    log.warn(`[pass-sale] gave up handing in tx ${sale.tx} (${sale.tier} for ${sale.wallet}, claim ${sale.claim}): hand it in by hand`);
    return false;
  }

  function router(express) {
    const r = express.Router();
    r.get(PASS_ROUTE, (_req, res) => {
      res.set('Cache-Control', 'public, max-age=300').json({
        on_sale: enabled,
        tiers: Object.fromEntries(Object.entries(PASS_SALE).map(([tier, t]) => [tier, { name: t.name, price_usd: t.price, days: t.days, free_limits: `${t.limits}x`, credit_back: `${t.back}%`, free_delivery_checks_per_month: t.delivery, buy: `GET ${PASS_ROUTE}/${tier}` }])),
        how: 'Pay with any x402 client (most cap a payment at $1 by default: @x402/fetch needs spendControls raised or off for these prices); the pass belongs to the wallet that paid. The answer has a claim_url that returns the signed proof (for the X-Fizzl-Pass header) once the payment has settled. With an Agent Wallet account, Bronze also comes with Pro: https://wallet.fizzl.eu/pass',
      });
    });
    r.get(`${PASS_ROUTE}/:tier`, (req, res, next) => {
      const tier = req.params.tier;
      if (!PASS_SALE[tier]) return next();
      if (!enabled) return res.status(503).json({ error: 'pass_sale_unavailable', message: 'Passes are not on sale here right now; see https://wallet.fizzl.eu/pass.' });
      const claim = crypto.randomBytes(24).toString('base64url');
      res.locals.noVaultCredit = true;
      res.on('finish', () => {
        const sale = settledSale(res);
        if (sale) handIn({ wallet: sale.payer, tier, tx: sale.tx, claim }).catch(() => {});
      });
      const t = PASS_SALE[tier];
      res.set('Cache-Control', 'private, no-store').json({
        tier, name: t.name, days: t.days,
        claim_url: `${base}/v1/pass/claim/${claim}`,
        how_to_use: `Fetch claim_url in a few seconds (it answers 404 "pending" until the payment has been passed on). It returns the pass and its signed proof: send the proof as the X-Fizzl-Pass header to Fizzl's services for ${t.limits} times the free limits and ${t.back}% back as credit, spent there from calls with the header and no payment.`,
        keep_it_secret: 'The proof works like a key to the pass and its credit. The claim id is shown only here.',
      });
    });
    return r;
  }

  return { enabled, router, handIn };
}

module.exports = { createPassSale, passSaleRoutes, settledSale, PASS_SALE, PASS_ROUTE };
