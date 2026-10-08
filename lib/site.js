// A seller is the site behind the endpoints: its domain without subdomains (pay.edge-agents.ai -> edge-agents.ai).
// On shared hosting (onrender.com, vercel.app …) the full host name is the seller. No dependencies, so the weekly
// workflow can use it without npm ci.
const SHARED = /\.(run\.app|onrender\.com|vercel\.app|netlify\.app|railway\.app|up\.railway\.app|workers\.dev|pages\.dev|fly\.dev|herokuapp\.com|replit\.app|deno\.dev|github\.io)$/i;
const siteOf = (host) => (SHARED.test(String(host || '')) ? String(host) : String(host || '').split('.').slice(-2).join('.'));

module.exports = { siteOf };
