// A seller is the site behind the endpoints: its domain without subdomains (pay.edge-agents.ai -> edge-agents.ai).
// On shared hosting (onrender.com, vercel.app …) the full host name is the seller. No dependencies, so the weekly
// workflow can use it without npm ci.
// A country's second-level suffix (co.uk, com.au, org.br …) counts as part of the suffix: tippingservice.co.uk, not co.uk.
const SHARED = /\.(run\.app|onrender\.com|vercel\.app|netlify\.app|railway\.app|up\.railway\.app|workers\.dev|pages\.dev|fly\.dev|herokuapp\.com|replit\.app|deno\.dev|github\.io)$/i;
const SECOND_LEVEL = /\.(co|com|org|net|gov|ac|edu|ne|or)\.[a-z]{2}$/i;
const siteOf = (host) => {
  const h = String(host || '');
  if (SHARED.test(h)) return h;
  return h.split('.').slice(SECOND_LEVEL.test(h) ? -3 : -2).join('.');
};

module.exports = { siteOf };
