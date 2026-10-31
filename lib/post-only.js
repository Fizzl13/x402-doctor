// GET and HEAD on a paid route that takes POST (Fizzl Buy's POST /v1/buy) answered 404, so directories that probe
// every route with an unpaid GET listed it as gone (the Agent Exchange x402 census, 29 Oct 2026). They now get the
// same 402 as an unpaid POST, with Allow: POST. A GET that carries a payment is refused with 405: the purchase needs
// the POST body, and a payment on a GET would buy nothing. The same as presign-guard's src/post-only.js.
// A browser gets that 402 as JSON too, not the wallet-connect paywall page: that page pays by repeating the GET with
// the payment, which is refused here, so it could never buy anything (x402 Doctor flagged its testnet mode, 31 Oct).

const PAYMENT_HEADERS = ['payment-signature', 'x-payment'];

function postOnlyTerms({ paths, paywall }) {
  const routes = new Set(paths);
  return (req, res, next) => {
    const path = req.path.replace(/\/+$/, '').toLowerCase();
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !routes.has(path)) return next();
    res.set('Allow', 'POST');
    const refuse = () => res.status(405).json({ error: 'method_not_allowed', message: `${req.path} takes POST with a JSON body (see /openapi.json); an unpaid POST gets the payment terms.` });
    const paying = PAYMENT_HEADERS.some((h) => req.headers[h]) || /(?:^|,)\s*Payment\s/i.test(String(req.headers.authorization || ''));
    if (paying) return refuse();
    // The paywall sees the POST this GET stands for (at the route's own path) and answers its 402 (Node sends no
    // body for HEAD); a path it doesn't guard falls through to 405. Accept: JSON, so no browser paywall page.
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    paywall(Object.create(req, { method: { value: 'POST', enumerable: true }, url: { value: `${path}${query}`, enumerable: true }, headers: { value: { ...req.headers, accept: 'application/json' }, enumerable: true } }), res, refuse);
  };
}

module.exports = { postOnlyTerms };
