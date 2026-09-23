// Paid agent API: GET /api/v1/diagnose?url=...&method=GET|POST
//
// The same diagnosis as the free web page, sold per call over x402 so agents
// and CI pipelines can use it without the web page's rate limit. Payment is
// USDC on Base and/or Solana (whichever payout wallet is configured). With
// CDP_API_KEY_ID/CDP_API_KEY_SECRET set, Coinbase's CDP facilitator verifies
// and settles first (payments through it get the route listed in the CDP
// Bazaar), with PayAI as fallback for any network CDP does not support.
// The x402 middleware only settles after a successful (2xx) response, so a
// diagnosis that errors out is never charged.

const express = require('express');
const { paymentMiddleware, x402ResourceServer } = require('@x402/express');
const { HTTPFacilitatorClient } = require('@x402/core/server');
const { ExactEvmScheme } = require('@x402/evm/exact/server');
const { ExactSvmScheme } = require('@x402/svm/exact/server');
const { declareDiscoveryExtension } = require('@x402/extensions/bazaar');
const { createPaywall, evmPaywall, svmPaywall } = require('@x402/paywall');
const { createFacilitatorConfig } = require('@coinbase/x402');
const diagnoseLib = require('./diagnose');
const { createPreflight, PREFLIGHT_SCHEMA } = require('./preflight');
const { createBazaarIndex } = require('./bazaar-index');

const BASE = 'eip155:8453';
const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const ROUTE = '/api/v1/diagnose';
const PREFLIGHT_ROUTE = '/api/v1/preflight';
const DEFAULT_PRICE = '$0.01';
const DEFAULT_PREFLIGHT_PRICE = '$0.001';
const DEFAULT_FACILITATOR = 'https://facilitator.payai.network';

const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    url: { type: 'string' },
    method: { type: ['string', 'null'], enum: ['GET', 'POST', null] },
    overall: { type: 'string', enum: ['pass', 'warn', 'fail'] },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          group: { type: 'string', enum: ['challenge', 'accepts', 'resource', 'settlement', 'discovery', 'browser'] },
          status: { type: 'string', enum: ['pass', 'warn', 'fail', 'skip'] },
          message: { type: 'string' },
          hint: { type: 'string' },
        },
        required: ['id', 'status', 'message'],
      },
    },
    challenge: { type: ['object', 'null'] },
  },
  required: ['url', 'overall', 'checks'],
};

function paymentConfig(env) {
  const price = env.DOCTOR_PRICE || DEFAULT_PRICE;
  const preflightPrice = env.DOCTOR_PREFLIGHT_PRICE || DEFAULT_PREFLIGHT_PRICE;
  const base = env.DOCTOR_PAYOUT_WALLET || env.AGENT_PAYOUT_WALLET;
  const solana = env.DOCTOR_PAYOUT_WALLET_SOLANA || env.AGENT_PAYOUT_WALLET_SOLANA;
  const acceptsFor = (p) => [
    ...(base ? [{ scheme: 'exact', price: p, network: BASE, payTo: base }] : []),
    ...(solana ? [{ scheme: 'exact', price: p, network: SOLANA, payTo: solana }] : []),
  ];
  return { price, preflightPrice, accepts: acceptsFor(price), preflightAccepts: acceptsFor(preflightPrice) };
}

// Rejects clearly wrong input before the paywall, so nobody signs a payment
// for a request that can only fail. A missing url is let through on purpose:
// indexers such as x402scan probe the bare route and need the 402 challenge
// (with the input schema) to register it. Paying without a url gets a 400,
// and a non-2xx response is never settled.
function validate(req, res, next) {
  const { url, method } = req.query;
  if (method !== undefined && !['GET', 'POST'].includes(method)) {
    return res.status(400).json({ error: 'method must be GET or POST' });
  }
  if (url === undefined) return next();
  if (req.query.max_usd !== undefined && !(Number(req.query.max_usd) > 0)) {
    return res.status(400).json({ error: 'max_usd must be a positive number, e.g. 0.05' });
  }
  if (req.query.network !== undefined && !/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/.test(String(req.query.network))) {
    return res.status(400).json({ error: 'network must be a CAIP-2 id, e.g. eip155:8453 or solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' });
  }
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return res.status(400).json({ error: 'url is not a valid URL' });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ error: 'url must be http(s)' });
  }
  next();
}

// @x402/express puts the v2 challenge only in the PAYMENT-REQUIRED header;
// some clients read accepts[] from the body, so mirror it there.
function mirrorChallengeIntoBody(_req, res, next) {
  const json = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode === 402 && !(body && Array.isArray(body.accepts))) {
      const header = res.getHeader('PAYMENT-REQUIRED');
      if (header) {
        try {
          const challenge = JSON.parse(Buffer.from(String(header), 'base64').toString('utf8'));
          if (Array.isArray(challenge.accepts)) {
            body = { ...(body || {}), x402Version: challenge.x402Version, accepts: challenge.accepts };
            if (challenge.error) body.error = challenge.error;
          }
        } catch {
          // leave the body as is
        }
      }
    }
    return json(body);
  };
  next();
}

function createPaidApi({ safeFetch, env = process.env, bazaarIndex = createBazaarIndex() } = {}) {
  const router = express.Router();
  const { price, preflightPrice, accepts, preflightAccepts } = paymentConfig(env);

  if (accepts.length === 0) {
    const off = (_req, res) => res.status(503).json({ error: 'paid API not configured (set AGENT_PAYOUT_WALLET and/or AGENT_PAYOUT_WALLET_SOLANA)' });
    router.get(ROUTE, off);
    router.get(PREFLIGHT_ROUTE, off);
    router.paymentInfo = null;
    return router;
  }

  const facilitators = [];
  const useCdp = Boolean(env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET);
  if (useCdp) facilitators.push(new HTTPFacilitatorClient(createFacilitatorConfig(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET)));
  facilitators.push(new HTTPFacilitatorClient({ url: env.FACILITATOR_URL || DEFAULT_FACILITATOR }));
  // The first facilitator that supports a network handles it.
  const resourceServer = new x402ResourceServer(facilitators)
    .register(BASE, new ExactEvmScheme())
    .register(SOLANA, new ExactSvmScheme());

  // Browsers get a wallet-connect page instead of the bare 402. It offers the
  // first accepts[] option, Base, where MetaMask and Coinbase Wallet work.
  const paywall = createPaywall()
    .withNetwork(evmPaywall)
    .withNetwork(svmPaywall)
    .withConfig({ appName: 'x402 Doctor', testnet: false })
    .build();

  const example = 'https://ichimoku-signal.onrender.com/signal/BTC-USDT';
  const discovery = declareDiscoveryExtension({
    method: 'GET',
    input: { url: example, method: 'GET' },
    inputSchema: {
      properties: {
        url: { type: 'string', description: 'The x402 endpoint to diagnose (public http(s) URL).' },
        method: { type: 'string', enum: ['GET', 'POST'], description: 'HTTP method of the endpoint. Default: try GET, then POST.' },
      },
      required: ['url'],
    },
    output: {
      schema: REPORT_SCHEMA,
      example: {
        url: example,
        method: 'GET',
        overall: 'pass',
        checks: [{ id: 'returns-402', group: 'challenge', status: 'pass', message: 'Endpoint returns 402 Payment Required for GET.' }],
        challenge: null,
      },
    },
  });

  const preflightExample = 'https://ichimoku-signal.onrender.com/signal/BTC-USDT';
  const preflightDiscovery = declareDiscoveryExtension({
    method: 'GET',
    input: { url: preflightExample, max_usd: '0.05' },
    inputSchema: {
      properties: {
        url: { type: 'string', description: 'The x402 endpoint you are about to pay.' },
        method: { type: 'string', enum: ['GET', 'POST'], description: 'HTTP method you will call it with. Default: try GET, then POST.' },
        max_usd: { type: 'string', description: 'Your budget per call in USD; above it the verdict is no_go.' },
        network: { type: 'string', description: 'CAIP-2 network you want to pay on, e.g. eip155:8453 or solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp.' },
      },
      required: ['url'],
    },
    output: {
      schema: PREFLIGHT_SCHEMA,
      example: {
        url: preflightExample,
        method: 'GET',
        verdict: 'go',
        safe_to_pay: true,
        summary: 'OK to pay: $0.02 on Base.',
        recommended_option: 0,
        options: [{ index: 0, network: BASE, network_name: 'Base', asset_symbol: 'USDC', amount: '20000', usd: 0.02, pay_to: '0x6B0F4651eD42893ab58139938175E4a69f175F25', payable: true, problems: [] }],
        signals: { https: true, advertised_price_usd: 0.02, listed_in_cdp_bazaar: false },
        reasons: [],
        checked_at: '2026-09-23T17:00:00.000Z',
        cached: false,
      },
    },
  });
  const runPreflight = createPreflight({ safeFetch, bazaarIndex });
  // Load the Bazaar index at startup (it takes longer than a request waits),
  // so the first pre-payment checks already carry the listing signal.
  if (env.DOCTOR_WARM_BAZAAR_INDEX !== '0') bazaarIndex.refresh?.();

  router.get(ROUTE, validate);
  router.get(PREFLIGHT_ROUTE, validate);
  router.use(mirrorChallengeIntoBody);
  router.use(
    paymentMiddleware(
      {
        [`GET ${ROUTE}`]: {
          accepts,
          description:
            "Diagnose an x402 endpoint: challenge format, accepts[], resource URL, Solana settlement readiness, Bazaar/OpenAPI discovery and browser paywall. Returns every check with a fix hint.",
          mimeType: 'application/json',
          serviceName: 'x402 Doctor',
          tags: ['x402', 'developer-tools', 'diagnostics', 'payments'],
          extensions: discovery,
        },
        [`GET ${PREFLIGHT_ROUTE}`]: {
          accepts: preflightAccepts,
          description:
            'Check an x402 endpoint before paying it: go / caution / no_go, the recommended payment option, and why (payment would fail, over your budget, price above advertised, not HTTPS, unknown token). Never pays the endpoint. Cached 10 min.',
          mimeType: 'application/json',
          serviceName: 'x402 Doctor',
          tags: ['x402', 'payments', 'safety', 'pre-payment'],
          extensions: preflightDiscovery,
        },
      },
      resourceServer,
      { appName: 'x402 Doctor', testnet: false },
      paywall
    )
  );

  router.get(ROUTE, async (req, res) => {
    const { url, method } = req.query;
    if (url === undefined) return res.status(400).json({ error: 'url is required, e.g. ?url=https://api.example.com/paid' });
    try {
      res.json(await diagnoseLib.diagnose(String(url), { safeFetch, method }));
    } catch (err) {
      res.status(err.statusCode || 502).json({ error: err.message });
    }
  });

  router.get(PREFLIGHT_ROUTE, async (req, res) => {
    const { url, method, max_usd: maxUsd, network } = req.query;
    if (url === undefined) return res.status(400).json({ error: 'url is required, e.g. ?url=https://api.example.com/paid&max_usd=0.05' });
    try {
      res.json(await runPreflight(String(url), { method, maxUsd: maxUsd === undefined ? undefined : Number(maxUsd), network }));
    } catch (err) {
      res.status(err.statusCode || 502).json({ error: err.message });
    }
  });

  router.paymentInfo = {
    route: ROUTE,
    price,
    networks: accepts.map((a) => a.network),
    facilitator: useCdp ? 'cdp, payai fallback' : 'payai',
    preflight: { route: PREFLIGHT_ROUTE, price: preflightPrice },
  };
  return router;
}

module.exports = { createPaidApi, ROUTE, PREFLIGHT_ROUTE, REPORT_SCHEMA, paymentConfig };
