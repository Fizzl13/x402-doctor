const express = require('express');
const path = require('path');
const { createSafeFetch, isPrivateIp } = require('./lib/safe-fetch');
const diagnoseLib = require('./lib/diagnose');
const { createPaidApi, ROUTE: PAID_ROUTE, REPORT_SCHEMA } = require('./lib/paid-api');

const PORT = process.env.PORT || 3001;
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
function createApp({ allowPrivate = false, rateLimit: limits = RATE_LIMIT, env = process.env } = {}) {
  const app = express();
  const safeFetch = createSafeFetch({ allowPrivate });
  const paidApi = createPaidApi({ safeFetch, env });

  app.set('trust proxy', 1);
  app.use(express.json({ limit: '4kb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  // Paid agent API (x402). The web page below stays free and rate-limited.
  app.use(paidApi);
  app.get('/openapi.json', (req, res) => res.json(openApi(`${req.protocol}://${req.get('host')}`, paidApi.paymentInfo)));
  app.get('/.well-known/x402', (req, res) => {
    const origin = `${req.protocol}://${req.get('host')}`;
    res.json({
      version: 1,
      resources: paidApi.paymentInfo ? [`${origin}${PAID_ROUTE}`] : [],
      name: 'x402 Doctor',
      description: 'Diagnoses why an x402 endpoint\'s payment flow is broken, with a fix hint per check.',
      openapi: `${origin}/openapi.json`,
    });
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
    openapi: '3.0.3',
    info: {
      title: 'x402 Doctor',
      version: '2.1.0',
      description: "Diagnoses why an x402-payable endpoint's payment flow is broken, without a funded wallet: challenge format, accepts[], resource URL, Solana settlement readiness, discovery and browser paywall.",
      'x-guidance': 'Use GET /api/v1/diagnose?url=<endpoint> when you need to know whether an x402 endpoint will accept payments from agents, or why it does not. It returns every check with pass/warn/fail and a hint to fix it. It never pays the endpoint it diagnoses.',
    },
    servers: [{ url: origin }],
    paths: {},
  };
  if (!payment) return spec;
  spec.paths[PAID_ROUTE] = {
    get: {
      operationId: 'diagnoseX402Endpoint',
      summary: 'Diagnose an x402 endpoint',
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
  return spec;
}

const app = createApp();

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`x402 Doctor running on port ${PORT}`);
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
