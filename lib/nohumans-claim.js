// nohumans.directory listing claims. To take ownership of a listing (and edit its
// category or description), the directory asks for a one-time challenge token,
// valid 24h and not a credential, either as an x-nohumans-claim header on the
// listed endpoint or as plain text at /.well-known/nohumans-claim. The tokens are
// public by design; empty CLAIMS again once the claims are done.
const CLAIMS = {
  headers: {
    '/api/v1/preflight': '5acafd994ef2d88b3d9c85d7df2e0b20052a747cb41a76bd',
    '/api/v1/diagnose': 'fcb9d41a3ed1dfeebf69bbae3f83c16f1ce5ab491ba36fdf',
    '/api/v1/fix': '0e189afed26f2f3f108f29965f2780a3d02dfc1727de89e0',
  },
  wellKnown: null,
};

function nohumansClaim(claims = CLAIMS) {
  return (req, res, next) => {
    if (req.path === '/.well-known/nohumans-claim') {
      if (!claims.wellKnown) return next();
      return res.type('text/plain').send(claims.wellKnown);
    }
    const token = claims.headers[req.path];
    if (token) res.set('x-nohumans-claim', token);
    next();
  };
}

module.exports = { nohumansClaim, CLAIMS };
