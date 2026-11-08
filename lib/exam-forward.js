// The Agent Safety exam (exam.fizzl.eu, x402-examples/agent-safety-bench/src/exam): an agent under exam may ask
// x402 Doctor about the exam's sellers, as it would about any seller. Those sellers are simulated, and what Doctor
// "knows" about them (their track record, a test purchase, other buyers' reports) belongs to the exam's scenario, so a
// preflight, trust check or outcome report whose url is an exam address is forwarded to the exam's own Doctor, which
// runs this same code against the scenario. The answer comes back as it is (a 402 on Base Sepolia included: the exam's
// money is testnet only); a 200 from the preflight routes is signed like any paid answer, so clients that check
// Doctor's receipts (x402-safe-fetch) behave in the exam as they do outside it. Nothing else is ever forwarded.

'use strict';

const { paymentFromHeaders } = require('./receipt');

const DEFAULT_ORIGIN = 'https://exam.fizzl.eu';
const FORWARDED = new Set(['/api/v1/preflight', '/api/v1/preflight/batch', '/api/v1/preflight/deep', '/api/trust', '/api/v1/outcome']);
const SIGNED = new Set(['/api/v1/preflight', '/api/v1/preflight/batch', '/api/v1/preflight/deep']);
const PASS_HEADERS = ['payment-signature', 'x-payment', 'content-type', 'accept'];
const BACK_HEADERS = ['content-type', 'payment-required', 'payment-response', 'retry-after'];

// The exam sitting and task an address belongs to: "<origin>/e/<exam>/<task>", or null.
function examPrefix(raw, origin) {
  if (typeof raw !== 'string' || !raw.startsWith(`${origin}/e/`)) return null;
  const m = raw.slice(origin.length).match(/^\/e\/([0-9a-f]{24})\/(t\d{1,2})\//);
  return m ? `${origin}/e/${m[1]}/${m[2]}` : null;
}

function createExamForward({ origin = process.env.EXAM_ORIGIN || DEFAULT_ORIGIN, signer = null, fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
  origin = origin.replace(/\/$/, '');
  return async function examForward(req, res, next) {
    if (!FORWARDED.has(req.path) || !['GET', 'POST'].includes(req.method)) return next();
    const q = req.query.url;
    const targets = (Array.isArray(q) ? q : q !== undefined ? [q] : req.method === 'POST' && req.body && typeof req.body.url === 'string' ? [req.body.url] : []).map(String);
    if (!targets.length) return next();
    const prefixes = new Set(targets.map((t) => examPrefix(t, origin)));
    if (prefixes.has(null) || prefixes.size !== 1) return next();
    const [prefix] = prefixes;
    const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    const headers = {};
    for (const h of PASS_HEADERS) if (req.get(h)) headers[h] = req.get(h);
    let upstream;
    try {
      upstream = await fetchImpl(`${prefix}/x402-doctor.fizzl.eu${req.path}${qs}`, {
        method: req.method,
        headers,
        ...(req.method === 'POST' ? { body: req.body && typeof req.body === 'object' ? JSON.stringify(req.body) : '' } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      return res.status(502).json({ error: `the Agent Safety exam did not answer: ${err.message}` });
    }
    const text = await upstream.text();
    for (const h of BACK_HEADERS) {
      const v = upstream.headers.get(h);
      if (v) res.set(h, v);
    }
    res.set('cache-control', 'no-store');
    if (upstream.status === 200 && signer && SIGNED.has(req.path)) {
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        const route = `GET ${req.path}`;
        const signed = await signer.sign(body, { route, input: { ...req.query }, payment: paymentFromHeaders(req.headers) }).catch(() => body);
        return res.status(200).json(signed);
      }
    }
    return res.status(upstream.status).send(text);
  };
}

module.exports = { createExamForward, examPrefix };
