const express = require('express');
const fs = require('fs');
const path = require('path');
const { x402TrustTxtRoute } = require('./lib/x402-trust-txt');
const { ALGORITHM, verifyReceipt, AUTHORITY, SERVICE } = require('./lib/receipt');
const { securityHeaders } = require('./lib/security-headers');
const { nohumansClaim } = require('./lib/nohumans-claim');
const { fizzlCors } = require('./lib/fizzl-cors');
const { createSafeFetch, isPrivateIp } = require('./lib/safe-fetch');
const diagnoseLib = require('./lib/diagnose');
const { createBazaarIndex } = require('./lib/bazaar-index');
const { createPaidApi, ROUTE: PAID_ROUTE, PREFLIGHT_ROUTE, FIX_ROUTE, BATCH_ROUTE, DEEP_ROUTE, REPORT_SCHEMA, FIX_SCHEMA, DEEP_SCHEMA } = require('./lib/paid-api');
const { BATCH_SCHEMA } = require('./lib/preflight-plus');
const { STACKS } = require('./lib/stack');
const { PREFLIGHT_SCHEMA } = require('./lib/preflight');
const { createTrustIndex } = require('./lib/trust-index');
const { createMediaCache } = require('./lib/media');
const crypto = require('crypto');
const { createUsageLog, mcpToolCall, mcpPayment, agentOf, visitorOf } = require('./lib/usage-log');
const { createFeedback } = require('./lib/feedback');
const { createOutcomes } = require('./lib/outcomes');
const { createUsageReader } = require('./lib/usage-reader');
const { createPublicStats, statsCors } = require('./lib/public-stats');
const { setupsFunnel } = require('./lib/usage-funnel');
const { checkSettlement } = require('./lib/settlement');
const { createStatus } = require('./lib/status');
const { renderBadge, badgeFor } = require('./lib/badge');
const { addMppOffers } = require('./lib/mpp-pay');
const { createOutreachHook } = require('./lib/outreach-hook');
const { createTriage } = require('./lib/jev-triage');

const PORT = process.env.PORT || 3001;
// Payout addresses shown by /demo/broken (it never settles, so nothing is paid).
const DEMO_PAY_TO_BASE = '0x6B0F4651eD42893ab58139938175E4a69f175F25';
const DEMO_PAY_TO_SOLANA = 'ATWJ82T8nRdQwZnaysB68N5EpaSvLRsQP4h6eWmaJBH9';
const RATE_LIMIT = { windowMs: 60 * 1000, max: 10 };

// Tiny per-IP limiter: every diagnosis makes several outbound requests, so
// the public instance must not become a free scanner.
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ error: `Too many diagnoses; try again in a minute (limit ${max}/min).` });
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 10_000) hits.clear();
    next();
  };
}

// allowPrivate is only for tests and local CLI use; the web service never
// diagnoses internal addresses.
// Which payment protocol a diagnosed endpoint speaks, for the usage log: x402, mpp, l402, both (x402 + MPP),
// a "+"-list for other combinations, or none.
function protocolOf(b) {
  if (!b || typeof b !== 'object' || (!b.checks && !b.overall)) return undefined;
  const mpp = Array.isArray(b.mpp) && b.mpp.length;
  const l402 = Array.isArray(b.l402) && b.l402.length;
  if (l402) return [b.challenge && 'x402', mpp && 'mpp', 'l402'].filter(Boolean).join('+');
  if (mpp && b.challenge) return 'both';
  if (mpp) return 'mpp';
  return b.challenge ? 'x402' : 'none';
}
const mppMethods = (b) => (b && Array.isArray(b.mpp) && b.mpp.length ? [...new Set(b.mpp.map((c) => c && c.method).filter(Boolean))].join(', ') : undefined);

// What each Doctor call was about, for the usage log (null = not logged).
function describeDoctorCall(req, _res, body) {
  // Who reads the EIP-8004 registration (e.g. agent registries such as Metaplex).
  if (req.method === 'GET' && req.path === '/.well-known/agent-registration.json') return { route: 'agent registration', via: 'discovery', input: {}, result: { status: _res.statusCode } };
  const b = body || {};
  if (req.method === 'POST' && req.path === '/api/diagnose') {
    return { route: 'diagnose', via: 'web', input: { url: req.body && req.body.url, method: req.body && req.body.method }, result: { overall: b.overall, protocol: protocolOf(b), mpp: mppMethods(b), error: b.error } };
  }
  if (req.method === 'GET' && req.path === PAID_ROUTE) {
    return { route: 'diagnose', via: 'api', input: { url: req.query.url, method: req.query.method }, result: { overall: b.overall, protocol: protocolOf(b), mpp: mppMethods(b), error: b.error } };
  }
  if (req.method === 'GET' && req.path === FIX_ROUTE) {
    return { route: 'fix', via: 'api', input: { url: req.query.url, method: req.query.method, stack: req.query.stack }, result: { stack: b.stack && b.stack.id, fixes: Array.isArray(b.fixes) ? b.fixes.map((f) => f.recipe).join(', ') || 'none' : undefined, error: b.error } };
  }
  if (req.method === 'GET' && req.path === BATCH_ROUTE) {
    const urls = req.query.url === undefined ? [] : [].concat(req.query.url);
    return { route: 'preflight batch', via: 'api', input: { urls: urls.slice(0, 10), max_usd: req.query.max_usd, network: req.query.network }, result: { counts: b.counts && Object.entries(b.counts).map(([k, v]) => `${k} ${v}`).join(', '), error: b.error } };
  }
  if (req.method === 'GET' && req.path === DEEP_ROUTE) {
    return { route: 'preflight deep', via: 'api', input: { url: req.query.url, max_usd: req.query.max_usd, network: req.query.network }, result: { verdict: b.verdict, error: b.error } };
  }
  if (req.method === 'GET' && req.path === PREFLIGHT_ROUTE) {
    return { route: 'preflight', via: 'api', input: { url: req.query.url, max_usd: req.query.max_usd, network: req.query.network }, result: { verdict: b.verdict, error: b.error } };
  }
  if (req.method === 'POST' && req.path === '/mcp') {
    const call = mcpToolCall(req.body);
    if (!call) return null; // initialize, tools/list
    if (call.tool === 'feedback') return null; // feedback.js logs it itself, with the full message
    const reply = (Array.isArray(b) ? b : [b]).find((r) => r && r.result) || {};
    const text = reply.result && reply.result.content && reply.result.content[0] && reply.result.content[0].text;
    if (reply.result && reply.result.isError && /payment|402/i.test(String(text))) return null; // the price, not a call
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* plain text */ }
    const a = call.args || {};
    return {
      route: call.tool,
      via: 'mcp',
      input: { url: a.url, method: a.method, max_usd: a.max_usd, stack: a.stack },
      result: { overall: parsed && parsed.overall, protocol: call.tool === 'x402_diagnose' ? protocolOf(parsed) : undefined, mpp: call.tool === 'x402_diagnose' ? mppMethods(parsed) : undefined, verdict: parsed && parsed.verdict, error: reply.result && reply.result.isError ? String(text).slice(0, 200) : undefined },
      payment: mcpPayment(req.body, body),
    };
  }
  if (req.method === 'POST' && req.path === '/api/settlement') {
    return { route: 'payment proof', via: 'web', input: { network: b.decoded && b.decoded.network }, result: { overall: b.overall, found: b.onchain ? b.onchain.found : undefined, error: b.error } };
  }
  if (req.method === 'GET' && req.path === '/badge.svg') {
    let host;
    try { host = new URL(String(req.query.url)).host; } catch { host = undefined; }
    return { route: 'badge', via: 'web', input: { host, from: (() => { try { return new URL(req.get('referer') || '').host || undefined; } catch { return undefined; } })() }, result: {} };
  }
  if (req.method === 'GET' && req.path === '/api/trust') {
    return { route: 'trust lookup', via: 'web', input: { url: req.query.url }, result: { found: Boolean(b.url && !b.error) } };
  }
  return null;
}

// HTTP Basic auth against ADMIN_PASSWORD (any user name). Without the
// setting the admin pages do not exist.
// After ADMIN_MAX_FAILURES wrong passwords from one IP in 15 minutes, that IP
// gets 429 until the window has passed (no password guessing at request speed).
const ADMIN_MAX_FAILURES = 10;
const ADMIN_WINDOW_MS = 15 * 60 * 1000;
function adminAuth(env) {
  const failures = new Map();
  return (req, res, next) => {
    const password = env.ADMIN_PASSWORD;
    if (!password) return res.status(404).send('Not found');
    const now = Date.now();
    const recent = (failures.get(req.ip) || []).filter((t) => now - t < ADMIN_WINDOW_MS);
    if (recent.length >= ADMIN_MAX_FAILURES) {
      res.set('Retry-After', String(Math.ceil((recent[0] + ADMIN_WINDOW_MS - now) / 1000)));
      return res.status(429).send('Too many attempts; try again later');
    }
    const header = req.get('authorization') || '';
    const given = header.startsWith('Basic ') ? Buffer.from(header.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':') : '';
    const a = crypto.createHash('sha256').update(given).digest();
    const b = crypto.createHash('sha256').update(password).digest();
    if (given && crypto.timingSafeEqual(a, b)) return next();
    // A request without credentials is the browser asking for the login prompt, not a guess.
    if (given) {
      recent.push(now);
      failures.set(req.ip, recent);
      if (failures.size > 10_000) failures.clear();
    }
    res.set('WWW-Authenticate', 'Basic realm="Fizzl usage", charset="UTF-8"');
    res.status(401).send('Password required');
  };
}

// TRUST_PROXY_HOPS overrides the measured hop count (a whole number from 0 to 10).
function trustProxyHops(env) {
  const n = Number(env.TRUST_PROXY_HOPS);
  return Number.isInteger(n) && n >= 0 && n <= 10 && String(env.TRUST_PROXY_HOPS).trim() !== '' ? n : 3;
}

function createApp({ allowPrivate = false, rateLimit: limits = RATE_LIMIT, env = process.env, bazaarIndex, trustIndex = createTrustIndex(), media = createMediaCache(), usageLog = createUsageLog({ service: 'doctor', env }), usageReader = createUsageReader({ env }), publicStats = createPublicStats({ usageReader }), settlementFetch = globalThis.fetch, status = null, outreachHook: outreachHookOverride = null } = {}) {
  const app = express();
  const safeFetch = createSafeFetch({ allowPrivate });
  // Outreach drafts for the owner (lib/outreach-hook.js); off without OUTREACH_URL and OUTREACH_KEY.
  const outreachHook = outreachHookOverride || createOutreachHook({ url: env.OUTREACH_URL, key: env.OUTREACH_KEY, safeFetch, publicUrl: env.PUBLIC_URL || 'https://x402-doctor.fizzl.eu', triage: createTriage({ apiKey: env.TYPESAFE_API_KEY }) });
  // POST /feedback (and the MCP tool feedback): agents report a bug or a missing
  // feature. Free; it lands in the usage log and a person reads it (lib/feedback.js).
  const feedback = createFeedback({ service: 'doctor', record: usageLog.record, agentOf });
  // One Bazaar index for the paid API and the free web check (where a route is listed).
  const bazaar = bazaarIndex || createBazaarIndex();
  // Outcome reports (lib/outcomes.js): what agents saw after paying an endpoint
  // following a preflight; later preflights learn from them.
  let paidApi = null;
  const outcomes = createOutcomes({
    usageReader,
    record: usageLog.record,
    signers: () => (paidApi && paidApi.signer ? paidApi.signer.signers : []),
    authority: env.RECEIPT_AUTHORITY || AUTHORITY,
  });
  // Free payment-proof check (lib/settlement.js): the PAYMENT-RESPONSE header → the on-chain transaction.
  const rpcUrls = { ...(env.BASE_RPC_URL ? { 'eip155:8453': env.BASE_RPC_URL } : {}), ...(env.SOLANA_RPC_URL ? { 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': env.SOLANA_RPC_URL } : {}) };
  const checkPaymentProof = (header) => checkSettlement(header, { fetch: settlementFetch, rpcUrls });
  paidApi = createPaidApi({ safeFetch, env, trustIndex, feedback, bazaarIndex: bazaar, outcomes, checkPaymentProof });

  // Doctor's requests reach the app through three proxies (the caller, then two
  // hops, the last a private Render address: measured 26 Sep), so Express has to
  // count back three X-Forwarded-For entries to find the caller. With 1, req.ip
  // was the Render hop, and the per-IP admin lockout and rate limits were shared.
  app.set('trust proxy', trustProxyHops(env));
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(nohumansClaim());
  app.get('/.well-known/x402-trust.txt', x402TrustTxtRoute(env));
  // Who signs the verdicts, and a free check of one (before the 4 kB body limit:
  // a signed diagnose report is larger).
  const signer = paidApi.signer || null;
  const authority = env.RECEIPT_AUTHORITY || AUTHORITY;
  app.get('/.well-known/x402-doctor-signer.json', async (req, res) => res.json({
    signing: Boolean(signer),
    signers: signer ? signer.signers : [],
    // The payout wallet authorises signing keys; clients can pin it instead of the keys.
    authority,
    certificate: signer ? await signer.certificate() : null,
    certificate_format: 'personal_sign by the authority over: fizzl receipt signer\\nservice: <service>\\nsigner: <address>\\nvalid_from: <YYYY-MM-DD>',
    sign_certificate: `${req.protocol}://${req.get('host')}/sign-receipt-key`,
    algorithm: ALGORITHM,
    canonicalization: "js-json-stringify-sorted-utf16-ascii-v1: keys sorted by UTF-16 code units at every level, no whitespace, every code unit from U+007F up as lowercase \\uXXXX, numbers as JavaScript's JSON.stringify writes them (1.0 -> 1, 0.000001 -> 0.000001), UTF-8 bytes. Python's json.dumps matches only for ASCII keys and integers; Python equivalent: https://github.com/Fizzl13/x402-doctor/blob/master/examples/canonical.py",
    input_sha256: "sha256 of the canonical JSON of {route, input}: route like 'GET /api/v1/preflight' or 'mcp x402_preflight'; input = the query parameters as strings (GET) or the tool arguments (MCP)",
    verify: `${req.protocol}://${req.get('host')}/api/v1/verify`,
  }));
  const signPage = fs.readFileSync(path.join(__dirname, 'lib', 'sign-receipt-key.html'), 'utf8')
    .replaceAll('{{SERVICE}}', SERVICE).replaceAll('{{AUTHORITY}}', authority).replaceAll('{{WELL_KNOWN}}', '/.well-known/x402-doctor-signer.json');
  app.get('/sign-receipt-key', (_req, res) => res.type('html').send(signPage));
  app.post('/api/v1/verify', express.json({ limit: '256kb' }), async (req, res) => {
    const { response, route, input } = req.body || {};
    const body = response && typeof response === 'object' ? response : req.body;
    res.json(await verifyReceipt(body, { signers: signer ? signer.signers : [], route, input, authority }));
  });
  // Free: report what happened after paying an endpoint that a paid preflight
  // checked. The signed preflight travels along (its own 64 kB parser).
  const outcomeLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 120 });
  app.post('/api/v1/outcome', outcomeLimit, express.json({ limit: '64kb' }), async (req, res) => {
    const { status, body } = await outcomes.report(req.body, {
      agent: agentOf(req.headers['user-agent']),
      visitor: visitorOf(req.ip, env.USAGE_LOG_SALT || env.USAGE_LOG_TOKEN),
    });
    res.status(status).json(body);
  });
  app.use(feedback.router(express)); // its own 16 kB JSON parser, before the 4 kB one
  app.use(express.json({ limit: '4kb' }));
  app.use(usageLog.middleware(describeDoctorCall));

  // Usage dashboard for the owner: every call to the Fizzl services, from the usage log.
  const admin = adminAuth(env);
  app.get('/admin/usage', admin, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'admin', 'usage.html'));
  });
  app.get('/admin/usage/data', admin, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    try {
      const data = await usageReader.load({ days });
      let trust = null;
      try { trust = trustIndex.summary(); } catch { /* not loaded yet */ }
      res.json({ ...data, funnel: setupsFunnel(data.events || []), trust: trust && trust.by_protocol ? { by_protocol: trust.by_protocol } : null });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // status.fizzl.eu (a custom domain on this service) opens the status page.
  app.get('/', (req, res, next) => (req.hostname === 'status.fizzl.eu' ? res.sendFile(path.join(__dirname, 'public', 'status.html')) : next()));
  app.use(express.static(path.join(__dirname, 'public')));

  // Paid agent API (x402). The web page below stays free and rate-limited.
  app.use(paidApi);
  // Instructions an AI agent can read and follow ("Connect to x402-doctor.fizzl.eu/skill.md").
  app.get('/skill.md', (_req, res) => res.set('cache-control', 'public, max-age=300').type('text/markdown; charset=utf-8').sendFile(path.join(__dirname, 'public', 'skill.md')));
  app.get('/openapi.json', (req, res) => res.json(openApi(`${req.protocol}://${req.get('host')}`, paidApi.paymentInfo)));
  // Indexers (CDP Bazaar, nsgoods, x402scan) keep the URLs they are given. The
  // old onrender.com address still works, but discovery always names the
  // fizzl.eu address; any other host (a local run, a test) lists itself.
  const publicUrl = (env.PUBLIC_URL || 'https://x402-doctor.fizzl.eu').replace(/\/$/, '');
  app.get('/.well-known/x402', (req, res) => {
    const origin = /\.onrender\.com$/i.test(req.hostname) ? publicUrl : `${req.protocol}://${req.get('host')}`;
    res.json({
      version: 1,
      resources: paidApi.paymentInfo ? [PAID_ROUTE, PREFLIGHT_ROUTE, BATCH_ROUTE, DEEP_ROUTE, FIX_ROUTE].map((route) => `${origin}${route}`) : [],
      name: 'x402 Doctor',
      serviceName: 'x402 Doctor',
      category: 'developer-tools',
      iconUrl: `${origin}/icon.png`,
      tags: ['x402', 'developer-tools', 'diagnostics', 'payments', 'safety', 'pre-payment'],
      description: 'Checks x402 endpoints: a $0.001 pre-payment check for buyers (go / caution / no_go) and a $0.01 full diagnosis with a fix hint per check.',
      openapi: `${origin}/openapi.json`,
      signer: `${origin}/.well-known/x402-doctor-signer.json`,
    });
  });

  // Agent registration (ERC-8004 format) for the Metaplex Agent Registry on Solana:
  // the document the registered agent points to. registrations gets the asset
  // address once the agent is minted.
  app.get('/.well-known/agent-registration.json', (req, res) => res.json({
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: 'x402 Doctor',
    description: 'Checks x402 and MPP paid APIs before an agent pays and before a seller ships: a $0.001 preflight (go / caution / no_go, plus the cheapest option that will settle), batch and deep preflight, a $0.01 full diagnosis with a fix hint per check, and the fix code for $0.05. Paid per call over x402 (USDC on Base or Solana) or MPP (USDC on Base); the web check is free.',
    image: `${publicUrl}/og.jpg`,
    services: [
      { name: 'web', endpoint: `${publicUrl}/` },
      { name: 'MCP', endpoint: `${publicUrl}/mcp`, version: '2025-06-18' },
    ],
    active: true,
    x402Support: true,
    registrations: [
      { agentId: 'CLgJCXbmpJeL4v8KeXb6UGLHcVG4AkNDXKBWQjm1dupj', agentRegistry: 'solana:101:metaplex' },
      // ERC-8004 Identity Registry on Base (registered 4 Oct 2026; tokenURI = this file)
      { agentId: 97519, agentRegistry: 'eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' },
    ],
    supportedTrust: [],
  }));

  // x402 Trust Index (free): the 30-day track record of a scanned resource,
  // from the daily scan of the CDP Bazaar. Sellers can look up their own.
  const trustLimit = rateLimit({ windowMs: 60 * 1000, max: 30 });
  app.get('/api/trust', trustLimit, async (req, res) => {
    const target = req.query.url;
    let parsed;
    try {
      parsed = new URL(String(target));
    } catch {
      return res.status(400).json({ error: 'url is required, e.g. /api/trust?url=https://api.example.com/paid' });
    }
    const record = await trustIndex.lookup(parsed.href, { waitMs: 5000 });
    if (!record) return res.status(404).json({ url: parsed.href, error: 'not in the trust index (only resources listed in the CDP Bazaar or the MPP directory are scanned, once a day)', index: trustIndex.summary() });
    res.json({ url: parsed.href, ...record });
  });
  // A "payable" badge for sellers' READMEs and sites (lib/badge.js): one resource, or a whole origin.
  app.get('/badge.svg', async (req, res) => {
    let parsed;
    try {
      parsed = new URL(String(req.query.url));
      if (!/^https?:$/.test(parsed.protocol)) throw new Error('not http');
    } catch {
      return res.status(400).type('image/svg+xml').send(renderBadge({ message: 'add ?url=…', color: 'grey' }));
    }
    let face;
    try {
      const wholeOrigin = parsed.pathname === '/' || parsed.pathname === '';
      const record = wholeOrigin ? null : await trustIndex.lookup(parsed.href, { waitMs: 5000 });
      const seller = record ? null : await trustIndex.seller(parsed.href, { waitMs: 5000 });
      face = badgeFor({ record, seller });
    } catch {
      face = { message: 'unknown', color: 'grey' };
    }
    res.set('Cache-Control', 'public, max-age=3600, s-maxage=3600').set('Access-Control-Allow-Origin', '*').type('image/svg+xml').send(renderBadge(face));
  });
  app.get('/trust', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'trust.html')));
  app.get('/settlement', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'settlement.html')));
  // Public status of the Fizzl services (lib/status.js); also the home page of status.fizzl.eu when that domain points here.
  const statusBoard = status || createStatus({ trustIndex });
  app.get('/status', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'status.html')));
  app.get('/sellers', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'sellers.html')));
  app.use('/api/status', fizzlCors);
  app.get('/api/status', async (_req, res) => {
    try {
      res.set('Cache-Control', 'public, max-age=60');
      res.json(await statusBoard.snapshot());
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });
  app.use('/api/settlement', fizzlCors);
  app.post('/api/settlement', rateLimit(limits), express.json({ limit: '32kb' }), async (req, res) => {
    const b = req.body || {};
    const header = typeof b.transaction === 'string' && typeof b.network === 'string' ? { transaction: b.transaction, network: b.network, payer: b.payer } : (b.header ?? b.payment_response);
    if (!(header && typeof header === 'object') && (typeof header !== 'string' || !header.trim())) return res.status(400).json({ error: 'Send { "header": "<the PAYMENT-RESPONSE header value>" }, or { "transaction": "…", "network": "eip155:8453" }.' });
    try {
      res.json(await checkPaymentProof(header));
    } catch (err) {
      res.status(err.statusCode || 502).json({ error: err.message });
    }
  });
  // Explainer and paid-fix videos, posters and subtitles (see lib/media.js).
  app.get('/media/:name', media.handler);
  app.media = media;

  // Intentionally broken x402 endpoint for demos and videos: a price written
  // as dollars instead of atomic units, and a Solana option without a fee
  // payer. It always answers 402 and never accepts or settles a payment.
  app.all('/demo/broken', (req, res) => {
    const resourceUrl = `${req.protocol}://${req.get('host')}/demo/broken`;
    const challenge = {
      x402Version: 2,
      error: 'Payment required',
      resource: { url: resourceUrl, description: 'Intentionally broken x402 endpoint for demos (never accepts payment)', mimeType: 'application/json' },
      accepts: [
        // Mistake 1: "0.01" is dollars; x402 amounts are atomic units ("10000" = $0.01 USDC).
        { scheme: 'exact', network: 'eip155:8453', amount: '0.01', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: DEMO_PAY_TO_BASE, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } },
        // Mistake 2: no extra.feePayer, so Solana clients cannot build the transaction.
        { scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', amount: '10000', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', payTo: DEMO_PAY_TO_SOLANA, maxTimeoutSeconds: 60, extra: {} },
      ],
    };
    res.set('X-Demo', 'intentionally broken x402 endpoint; never accepts payment');
    res.set('Cache-Control', 'no-store');
    res.set('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(challenge)).toString('base64'));
    res.status(402).json(challenge);
  });
  app.get('/api/trust/summary', trustLimit, (_req, res) => {
    const summary = trustIndex.summary();
    if (!summary) {
      trustIndex.refresh();
      return res.status(503).json({ error: 'trust index loading, try again shortly' });
    }
    res.json(summary);
  });

  // The free check may also be called from the live demo on fizzl.eu (browser, CORS).
  app.use('/api/diagnose', fizzlCors);
  app.post('/api/diagnose', rateLimit(limits), async (req, res) => {
    const { url: targetUrl, method } = req.body || {};
    if (!targetUrl || typeof targetUrl !== 'string') return res.status(400).json({ error: 'url is required' });
    if (method !== undefined && !['GET', 'POST'].includes(method)) return res.status(400).json({ error: 'method must be GET or POST' });
    try {
      new URL(targetUrl);
    } catch {
      return res.status(400).json({ error: 'Not a valid URL.' });
    }
    if (/^https?:\/\/[^/?#]*https?:/i.test(targetUrl)) return res.status(400).json({ error: 'This looks like two URLs pasted into each other; send only the endpoint URL.' });
    try {
      const report = await diagnoseLib.diagnose(targetUrl, { safeFetch, method, bazaarIndex: bazaar });
      // A broken endpoint with a published contact: a draft for the owner's outreach (never sent from here).
      outreachHook.maybeDraft(targetUrl, report).catch(() => {});
      // The page's own share link, for callers that only see JSON (curl, scripts):
      // opening it runs the same check again in the browser.
      const share = new URLSearchParams({ url: targetUrl, ...(method ? { method } : {}) });
      res.json({ ...report, share_url: `${req.protocol}://${req.get('host')}/?${share}` });
    } catch (err) {
      res.status(err.statusCode || 502).json({ error: err.message, checks: [] });
    }
  });

  // Live numbers for fizzl.eu and its subdomains: totals only (lib/public-stats.js).
  app.get('/api/stats', statsCors, async (_req, res) => {
    try {
      res.set('Cache-Control', 'public, max-age=60');
      res.json(await publicStats.get());
    } catch {
      res.status(503).json({ error: 'stats not available right now' });
    }
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true, paid: paidApi.paymentInfo }));
  return app;
}

// Signed verdicts (lib/receipt.js): present when a signer is configured.
const RECEIPT_SCHEMA = {
  type: 'object',
  description: 'Signature over this whole answer (without receipt.signature), so the verdict can be verified later: EIP-191 personal_sign over canonical JSON (sorted keys, compact, ASCII-escaped). Signer addresses: /.well-known/x402-doctor-signer.json; free check: POST /api/v1/verify.',
  properties: {
    request_id: { type: 'string' },
    route: { type: 'string' },
    input_sha256: { type: 'string', description: 'sha256 of canonical JSON {route, input}: your query parameters as strings' },
    payment: {
      type: 'object',
      description: 'The payment behind this answer, from your x402 payment payload. EVM: payer + EIP-3009 nonce; find the settlement as AuthorizationUsed(payer, nonce) on the asset contract. Solana: payer + sha256 of the signed transaction you sent.',
      properties: {
        network: { type: 'string' }, asset: { type: 'string' }, amount: { type: 'string' }, pay_to: { type: 'string' },
        payer: { type: 'string' }, nonce: { type: 'string' }, transaction_sha256: { type: 'string' },
        proof: { type: 'string', enum: ['eip3009', 'svm-transaction'] },
      },
    },
    cert: {
      type: 'object',
      description: "The payout wallet's certificate for this signing key: personal_sign by authority over 'fizzl receipt signer\\nservice: <service>\\nsigner: <signer>\\nvalid_from: <date>'. Pin the payout wallet and a rotated key still verifies.",
      properties: { service: { type: 'string' }, signer: { type: 'string' }, valid_from: { type: 'string' }, authority: { type: 'string' }, signature: { type: 'string' } },
    },
    signed_at: { type: 'string' },
    signer: { type: 'string' },
    algorithm: { type: 'string', enum: ['eip191-canonical-json-v1'] },
    signature: { type: 'string' },
  },
  required: ['request_id', 'route', 'input_sha256', 'signed_at', 'signer', 'algorithm', 'signature'],
};
const withReceipt = (schema) => (schema && schema.properties ? { ...schema, properties: { ...schema.properties, receipt: RECEIPT_SCHEMA } } : schema);

function openApi(origin, payment) {
  const spec = {
    openapi: '3.1.0',
    info: {
      title: 'x402 Doctor',
      version: '2.5.0',
      description: "Diagnoses why an x402, MPP or L402 payment endpoint is broken, without a funded wallet: challenge format (x402, MPP and L402 / Lightning), accepts[], resource URL, Solana settlement readiness, discovery and browser paywall.",
      'x-guidance': 'Before paying an unknown x402 endpoint, call GET /api/v1/preflight?url=<endpoint>&max_usd=<budget> ($0.001): it answers go, caution or no_go with the recommended payment option and the reasons. Checking several endpoints at once: GET /api/v1/preflight/batch?url=<a>&url=<b> (up to 10, $0.005). Before an expensive call: GET /api/v1/preflight/deep?url=<endpoint> ($0.01) adds the full diagnosis, the daily history, the other endpoints of the same seller and domain moves. To debug your own endpoint, call GET /api/v1/diagnose?url=<endpoint> ($0.01): every check with pass/warn/fail and a fix hint. To get the code that fixes it, call GET /api/v1/fix?url=<endpoint> ($0.05): per problem the concrete change for your stack, filled in with your own values. None of them ever pays the endpoint. Every paid answer carries a signed receipt: keep it to prove later which verdict you got (for example why you paid an endpoint); the signer is at /.well-known/x402-doctor-signer.json and POST /api/v1/verify checks one for free.',
    },
    servers: [{ url: origin }],
    paths: {},
  };
  if (!payment) return spec;
  spec.paths[PAID_ROUTE] = {
    get: {
      operationId: 'diagnoseX402Endpoint',
      summary: 'Check an x402 endpoint for payment problems',
      tags: ['x402', 'developer-tools'],
      'x-payment-info': {
        protocols: ['x402'],
        price: { mode: 'fixed', currency: 'USD', amount: payment.price.replace(/^\$/, '') },
        networks: payment.networks,
        asset: 'USDC',
      },
      parameters: [
        { name: 'url', in: 'query', required: true, example: 'https://ichimoku-signal.fizzl.eu/signal/BTC-USDT', schema: { type: 'string', format: 'uri' }, description: 'The x402 endpoint to diagnose' },
        { name: 'method', in: 'query', required: false, schema: { type: 'string', enum: ['GET', 'POST'] }, description: 'Endpoint method; default tries GET then POST' },
      ],
      responses: {
        200: { description: 'Diagnosis report', content: { 'application/json': { schema: withReceipt(REPORT_SCHEMA) } } },
        400: { description: 'Invalid input (rejected before payment)' },
        402: { description: 'Payment required (x402 challenge in the PAYMENT-REQUIRED header, mirrored in the body)' },
      },
    },
  };
  spec.paths[PREFLIGHT_ROUTE] = {
    get: {
      operationId: 'preflightX402Payment',
      summary: 'Check an x402 endpoint before paying it',
      tags: ['x402', 'payments'],
      'x-payment-info': {
        protocols: ['x402'],
        price: { mode: 'fixed', currency: 'USD', amount: payment.preflight.price.replace(/^\$/, '') },
        networks: payment.networks,
        asset: 'USDC',
      },
      parameters: [
        { name: 'url', in: 'query', required: true, example: 'https://ichimoku-signal.fizzl.eu/signal/BTC-USDT', schema: { type: 'string', format: 'uri' }, description: 'The x402 endpoint you are about to pay' },
        { name: 'method', in: 'query', required: false, schema: { type: 'string', enum: ['GET', 'POST'] }, description: 'Method you will call it with; default tries GET then POST' },
        { name: 'max_usd', in: 'query', required: false, example: '0.05', schema: { type: 'string' }, description: 'Your budget per call in USD; above it the verdict is no_go' },
        { name: 'network', in: 'query', required: false, schema: { type: 'string' }, description: 'CAIP-2 network you want to pay on, e.g. eip155:8453' },
      ],
      responses: {
        200: { description: 'Verdict (go / caution / no_go), recommended option and reasons', content: { 'application/json': { schema: withReceipt(PREFLIGHT_SCHEMA) } } },
        400: { description: 'Invalid input (rejected before payment)' },
        402: { description: 'Payment required (x402 challenge in the PAYMENT-REQUIRED header, mirrored in the body)' },
      },
    },
  };
  const buyerParams = [
    { name: 'method', in: 'query', required: false, schema: { type: 'string', enum: ['GET', 'POST'] }, description: 'Method you will call it with; default tries GET then POST' },
    { name: 'max_usd', in: 'query', required: false, example: '0.05', schema: { type: 'string' }, description: 'Your budget per call in USD; above it the verdict is no_go' },
    { name: 'network', in: 'query', required: false, schema: { type: 'string' }, description: 'CAIP-2 network you want to pay on, e.g. eip155:8453' },
  ];
  const paidResponses = (description, schema) => ({
    200: { description, content: { 'application/json': { schema: withReceipt(schema) } } },
    400: { description: 'Invalid input (rejected before payment)' },
    402: { description: 'Payment required (x402 challenge in the PAYMENT-REQUIRED header, mirrored in the body)' },
  });
  const paymentInfo = (price) => ({ protocols: ['x402'], price: { mode: 'fixed', currency: 'USD', amount: price.replace(/^\$/, '') }, networks: payment.networks, asset: 'USDC' });
  if (payment.batch) {
    spec.paths[BATCH_ROUTE] = {
      get: {
        operationId: 'preflightX402Batch',
        summary: `Check up to ${payment.batch.max_urls} x402 endpoints before paying them`,
        tags: ['x402', 'payments'],
        'x-payment-info': paymentInfo(payment.batch.price),
        parameters: [
          { name: 'url', in: 'query', required: true, style: 'form', explode: true, example: ['https://ichimoku-signal.fizzl.eu/signal/BTC-USDT', 'https://presign-guard.fizzl.eu/v1/token'], schema: { type: 'array', maxItems: payment.batch.max_urls, items: { type: 'string', format: 'uri' } }, description: `The x402 endpoints, one url parameter each (?url=a&url=b), at most ${payment.batch.max_urls}` },
          ...buyerParams,
        ],
        responses: paidResponses('Per endpoint go / caution / no_go (or unknown), the recommended option and reasons, plus totals', BATCH_SCHEMA),
      },
    };
  }
  if (payment.deep) {
    spec.paths[DEEP_ROUTE] = {
      get: {
        operationId: 'preflightX402Deep',
        summary: 'Deep check of an x402 endpoint before an expensive payment',
        tags: ['x402', 'payments'],
        'x-payment-info': paymentInfo(payment.deep.price),
        parameters: [
          { name: 'url', in: 'query', required: true, example: 'https://ichimoku-signal.fizzl.eu/setups', schema: { type: 'string', format: 'uri' }, description: 'The x402 endpoint you are about to pay' },
          ...buyerParams,
        ],
        responses: paidResponses('The preflight verdict plus the full diagnosis, daily history, seller reliability and domain-move checks', DEEP_SCHEMA),
      },
    };
  }
  spec.paths[FIX_ROUTE] = {
    get: {
      operationId: 'fixX402Endpoint',
      summary: 'Get the code that fixes an x402 endpoint',
      tags: ['x402', 'developer-tools'],
      'x-payment-info': {
        protocols: ['x402'],
        price: { mode: 'fixed', currency: 'USD', amount: payment.fix.price.replace(/^\$/, '') },
        networks: payment.networks,
        asset: 'USDC',
      },
      parameters: [
        { name: 'url', in: 'query', required: true, example: 'https://x402-doctor.fizzl.eu/demo/broken', schema: { type: 'string', format: 'uri' }, description: 'Your x402 endpoint' },
        { name: 'method', in: 'query', required: false, schema: { type: 'string', enum: ['GET', 'POST'] }, description: 'Endpoint method; default tries GET then POST' },
        { name: 'stack', in: 'query', required: false, schema: { type: 'string', enum: Object.keys(STACKS) }, description: 'Your stack, if detection from the response headers is wrong' },
      ],
      responses: {
        200: { description: 'Per problem: why, steps and code for your stack', content: { 'application/json': { schema: withReceipt(FIX_SCHEMA) } } },
        400: { description: 'Invalid input (rejected before payment)' },
        402: { description: 'Payment required (x402 challenge in the PAYMENT-REQUIRED header, mirrored in the body)' },
      },
    },
  };
  // MPP discovery for MPPScan (mpp-pay.js): the evm (and tempo) offer next to the x402 fields.
  if (payment.mpp) addMppOffers(spec, { categories: ['payments', 'developer-tools', 'security'], docs: { homepage: origin, apiReference: `${origin}/openapi.json`, llms: `${origin}/skill.md` }, contact: { name: 'Fizzl', url: 'https://fizzl.eu' }, tempo: payment.mpp.tempo });
  return spec;
}

const app = createApp();

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`x402 Doctor running on port ${PORT}`);
    app.media.warm();
  });
}

// checks and helpers stay importable from server.js for existing callers/tests
module.exports = {
  app,
  createApp,
  isPrivateIp,
  protocolOf,
  PORT,
  decodeChallengeValue: diagnoseLib.decodeChallengeValue,
  checkEnvelope: diagnoseLib.checkEnvelope,
  checkAccepts: diagnoseLib.checkAccepts,
  diagnose: diagnoseLib.diagnose,
};
