// Temporary diagnostic: the usage log sees only 3 visitor codes for Doctor, so
// req.ip is a proxy address, not the caller's. For the first requests after a
// start this logs the shape of the forwarding headers (how many X-Forwarded-For
// entries, which client-IP headers are present, which entry req.ip is and
// whether it is a private address), never an address itself. Remove once
// 'trust proxy' is set to the right number of hops.
const { isPrivateIp } = require('./safe-fetch');

const clean = (ip) => String(ip || '').trim().replace(/^::ffff:/, '');

function describeHops(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(clean).filter(Boolean);
  const where = (ip) => {
    const i = xff.indexOf(clean(ip));
    return i === -1 ? 'none' : `xff[${i}]`;
  };
  const parts = [`xff=${xff.length}`, `req.ip=${where(req.ip)}`, `req.ip-private=${isPrivateIp(clean(req.ip))}`];
  for (const h of ['cf-connecting-ip', 'true-client-ip', 'x-real-ip']) {
    if (req.headers[h]) parts.push(`${h}=${where(req.headers[h])}`);
  }
  return `proxy hops: ${parts.join(' ')}`;
}

function proxyHops({ limit = 20, log = console } = {}) {
  let left = limit;
  return (req, _res, next) => {
    if (left > 0) {
      left--;
      log.log(describeHops(req));
    }
    next();
  };
}

module.exports = { proxyHops, describeHops };
