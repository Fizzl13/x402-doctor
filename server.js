const express = require('express');
const path = require('path');
const { createSafeFetch, isPrivateIp } = require('./lib/safe-fetch');
const diagnoseLib = require('./lib/diagnose');
const { createPaidApi, ROUTE: PAID_ROUTE, PREFLIGHT_ROUTE, FIX_ROUTE, REPORT_SCHEMA, FIX_SCHEMA } = require('./lib/paid-api');
const { STACKS } = require('./lib/stack');
const { PREFLIGHT_SCHEMA } = require('./lib/preflight');
const { createTrustIndex } = require('./lib/trust-index');
const { createMediaCache } = require('./lib/media');
const crypto = require('crypto');
const { createUsageLog, mcpToolCall, mcpPayment } = require('./lib/usage-log');
const { createUsageReader } = require('./lib/usage-reader');

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
// What each Doctor call was about, for the usage log (null = not logged).
function describeDoctorCall(req, _res, body) {
  const b = body || {};
  if (req.method === 'POST' && req.path === '/api/diagnose') {
    return { route: 'diagnose', via: 'web', input: { url: req.body && req.body.url, method: req.body && req.body.method }, result: { overall: b.overall, error: b.error } };
  }
  if (req.method === 'GET' && req.path === PAID_ROUTE) {
    return { route: 'diagnose', via: 'api', input: { url: req.query.url, method: req.query.method }, result: { overall: b.overall, error: b.error } };
  }
  if (req.method === 'GET' && req.path === FIX_ROUTE) {
    return { route: 'fix', via: 'api', input: { url: req.query.url, method: req.query.method, stack: req.query.stack }, result: { stack: b.stack && b.stack.id, fixes: Array.isArray(b.fixes) ? b.fixes.map((f) => f.recipe).join(', ') || 'none' : undefined, error: b.error } };
  }
  if (req.method === 'GET' && req.path === PREFLIGHT_ROUTE) {
    return { route: 'preflight', via: 'api', input: { url: req.query.url, max_usd: req.query.max_usd, network: req.query.network }, result: { verdict: b.verdict, error: b.error } };
  }
  if (req.method === 'POST' && req.path === '/mcp') {
    const call = mcpToolCall(req.body);
    if (!call) return null; // initialize, tools/list
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
      result: { overall: parsed && parsed.overall, verdict: parsed && parsed.verdict, error: reply.result && reply.result.isError ? String(text).slice(0, 200) : undefined },
      payment: mcpPayment(req.body, body),
    };
  }
  if (req.method === 'GET' && req.path === '/api/trust') {
    return { route: 'trust lookup', via: 'web', input: { url: req.query.url }, result: { found: Boolean(b.url && !b.error) } };
  }
  return null;
}

// HTTP Basic auth against ADMIN_PASSWORD (any user name). Without the
// setting the admin pages do not exist.
function adminAuth(env) {
  return (req, res, next) => {
    const password = env.ADMIN_PASSWORD;
    if (!password) return res.status(404).send('Not found');
    const header = req.get('authorization') || '';
    const given = header.startsWith('Basic ') ? Buffer.from(header.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':') : '';
    const a = crypto.createHash('sha256').update(given).digest();
    const b = crypto.createHash('sha256').update(password).digest();
    if (given && crypto.timingSafeEqual(a, b)) return next();
    res.set('WWW-Authenticate', 'Basic realm="Fizzl usage", charset="UTF-8"');
    res.status(401).send('Password required');
  };
}

function createApp({ allowPrivate = false, rateLimit: limits = RATE_LIMIT, env = process.env, bazaarIndex, trustIndex = createTrustIndex(), media = createMediaCache(), usageLog = createUsageLog({ service: 'doctor', env }), usageReader = createUsageReader({ env }) } = {}) {
  const app = express();
  const safeFetch = createSafeFetch({ allowPrivate });
  const paidApi = createPaidApi({ safeFetch, env, trustIndex, ...(bazaarIndex ? { bazaarIndex } : {}) });

  app.set('trust proxy', 1);
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
      res.json(await usageReader.load({ days }));
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.use(express.static(path.join(__dirname, 'public')));

  // Paid agent API (x402). The web page below stays free and rate-limited.
  app.use(paidApi);
  app.get('/openapi.json', (req, res) => res.json(openApi(`${req.protocol}://${req.get('host')}`, paidApi.paymentInfo)));
  app.get('/.well-known/x402', (req, res) => {
    const origin = `${req.protocol}://${req.get('host')}`;
    res.json({
      version: 1,
      resources: paidApi.paymentInfo ? [`${origin}${PAID_ROUTE}`, `${origin}${PREFLIGHT_ROUTE}`, `${origin}${FIX_ROUTE}`] : [],
      name: 'x402 Doctor',
      description: 'Checks x402 endpoints: a $0.001 pre-payment check for buyers (go / caution / no_go) and a $0.01 full diagnosis with a fix hint per check.',
      openapi: `${origin}/openapi.json`,
    });
  });

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
    if (!record) return res.status(404).json({ url: parsed.href, error: 'not in the trust index (only resources listed in the CDP Bazaar are scanned, once a day)', index: trustIndex.summary() });
    res.json({ url: parsed.href, ...record });
  });
  app.get('/trust', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'trust.html')));
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

  app.post('/api/diagnose', rateLimit(limits), async (req, res) => {
    const { url: targetUrl, method } = req.body || {};
    if (!targetUrl || typeof targetUrl !== 'string') return res.status(400).json({ error: 'url is required' });
    if (method !== undefined && !['GET', 'POST'].includes(method)) return res.status(400).json({ error: 'method must be GET or POST' });
    try {
      new URL(targetUrl);
    } catch {
      return res.status(400).json({ error: 'Not a valid URL.' });
    }
    try {
      const report = await diagnoseLib.diagnose(targetUrl, { safeFetch, method });
      res.json(report);
    } catch (err) {
      res.status(err.statusCode || 502).json({ error: err.message, checks: [] });
    }
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true, paid: paidApi.paymentInfo }));
  return app;
}

function openApi(origin, payment) {
  const spec = {
    openapi: '3.1.0',
    info: {
      title: 'x402 Doctor',
      version: '2.3.0',
      description: "Diagnoses why an x402-payable endpoint's payment flow is broken, without a funded wallet: challenge format, accepts[], resource URL, Solana settlement readiness, discovery and browser paywall.",
      'x-guidance': 'Before paying an unknown x402 endpoint, call GET /api/v1/preflight?url=<endpoint>&max_usd=<budget> ($0.001): it answers go, caution or no_go with the recommended payment option and the reasons. To debug your own endpoint, call GET /api/v1/diagnose?url=<endpoint> ($0.01): every check with pass/warn/fail and a fix hint. To get the code that fixes it, call GET /api/v1/fix?url=<endpoint> ($0.05): per problem the concrete change for your stack, filled in with your own values. None of them ever pays the endpoint.',
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
        { name: 'url', in: 'query', required: true, example: 'https://ichimoku-signal.onrender.com/signal/BTC-USDT', schema: { type: 'string', format: 'uri' }, description: 'The x402 endpoint to diagnose' },
        { name: 'method', in: 'query', required: false, schema: { type: 'string', enum: ['GET', 'POST'] }, description: 'Endpoint method; default tries GET then POST' },
      ],
      responses: {
        200: { description: 'Diagnosis report', content: { 'application/json': { schema: REPORT_SCHEMA } } },
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
        { name: 'url', in: 'query', required: true, example: 'https://ichimoku-signal.onrender.com/signal/BTC-USDT', schema: { type: 'string', format: 'uri' }, description: 'The x402 endpoint you are about to pay' },
        { name: 'method', in: 'query', required: false, schema: { type: 'string', enum: ['GET', 'POST'] }, description: 'Method you will call it with; default tries GET then POST' },
        { name: 'max_usd', in: 'query', required: false, example: '0.05', schema: { type: 'string' }, description: 'Your budget per call in USD; above it the verdict is no_go' },
        { name: 'network', in: 'query', required: false, schema: { type: 'string' }, description: 'CAIP-2 network you want to pay on, e.g. eip155:8453' },
      ],
      responses: {
        200: { description: 'Verdict (go / caution / no_go), recommended option and reasons', content: { 'application/json': { schema: PREFLIGHT_SCHEMA } } },
        400: { description: 'Invalid input (rejected before payment)' },
        402: { description: 'Payment required (x402 challenge in the PAYMENT-REQUIRED header, mirrored in the body)' },
      },
    },
  };
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
        { name: 'url', in: 'query', required: true, example: 'https://x402-doctor.onrender.com/demo/broken', schema: { type: 'string', format: 'uri' }, description: 'Your x402 endpoint' },
        { name: 'method', in: 'query', required: false, schema: { type: 'string', enum: ['GET', 'POST'] }, description: 'Endpoint method; default tries GET then POST' },
        { name: 'stack', in: 'query', required: false, schema: { type: 'string', enum: Object.keys(STACKS) }, description: 'Your stack, if detection from the response headers is wrong' },
      ],
      responses: {
        200: { description: 'Per problem: why, steps and code for your stack', content: { 'application/json': { schema: FIX_SCHEMA } } },
        400: { description: 'Invalid input (rejected before payment)' },
        402: { description: 'Payment required (x402 challenge in the PAYMENT-REQUIRED header, mirrored in the body)' },
      },
    },
  };
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
  PORT,
  decodeChallengeValue: diagnoseLib.decodeChallengeValue,
  checkEnvelope: diagnoseLib.checkEnvelope,
  checkAccepts: diagnoseLib.checkAccepts,
  diagnose: diagnoseLib.diagnose,
};
