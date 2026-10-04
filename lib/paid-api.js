// Paid agent API: GET /api/v1/diagnose?url=...&method=GET|POST, and next to it
// /api/v1/preflight (before paying an endpoint), /api/v1/preflight/batch (up to
// 10 endpoints), /api/v1/preflight/deep (for expensive calls) and /api/v1/fix.
//
// The same diagnosis as the free web page, sold per call over x402 so agents
// and CI pipelines can use it without the web page's rate limit. Payment is
// USDC on Base and/or Solana (whichever payout wallet is configured). With
// CDP_API_KEY_ID/CDP_API_KEY_SECRET set, Coinbase's CDP facilitator verifies
// and settles Base (payments through it get the route listed in the CDP
// Bazaar). Solana goes through PayAI, so the Doctor counts among PayAI's
// sellers; CDP takes Solana over if PayAI is down, or always with
// DOCTOR_SOLANA_FACILITATOR=cdp.
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
const { batchPreflight, deepPreflight, BATCH_SCHEMA, BATCH_MAX } = require('./preflight-plus');
const { createBazaarIndex } = require('./bazaar-index');
const { createTrustIndex } = require('./trust-index');
const { buildFixes } = require('./recipes');
const { STACKS } = require('./stack');
const { createMcpRouter } = require('./mcp');
const { createSigner, signPaidResponses } = require('./receipt');
const { onPublicHost } = require('./public-host');
const { createMppPay, unlessMppPaid } = require('./mpp-pay');
// The service icon in the x402 Bazaar (served from public/icon.png).
const ICON_URL = 'https://x402-doctor.fizzl.eu/icon.png';

const BASE = 'eip155:8453';
const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const ROUTE = '/api/v1/diagnose';
const PREFLIGHT_ROUTE = '/api/v1/preflight';
const FIX_ROUTE = '/api/v1/fix';
const BATCH_ROUTE = '/api/v1/preflight/batch';
const DEEP_ROUTE = '/api/v1/preflight/deep';
const DEFAULT_PRICE = '$0.01';
const DEFAULT_PREFLIGHT_PRICE = '$0.001';
const DEFAULT_FIX_PRICE = '$0.05';
const DEFAULT_BATCH_PRICE = '$0.005';
const DEFAULT_DEEP_PRICE = '$0.01';
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
          group: { type: 'string', enum: ['challenge', 'accepts', 'resource', 'settlement', 'wallets', 'discovery', 'browser'] },
          status: { type: 'string', enum: ['pass', 'warn', 'fail', 'info', 'skip'] },
          message: { type: 'string' },
          hint: { type: 'string' },
        },
        required: ['id', 'status', 'message'],
      },
    },
    wallets: {
      type: 'array',
      description: 'Which wallets can pay: per wallet, the networks where payment works (yes) and where it fails, with the reason (no).',
      items: {
        type: 'object',
        properties: {
          wallet: { type: 'string' },
          agent: { type: 'boolean' },
          yes: { type: 'array', items: { type: 'string' } },
          no: { type: 'array', items: { type: 'object', properties: { network: { type: 'string' }, reason: { type: 'string' } } } },
        },
      },
    },
    challenge: { type: ['object', 'null'] },
  },
  required: ['url', 'overall', 'checks'],
};

// Deep preflight: the preflight answer plus the full diagnosis, the daily
// history, the seller's other endpoints and the domain-move checks.
const DEEP_SCHEMA = {
  ...PREFLIGHT_SCHEMA,
  properties: {
    ...PREFLIGHT_SCHEMA.properties,
    diagnosis: { type: 'object', properties: { overall: { type: ['string', 'null'] }, problems: { type: 'array' }, checks: { type: 'array' } } },
    history: { type: 'array', items: { type: 'object', properties: { date: { type: ['string', 'null'] }, status: { type: 'string', enum: ['go', 'caution', 'no_go', 'unreachable', 'unknown'] } } } },
    seller: { type: ['object', 'null'], properties: { origin: { type: 'string' }, resources: { type: 'integer' }, payable_now: { type: 'integer' }, avg_payable_ratio: { type: 'number' }, unreliable: { type: 'integer' } } },
    domain: { type: 'object', properties: { checks: { type: 'array' } } },
  },
};

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    url: { type: 'string' },
    overall: { type: 'string', enum: ['pass', 'warn', 'fail'] },
    stack: { type: 'object', properties: { id: { type: 'string', enum: Object.keys(STACKS) }, name: { type: 'string' }, detected_from: { type: 'string' } } },
    summary: { type: 'string' },
    fixes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          recipe: { type: 'string' },
          severity: { type: 'string', enum: ['fail', 'warn'] },
          checks: { type: 'array', items: { type: 'string' } },
          title: { type: 'string' },
          why: { type: 'string' },
          steps: { type: 'array', items: { type: 'string' } },
          code: { type: 'array', items: { type: 'object', properties: { language: { type: 'string' }, stack: { type: 'string' }, label: { type: 'string' }, snippet: { type: 'string' } } } },
          verify: { type: 'string' },
        },
        required: ['title', 'why', 'steps', 'code'],
      },
    },
    unfixed: { type: 'array', items: { type: 'object' } },
  },
  required: ['url', 'fixes'],
};

function paymentConfig(env) {
  const price = env.DOCTOR_PRICE || DEFAULT_PRICE;
  const preflightPrice = env.DOCTOR_PREFLIGHT_PRICE || DEFAULT_PREFLIGHT_PRICE;
  const fixPrice = env.DOCTOR_FIX_PRICE || DEFAULT_FIX_PRICE;
  const batchPrice = env.DOCTOR_BATCH_PRICE || DEFAULT_BATCH_PRICE;
  const deepPrice = env.DOCTOR_DEEP_PRICE || DEFAULT_DEEP_PRICE;
  const base = env.DOCTOR_PAYOUT_WALLET || env.AGENT_PAYOUT_WALLET;
  const solana = env.DOCTOR_PAYOUT_WALLET_SOLANA || env.AGENT_PAYOUT_WALLET_SOLANA;
  const acceptsFor = (p) => [
    ...(base ? [{ scheme: 'exact', price: p, network: BASE, payTo: base }] : []),
    ...(solana ? [{ scheme: 'exact', price: p, network: SOLANA, payTo: solana }] : []),
  ];
  return {
    price, preflightPrice, fixPrice, batchPrice, deepPrice,
    accepts: acceptsFor(price), preflightAccepts: acceptsFor(preflightPrice), fixAccepts: acceptsFor(fixPrice),
    batchAccepts: acceptsFor(batchPrice), deepAccepts: acceptsFor(deepPrice),
  };
}

// Rejects clearly wrong input before the paywall, so nobody signs a payment
// for a request that can only fail. A missing url is let through on purpose:
// indexers such as x402scan probe the bare route and need the 402 challenge
// (with the input schema) to register it. Paying without a url gets a 400,
// and a non-2xx response is never settled.
// The optional parameters every route shares; an error message or null.
function optionError(query) {
  if (query.stack !== undefined && !STACKS[query.stack]) return `stack must be one of ${Object.keys(STACKS).join(', ')}`;
  if (query.max_usd !== undefined && !(Number(query.max_usd) > 0)) return 'max_usd must be a positive number, e.g. 0.05';
  if (query.network !== undefined && !/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/.test(String(query.network))) {
    return 'network must be a CAIP-2 id, e.g. eip155:8453 or solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
  }
  return null;
}

function urlError(url, label = 'url') {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return `${label} is not a valid URL`;
  }
  return ['http:', 'https:'].includes(parsed.protocol) ? null : `${label} must be http(s)`;
}

function validate(req, res, next) {
  const { url, method } = req.query;
  if (method !== undefined && !['GET', 'POST'].includes(method)) {
    return res.status(400).json({ error: 'method must be GET or POST' });
  }
  if (url === undefined || (typeof url === 'string' && url.trim() === '')) return next(); // bare route or blank ?url=
  const error = optionError(req.query) || (Array.isArray(url) ? 'give one url (the batch route takes several)' : urlError(url));
  if (error) return res.status(400).json({ error });
  next();
}

// The batch takes the url parameter once per endpoint (?url=a&url=b), at most
// BATCH_MAX. Like validate(): no url passes (indexers probe the bare route),
// anything else wrong is a 400 before payment.
function validateBatch(req, res, next) {
  const { url, method } = req.query;
  if (method !== undefined && !['GET', 'POST'].includes(method)) {
    return res.status(400).json({ error: 'method must be GET or POST' });
  }
  // Blank values (?url= from probers that fill in empty example parameters)
  // count as no url, so they get the 402 challenge like the bare route.
  const urls = url === undefined ? [] : [...new Set([].concat(url).map((u) => String(u).trim()).filter(Boolean))];
  if (urls.length === 0) return next();
  if (urls.length > BATCH_MAX) return res.status(400).json({ error: `at most ${BATCH_MAX} urls per batch` });
  const error = optionError(req.query) || urls.map((u) => urlError(u, `url ${u.slice(0, 200)}`)).find(Boolean);
  if (error) return res.status(400).json({ error });
  req.batchUrls = urls;
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
            // the whole challenge: x402 v2 carries resource next to accepts
            body = { ...(body || {}), ...challenge };
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

// A facilitator client that only offers the networks `keep` accepts, so an
// earlier client in the list can claim those networks and leave the rest to
// the ones after it.
function onlyNetworks(client, keep) {
  return {
    verify: (...args) => client.verify(...args),
    settle: (...args) => client.settle(...args),
    async getSupported() {
      const supported = await client.getSupported();
      return { ...supported, kinds: supported.kinds.filter((k) => keep(k.network)) };
    },
  };
}

function createPaidApi({ safeFetch, env = process.env, bazaarIndex = createBazaarIndex(), trustIndex = createTrustIndex(), feedback = null, outcomes = null, checkPaymentProof = null } = {}) {
  const router = express.Router();
  const { price, preflightPrice, fixPrice, batchPrice, deepPrice, accepts, preflightAccepts, fixAccepts, batchAccepts, deepAccepts } = paymentConfig(env);
  // Signed verdicts (receipt.js); unsigned when RECEIPT_SIGNER_SECRET is not set.
  const signer = createSigner(env);
  router.signer = signer;

  if (accepts.length === 0) {
    const off = (_req, res) => res.status(503).json({ error: 'paid API not configured (set AGENT_PAYOUT_WALLET and/or AGENT_PAYOUT_WALLET_SOLANA)' });
    router.get(ROUTE, off);
    router.get(PREFLIGHT_ROUTE, off);
    router.get(FIX_ROUTE, off);
    router.get(BATCH_ROUTE, off);
    router.get(DEEP_ROUTE, off);
    router.paymentInfo = null;
    return router;
  }

  const useCdp = Boolean(env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET);
  const solanaViaPayai = useCdp && env.DOCTOR_SOLANA_FACILITATOR !== 'cdp';
  const payai = new HTTPFacilitatorClient({ url: env.FACILITATOR_URL || DEFAULT_FACILITATOR });
  // The first facilitator that supports a network handles it: PayAI for
  // Solana, then CDP (Base, and Solana when PayAI is down), then PayAI.
  const facilitators = [
    ...(solanaViaPayai ? [onlyNetworks(payai, (network) => network.startsWith('solana:'))] : []),
    ...(useCdp ? [new HTTPFacilitatorClient(createFacilitatorConfig(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET))] : []),
    payai,
  ];
  // MPP (mpp-pay.js): the same Base USDC payment for agents that speak MPP, through the
  // facilitator that handles Base. Only with its own MPP_SECRET (signs the challenge ids).
  const baseWallet = env.DOCTOR_PAYOUT_WALLET || env.AGENT_PAYOUT_WALLET;
  const mpp = baseWallet && env.MPP_SECRET ? createMppPay({
    secret: env.MPP_SECRET,
    realm: new URL(env.PUBLIC_URL || 'https://x402-doctor.fizzl.eu').host,
    recipient: baseWallet,
    routes: { [`GET ${ROUTE}`]: price, [`GET ${PREFLIGHT_ROUTE}`]: preflightPrice, [`GET ${FIX_ROUTE}`]: fixPrice, [`GET ${BATCH_ROUTE}`]: batchPrice, [`GET ${DEEP_ROUTE}`]: deepPrice },
    facilitator: useCdp ? facilitators[solanaViaPayai ? 1 : 0] : payai,
  }) : null;
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

  const example = 'https://ichimoku-signal.fizzl.eu/signal/BTC-USDT';
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

  const preflightExample = 'https://ichimoku-signal.fizzl.eu/signal/BTC-USDT';
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
  const fixExample = 'https://x402-doctor.fizzl.eu/demo/broken';
  const fixDiscovery = declareDiscoveryExtension({
    method: 'GET',
    input: { url: fixExample },
    inputSchema: {
      properties: {
        url: { type: 'string', description: 'Your x402 endpoint (public http(s) URL).' },
        method: { type: 'string', enum: ['GET', 'POST'], description: 'HTTP method of the endpoint. Default: try GET, then POST.' },
        stack: { type: 'string', enum: Object.keys(STACKS), description: 'Your stack, if detection from response headers is wrong. Default: detected.' },
      },
      required: ['url'],
    },
    output: {
      schema: FIX_SCHEMA,
      example: {
        url: fixExample,
        overall: 'fail',
        stack: { id: 'express', name: 'Express (@x402/express)', detected_from: 'x-powered-by: Express' },
        summary: '1 fix (0 blocking), for Express (@x402/express).',
        fixes: [{ recipe: 'amount', severity: 'warn', checks: ['accepts[0]-amount'], title: 'Amount "0.01" → "10000" ($0.01)', why: 'x402 amounts are integer strings in the smallest unit.', steps: ['Use price: "$0.01" instead of an amount.'], code: [{ language: 'json', stack: 'generic', label: 'Option field', snippet: '"amount": "10000"' }], verify: 'Run x402 Doctor again.' }],
        unfixed: [],
      },
    },
  });
  const batchExample = ['https://ichimoku-signal.fizzl.eu/signal/BTC-USDT', 'https://presign-guard.fizzl.eu/v1/token'];
  const batchDiscovery = declareDiscoveryExtension({
    method: 'GET',
    input: { url: batchExample, max_usd: '0.05' },
    inputSchema: {
      properties: {
        url: { type: 'array', items: { type: 'string' }, maxItems: BATCH_MAX, description: `The x402 endpoints to check, one url parameter each (?url=a&url=b), at most ${BATCH_MAX}.` },
        method: { type: 'string', enum: ['GET', 'POST'], description: 'HTTP method you will call them with. Default: try GET, then POST.' },
        max_usd: { type: 'string', description: 'Your budget per call in USD; above it the verdict is no_go.' },
        network: { type: 'string', description: 'CAIP-2 network you want to pay on.' },
      },
      required: ['url'],
    },
    output: {
      schema: BATCH_SCHEMA,
      example: {
        count: 2,
        counts: { go: 2, caution: 0, no_go: 0, unknown: 0 },
        results: [
          { url: batchExample[0], verdict: 'go', safe_to_pay: true, summary: 'OK to pay: $0.02 on Base.', recommended_option: 0, options: [], reasons: [] },
          { url: batchExample[1], verdict: 'go', safe_to_pay: true, summary: 'OK to pay: $0.01 on Base.', recommended_option: 0, options: [], reasons: [] },
        ],
        checked_at: '2026-09-29T12:00:00.000Z',
      },
    },
  });
  const deepExample = 'https://ichimoku-signal.fizzl.eu/setups';
  const deepDiscovery = declareDiscoveryExtension({
    method: 'GET',
    input: { url: deepExample, max_usd: '0.5' },
    inputSchema: {
      properties: {
        url: { type: 'string', description: 'The x402 endpoint you are about to pay (worth it for expensive calls).' },
        method: { type: 'string', enum: ['GET', 'POST'], description: 'HTTP method you will call it with. Default: try GET, then POST.' },
        max_usd: { type: 'string', description: 'Your budget per call in USD; above it the verdict is no_go.' },
        network: { type: 'string', description: 'CAIP-2 network you want to pay on.' },
      },
      required: ['url'],
    },
    output: {
      schema: DEEP_SCHEMA,
      example: {
        url: deepExample,
        verdict: 'go',
        safe_to_pay: true,
        summary: 'OK to pay: $0.5 on Base.',
        recommended_option: 0,
        options: [],
        reasons: [],
        diagnosis: { overall: 'pass', problems: [], checks: [] },
        history: [{ date: '2026-09-28', status: 'go' }],
        seller: { origin: 'https://ichimoku-signal.fizzl.eu', resources: 6, payable_now: 6, avg_payable_ratio: 1, unreliable: 0 },
        domain: { checks: [] },
      },
    },
  });
  const runPreflight = createPreflight({ safeFetch, bazaarIndex, trustIndex, outcomes });
  const runDiagnose = (url, method) => diagnoseLib.diagnose(String(url), { safeFetch, method, bazaarIndex });
  const runBatch = (urls, opts) => batchPreflight(urls.map(String), { runPreflight, ...opts });
  const runDeep = (url, opts) => deepPreflight(String(url), { runPreflight, diagnose: runDiagnose, trustIndex, ...opts });
  // Load the Bazaar index at startup (it takes longer than a request waits),
  // so the first pre-payment checks already carry the listing signal.
  if (env.DOCTOR_WARM_BAZAAR_INDEX !== '0') {
    bazaarIndex.refresh?.();
    trustIndex.refresh?.();
  }

  // MCP (POST /mcp): the same diagnose, preflight and fix as tools, paid inside the MCP call.
  router.use(createMcpRouter({
    resourceServer,
    config: { price, preflightPrice, fixPrice, batchPrice, deepPrice, accepts, preflightAccepts, fixAccepts, batchAccepts, deepAccepts },
    diagnose: runDiagnose,
    runPreflight: (url, opts) => runPreflight(String(url), opts),
    runBatch,
    runDeep,
    buildFixes,
    signer,
    feedback,
    checkPaymentProof,
  }));

  router.get(ROUTE, validate);
  router.get(PREFLIGHT_ROUTE, validate);
  router.get(FIX_ROUTE, validate);
  router.get(BATCH_ROUTE, validateBatch);
  router.get(DEEP_ROUTE, validate);
  if (mpp) router.use(mpp.middleware);
  router.use(mirrorChallengeIntoBody);
  router.use(
    // Challenges (and so the Bazaar listing) name x402-doctor.fizzl.eu, also when called on the Render address.
    unlessMppPaid(onPublicHost(env.PUBLIC_URL || 'https://x402-doctor.fizzl.eu', paymentMiddleware(
      {
        [`GET ${ROUTE}`]: {
          accepts,
          description:
            "Why is my x402 endpoint broken? Diagnose and debug an x402 payment endpoint (or MCP server) when payments fail: checks the 402 challenge, accepts[] (network, payTo, amount, asset), resource URL, Solana settlement readiness, which wallets and agents can pay, Bazaar/OpenAPI discovery and the browser paywall. Returns every check with a fix hint. Read-only: never pays.",
          mimeType: 'application/json',
          serviceName: 'x402 Doctor',
          iconUrl: ICON_URL,
          tags: ['x402', 'developer-tools', 'diagnostics', 'debug', 'payments'],
          extensions: discovery,
        },
        [`GET ${PREFLIGHT_ROUTE}`]: {
          accepts: preflightAccepts,
          description:
            'Is this x402 endpoint safe to pay? Check it before your AI agent pays: go / caution / no_go, the recommended payment option, and why (payment would fail, over your budget, price above advertised, not HTTPS, unknown token). Never pays the endpoint. Cached 10 min.',
          mimeType: 'application/json',
          serviceName: 'x402 Doctor',
          iconUrl: ICON_URL,
          tags: ['x402', 'payments', 'safety', 'pre-payment', 'agents'],
          extensions: preflightDiscovery,
        },
        [`GET ${FIX_ROUTE}`]: {
          accepts: fixAccepts,
          description:
            'How do I fix my broken x402 endpoint? Diagnoses it, then returns per problem the concrete change as code for your stack (Express, Next.js, Hono or raw HTTP), filled in with your own payTo, amount, network and route.',
          mimeType: 'application/json',
          serviceName: 'x402 Doctor',
          iconUrl: ICON_URL,
          tags: ['x402', 'developer-tools', 'fix', 'code'],
          extensions: fixDiscovery,
        },
        [`GET ${BATCH_ROUTE}`]: {
          accepts: batchAccepts,
          description: `Are these x402 endpoints safe to pay? Up to ${BATCH_MAX} endpoints in one call (?url=a&url=b): per endpoint go / caution / no_go, the recommended payment option and why, plus totals. For marketplaces and agents that weigh several services. Never pays the endpoints.`,
          mimeType: 'application/json',
          serviceName: 'x402 Doctor',
          iconUrl: ICON_URL,
          tags: ['x402', 'payments', 'safety', 'pre-payment', 'batch'],
          extensions: batchDiscovery,
        },
        [`GET ${DEEP_ROUTE}`]: {
          accepts: deepAccepts,
          description:
            'Should my agent pay this expensive x402 endpoint? The pre-payment verdict plus the full diagnosis, the 30-day history per day, how reliable the seller\'s other endpoints are and whether the endpoint moved domains. Never pays the endpoint.',
          mimeType: 'application/json',
          serviceName: 'x402 Doctor',
          iconUrl: ICON_URL,
          tags: ['x402', 'payments', 'safety', 'pre-payment', 'due-diligence'],
          extensions: deepDiscovery,
        },
      },
      resourceServer,
      { appName: 'x402 Doctor', testnet: false },
      paywall
    )))
  );
  router.use(signPaidResponses(signer, [`GET ${ROUTE}`, `GET ${PREFLIGHT_ROUTE}`, `GET ${FIX_ROUTE}`, `GET ${BATCH_ROUTE}`, `GET ${DEEP_ROUTE}`]));

  router.get(ROUTE, async (req, res) => {
    const { url, method } = req.query;
    if (url === undefined) return res.status(400).json({ error: 'url is required, e.g. ?url=https://api.example.com/paid' });
    try {
      res.json(await diagnoseLib.diagnose(String(url), { safeFetch, method, bazaarIndex }));
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

  router.get(FIX_ROUTE, async (req, res) => {
    const { url, method, stack } = req.query;
    if (url === undefined) return res.status(400).json({ error: 'url is required, e.g. ?url=https://api.example.com/paid' });
    try {
      const report = await diagnoseLib.diagnose(String(url), { safeFetch, method, bazaarIndex });
      res.json(buildFixes(report, { stack }));
    } catch (err) {
      res.status(err.statusCode || 502).json({ error: err.message });
    }
  });

  router.get(BATCH_ROUTE, async (req, res) => {
    const { method, max_usd: maxUsd, network } = req.query;
    if (!req.batchUrls) return res.status(400).json({ error: 'url is required, once per endpoint, e.g. ?url=https://a.example/paid&url=https://b.example/paid' });
    try {
      res.json(await runBatch(req.batchUrls, { method, maxUsd: maxUsd === undefined ? undefined : Number(maxUsd), network }));
    } catch (err) {
      res.status(err.statusCode || 502).json({ error: err.message });
    }
  });

  router.get(DEEP_ROUTE, async (req, res) => {
    const { url, method, max_usd: maxUsd, network } = req.query;
    if (url === undefined) return res.status(400).json({ error: 'url is required, e.g. ?url=https://api.example.com/paid&max_usd=0.5' });
    try {
      res.json(await runDeep(url, { method, maxUsd: maxUsd === undefined ? undefined : Number(maxUsd), network }));
    } catch (err) {
      res.status(err.statusCode || 502).json({ error: err.message });
    }
  });

  router.paymentInfo = {
    route: ROUTE,
    price,
    networks: accepts.map((a) => a.network),
    facilitator: solanaViaPayai ? 'cdp for base, payai for solana' : useCdp ? 'cdp, payai fallback' : 'payai',
    mpp: mpp ? { method: 'evm', intent: 'charge', network: BASE, currency: 'USDC' } : null,
    preflight: { route: PREFLIGHT_ROUTE, price: preflightPrice },
    fix: { route: FIX_ROUTE, price: fixPrice },
    batch: { route: BATCH_ROUTE, price: batchPrice, max_urls: BATCH_MAX },
    deep: { route: DEEP_ROUTE, price: deepPrice },
  };
  return router;
}

module.exports = { createPaidApi, onlyNetworks, ROUTE, PREFLIGHT_ROUTE, FIX_ROUTE, BATCH_ROUTE, DEEP_ROUTE, REPORT_SCHEMA, FIX_SCHEMA, DEEP_SCHEMA, paymentConfig };
