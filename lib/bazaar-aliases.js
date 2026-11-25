// Search words in the URL path. The CDP Bazaar's search ranks a route mostly by the words in its URL (host and path),
// hardly by its description (re-checked 25 Nov 2026: our routes came up for "fix", "delivery check", "injection",
// "scan", "signal", but not for their own new opening phrases). So a few routes get a second path with the words a
// buyer searches for, which does exactly what the route does: the request is rewritten to the route's own path
// before anything else runs (body parsing, paywall, handler, usage log), while x402's resource URL stays the one
// that was asked (@x402/express builds it from req.originalUrl), so the Bazaar lists the alias after one payment.
// The same file is in presign-guard (src/bazaar-aliases.js).
'use strict';

function bazaarAliases(aliases) {
  const map = new Map(Object.entries(aliases));
  return (req, _res, next) => {
    const q = req.url.indexOf('?');
    const path = q < 0 ? req.url : req.url.slice(0, q);
    const target = map.get(path) ?? map.get(path.replace(/\/+$/, ''));
    if (target) req.url = target + (q < 0 ? '' : req.url.slice(q));
    next();
  };
}

module.exports = { bazaarAliases };
