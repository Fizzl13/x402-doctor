const express = require('express');
const path = require('path');
const { createSafeFetch, isPrivateIp } = require('./lib/safe-fetch');
const diagnoseLib = require('./lib/diagnose');

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
function createApp({ allowPrivate = false, rateLimit: limits = RATE_LIMIT } = {}) {
  const app = express();
  const safeFetch = createSafeFetch({ allowPrivate });

  app.set('trust proxy', 1);
  app.use(express.json({ limit: '4kb' }));
  app.use(express.static(path.join(__dirname, 'public')));

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

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  return app;
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
