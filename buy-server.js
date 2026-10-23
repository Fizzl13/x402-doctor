// Fizzl Buy (buy.fizzl.eu): the inkoper, Fizzl's fourth agent. An agent says what it needs ("weather forecast
// Amsterdam tomorrow", "BTC price", "search the web for …"); the inkoper picks the paid API in the x402 Bazaar that
// x402 Doctor has seen paying out day after day at a fair price, fills in its input, buys it with its own wallet and
// returns the answer, checked by TypeSafe Jev, with a signed receipt (lib/buy/*).
//
//   POST /v1/buy { need }  $0.02 (x402, USDC on Base or Solana): buys a service of at most $0.01. Nothing is charged
//                          when no service delivers (the paywall settles only a 2xx answer).
//   GET  /v1/pick?need=…   free (10 an hour per caller): which service the inkoper would buy, and why.
//   POST /mcp              MCP: x402_pick (free).
//
// Runs as its own Render service from this repository (render.yaml, service fizzl-buy). Env: PUBLIC_URL,
// AGENT_PAYOUT_WALLET (+ AGENT_PAYOUT_WALLET_SOLANA), CDP_API_KEY_ID/SECRET, BUY_WALLET_KEY (the inkoper's own wallet,
// kept small), BUY_DAILY_USD (default 5), ANTHROPIC_API_KEY (fills in requests), TYPESAFE_API_KEY (answer and bait
// checks), RECEIPT_SIGNER_SECRET, USAGE_LOG_TOKEN.
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { paymentMiddleware, x402ResourceServer } = require('@x402/express');
const { HTTPFacilitatorClient } = require('@x402/core/server');
const { ExactEvmScheme } = require('@x402/evm/exact/server');
const { ExactSvmScheme } = require('@x402/svm/exact/server');
const { declareDiscoveryExtension } = require('@x402/extensions/bazaar');
const { createFacilitatorConfig } = require('@coinbase/x402');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const { createFacilitatorStart } = require('./lib/facilitator-start');
const { onPublicHost } = require('./lib/public-host');
const { mirrorChallengeIntoBody } = require('./lib/paid-api');
const { merchantExtension, builderCodeExtension } = require('./lib/merchant');
const { createSigner, signPaidResponses } = require('./lib/receipt');
const { createUsageLog } = require('./lib/usage-log');
const { createSafeFetch } = require('./lib/safe-fetch');
const { createSanctions } = require('./lib/sanctions');
const { createTrustReader } = require('./lib/trust-reader');
const { createLure } = require('./lib/jev-lure');
const { createAnswerCheck } = require('./lib/jev-answer');
const { createSpotWallet } = require('./lib/spot-wallet');
const { candidatesFor } = require('./lib/buy/search');
const { createFiller } = require('./lib/buy/fill');
const { buy, createBudget, BuyError, MAX_TRIES } = require('./lib/buy/purchase');

const BASE = 'eip155:8453';
const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const PRICE_USD = 0.02;
const CAP_USD = 0.01;
const FREE_PER_HOUR = 10;
const BUY_ROUTE = '/v1/buy';
const EXAMPLE_NEED = 'weather forecast for Amsterdam tomorrow';

const memoryOf = () => {
  const m = process.memoryUsage();
  const mb = (n) => Math.round(n / 1048576);
  return { rss_mb: mb(m.rss), heap_mb: mb(m.heapUsed) };
};

function createRateLimiter(limit, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) { hits.set(key, recent); return false; }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 10000) hits.delete(hits.keys().next().value);
    return true;
  };
}

const OUTPUT_EXAMPLE = {
  need: EXAMPLE_NEED,
  delivered: true,
  answer: { place: 'Amsterdam', daily: [{ date: '2026-10-24', min_c: 8, max_c: 13, condition: 'light rain' }] },
  service: { url: 'https://weather.cyberwarex.com/forecast?place=Amsterdam&days=2', method: 'GET', track_record: { days: 30, payableDays: 30, ratio: 1 } },
  paid_usd: 0.002,
  answer_check: { delivered: { verdict: 'yes', decidedBy: 'jev' }, injection: { flagged: false } },
  tried: 1,
};

// The paywall's route: $0.02 on Base (and Solana with a Solana payout address), long enough to buy for the agent.
function routesFor(env) {
  const price = `$${PRICE_USD}`;
  const accepts = [
    { scheme: 'exact', price, network: BASE, payTo: env.AGENT_PAYOUT_WALLET, maxTimeoutSeconds: 300 },
    ...(env.AGENT_PAYOUT_WALLET_SOLANA ? [{ scheme: 'exact', price, network: SOLANA, payTo: env.AGENT_PAYOUT_WALLET_SOLANA, maxTimeoutSeconds: 300 }] : []),
  ];
  return {
    [`POST ${BUY_ROUTE}`]: {
      accepts,
      description: 'Buy the right paid API for your agent in one call: say what you need ("weather forecast Amsterdam tomorrow", "BTC price", "search the web for x402"). Fizzl picks the x402 service x402 Doctor has seen paying out day after day at a fair price, fills in its input, buys it (up to $0.01) and returns the answer, checked by TypeSafe Jev, with a signed receipt. Nothing is charged when no service delivers.',
      mimeType: 'application/json',
      serviceName: 'Fizzl Buy',
      tags: ['agents', 'x402', 'marketplace', 'buyer', 'trust'],
      iconUrl: 'https://x402-doctor.fizzl.eu/icon.png',
      // Who sells it, and the Base Builder Code once BUILDER_CODE is set, as on the other fizzl.eu services.
      extensions: {
        ...declareDiscoveryExtension({
          method: 'POST',
          bodyType: 'json',
          input: { need: EXAMPLE_NEED },
          inputSchema: { properties: { need: { type: 'string', description: 'What your agent needs, in a sentence: the data or result, with the details (place, symbol, query).' } }, required: ['need'] },
          output: { example: OUTPUT_EXAMPLE },
        }),
        ...merchantExtension,
        ...builderCodeExtension(env.BUILDER_CODE),
      },
    },
  };
}

function createBuyApp({ env = process.env, deps = {}, paywall = null } = {}) {
  const publicUrl = (env.PUBLIC_URL || 'https://buy.fizzl.eu').replace(/\/+$/, '');
  const safeFetch = deps.safeFetch ?? createSafeFetch({ allowPrivate: false, timeoutMs: 15000 });
  const searchFetch = deps.fetch ?? globalThis.fetch;
  const sanctions = deps.sanctions ?? createSanctions({ env });
  const trustIndex = deps.trustIndex ?? createTrustReader();
  const lure = deps.lure ?? createLure({ apiKey: env.TYPESAFE_API_KEY });
  const answerCheck = deps.answerCheck ?? createAnswerCheck({ apiKey: env.TYPESAFE_API_KEY, anthropicKey: env.ANTHROPIC_API_KEY, timeoutMs: 5000 });
  const filler = deps.filler ?? createFiller({ apiKey: env.ANTHROPIC_API_KEY });
  const wallet = deps.wallet ?? (env.BUY_WALLET_KEY ? createSpotWallet({ key: env.BUY_WALLET_KEY, capUsd: CAP_USD, rpc: env.BASE_RPC_URL || undefined }) : null);
  const budget = deps.budget ?? createBudget({ dailyUsd: Number(env.BUY_DAILY_USD) || 5 });
  const freeLimiter = deps.freeLimiter ?? createRateLimiter(FREE_PER_HOUR, 60 * 60 * 1000);
  const usageLog = deps.usageLog ?? createUsageLog({ service: 'buy', env });
  const signer = deps.signer === undefined ? createSigner(env, { label: 'fizzl-buy', service: 'fizzl-buy' }) : deps.signer;

  async function pickFor(need) {
    const candidates = await candidatesFor(need, { capUsd: CAP_USD, fetch: searchFetch });
    return {
      need,
      pick: candidates[0] ?? null,
      alternatives: candidates.slice(1, MAX_TRIES),
      buy: { method: 'POST', url: `${publicUrl}${BUY_ROUTE}`, body: { need }, price_usd: PRICE_USD, note: `Buys the pick (or the next one when it doesn't deliver) and returns the answer; nothing is charged when none delivers.` },
      ...(candidates.length ? {} : { note: 'No paid API with a good track record answers this within $0.01. Try other words.' }),
    };
  }
  const needOf = (v) => {
    const need = typeof v === 'string' ? v.trim() : '';
    if (need.length < 3 || need.length > 500) throw new BuyError(400, 'need must say what your agent needs, in 3 to 500 characters');
    return need;
  };

  const app = express();
  app.set('trust proxy', Number(env.TRUST_PROXY_HOPS) || 1);
  app.disable('x-powered-by');
  app.get('/health', (_req, res) => res.json({ ok: true, wallet: wallet ? wallet.address : null, filler: filler.enabled, answer_check: Boolean(answerCheck?.enabled), spent_today_usd: budget.spent(), memory: memoryOf(), uptime_s: Math.round(process.uptime()) }));

  app.use(usageLog.middleware((req, res, body) => {
    const via = req.path === '/mcp' ? 'mcp' : 'api';
    if (req.path === BUY_ROUTE && req.method === 'POST') return { route: 'buy', via, input: { chars: String(req.body?.need || '').length }, result: { delivered: body?.delivered, paid_usd: body?.paid_usd, service: body?.service?.url ? new URL(body.service.url).host : undefined, tried: body?.tried, error: body?.error } };
    if (req.path === '/v1/pick') return { route: 'pick', via, input: { chars: String(req.query.need || '').length }, result: { pick: body?.pick?.url ? new URL(body.pick.url).host : null, error: body?.error } };
    if (req.path === '/mcp' && req.body?.method === 'tools/call') return { route: String(req.body.params?.name || 'mcp'), via, input: {}, result: {} };
    return null;
  }));

  // Free: what the inkoper would buy.
  app.get('/v1/pick', async (req, res) => {
    try {
      const need = needOf(req.query.need);
      if (!freeLimiter(req.ip)) return res.status(429).json({ error: `Free limit reached (${FREE_PER_HOUR} an hour). POST ${BUY_ROUTE} ($${PRICE_USD}) buys directly.` });
      res.set('Cache-Control', 'no-store').json(await pickFor(need));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.status ? err.message : 'internal error' });
    }
  });

  // MCP: the free pick as a tool.
  app.post('/mcp', express.json({ limit: '64kb' }), async (req, res) => {
    const server = new McpServer({ name: 'fizzl-buy', version: '1.0.0' });
    server.registerTool('x402_pick', {
      title: 'Which paid API to buy (free)',
      description: `Free: say what your agent needs and get the paid x402 API that x402 Doctor has seen paying out day after day at a fair price (up to $${CAP_USD}), with its track record, price and example input, plus alternatives. To buy it in one call, POST ${publicUrl}${BUY_ROUTE} {"need": …} ($${PRICE_USD} over x402): the answer comes back checked, and nothing is charged when no service delivers. Limited to ${FREE_PER_HOUR} free calls an hour.`,
      inputSchema: { need: z.string().min(3).max(500).describe('What your agent needs, in a sentence, with the details (place, symbol, query)') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    }, async ({ need }) => {
      if (!freeLimiter(req.ip)) return { content: [{ type: 'text', text: `Free limit reached (${FREE_PER_HOUR} an hour). POST ${publicUrl}${BUY_ROUTE} ($${PRICE_USD}) buys directly.` }], isError: true };
      try {
        const out = await pickFor(need);
        return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
      } catch (err) {
        return { content: [{ type: 'text', text: `could not search: ${err.message}` }], isError: true };
      }
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[mcp] error:', err);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null });
    }
  });

  // Discovery: openapi, /.well-known/x402, llms.txt and the homepage.
  const routes = routesFor(env);
  app.get('/openapi.json', (_req, res) => res.json(openApi(publicUrl)));
  app.get('/.well-known/x402', (_req, res) => res.json({ version: 1, x402Version: 2, name: 'Fizzl Buy', serviceName: 'Fizzl Buy', description: routes[`POST ${BUY_ROUTE}`].description, resources: [{ url: `${publicUrl}${BUY_ROUTE}`, method: 'POST', name: 'Buy for your agent', description: 'One call: the right paid API, bought and checked.' }], openapi: `${publicUrl}/openapi.json` }));
  app.get('/llms.txt', (_req, res) => res.type('text/plain; charset=utf-8').send(llmsTxt(publicUrl)));
  app.get('/', (req, res) => {
    if (req.accepts(['html', 'json']) === 'json') return res.json({ name: 'Fizzl Buy', description: routes[`POST ${BUY_ROUTE}`].description, buy: `POST ${publicUrl}${BUY_ROUTE}`, pick: `GET ${publicUrl}/v1/pick?need=…`, mcp: `${publicUrl}/mcp`, price_usd: PRICE_USD, cap_usd: CAP_USD });
    res.type('html').send(fs.readFileSync(path.join(__dirname, 'public-buy', 'index.html'), 'utf8'));
  });

  // Paid: the purchase. The paywall settles the agent's payment only for a 2xx answer; the challenge goes into the
  // 402's body too, for clients that read accepts[] there.
  app.use(mirrorChallengeIntoBody);
  if (paywall) app.use(paywall);
  app.use(signPaidResponses(signer, [`POST ${BUY_ROUTE}`]));
  app.post(BUY_ROUTE, express.json({ limit: '16kb' }), async (req, res) => {
    try {
      const need = needOf(req.body?.need);
      if (!wallet) throw new BuyError(503, 'The inkoper has no wallet on this server (BUY_WALLET_KEY). Nothing was charged.');
      const out = await buy({ need }, { fill: filler.fill, payFetch: wallet.payFetch, balance: wallet.balance, budget, answerCheck, safeFetch, sanctions, trustIndex, lure, capUsd: CAP_USD, fetch: searchFetch });
      res.set('Cache-Control', 'no-store').json(out);
    } catch (err) {
      if (!err.status) console.error('[buy]', err);
      res.status(err.status || 500).json({ error: err.status ? err.message : 'internal error', ...(err.attempts?.length ? { attempts: err.attempts } : {}) });
    }
  });
  return app;
}

function openApi(publicUrl) {
  return {
    openapi: '3.1.0',
    info: { title: 'Fizzl Buy', version: '1.0.0', description: 'The inkoper: one call buys the right paid x402 API for your agent, picked by x402 Doctor\'s track records, and returns the answer checked by TypeSafe Jev.', contact: { name: 'Fizzl', url: 'https://fizzl.eu', email: 'Fizzl13@protonmail.com' }, 'x-guidance': `POST ${BUY_ROUTE} with {"need": "<what you need, with the details>"} and pay $${PRICE_USD} over x402. You get the answer, which service it came from and what it cost. Nothing is charged when no service delivers. To see first what would be bought, GET /v1/pick?need=… (free).` },
    servers: [{ url: publicUrl }],
    paths: {
      [BUY_ROUTE]: {
        post: {
          operationId: 'buy',
          summary: 'Buy the right paid API for a need and return its answer',
          'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: String(PRICE_USD) }, protocols: [{ x402: {} }], networks: [BASE, SOLANA], asset: 'USDC' },
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { need: { type: 'string', minLength: 3, maxLength: 500 } }, required: ['need'] }, example: { need: EXAMPLE_NEED } } } },
          responses: { 200: { description: 'The answer, bought and checked', content: { 'application/json': { example: OUTPUT_EXAMPLE } } }, 400: { description: 'Invalid request; nothing is charged' }, 402: { description: 'Payment Required' }, 404: { description: 'No suitable service; nothing is charged' }, 502: { description: 'No service delivered; nothing is charged' }, 503: { description: 'Budget or wallet empty; nothing is charged' } },
        },
      },
      '/v1/pick': { get: { operationId: 'pick', security: [], summary: 'Free: which paid API the inkoper would buy for a need', parameters: [{ name: 'need', in: 'query', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'The pick, alternatives and how to buy' }, 429: { description: 'Free limit reached' } } } },
    },
  };
}

function llmsTxt(publicUrl) {
  return `# Fizzl Buy

> The inkoper for AI agents: say what you need and Fizzl buys the right paid x402 API for you. It picks the service x402 Doctor has seen paying out day after day at a fair price, fills in its input, pays it (up to $${CAP_USD}) and returns the answer, checked by TypeSafe Jev, with a signed receipt. $${PRICE_USD} per purchase over x402 (USDC on Base or Solana); nothing is charged when no service delivers.

- POST ${publicUrl}${BUY_ROUTE} with {"need": "${EXAMPLE_NEED}"} ($${PRICE_USD})
- GET ${publicUrl}/v1/pick?need=… (free, ${FREE_PER_HOUR} an hour): which service would be bought, and why
- MCP: ${publicUrl}/mcp (tool x402_pick, free)

## Optional
- [Fizzl](https://fizzl.eu/llms.txt): x402 Doctor (trust), presign-guard (safety), the agent wallet
`;
}

if (require.main === module) {
  const env = process.env;
  if (!env.AGENT_PAYOUT_WALLET) throw new Error('AGENT_PAYOUT_WALLET is required');
  const useCdp = Boolean(env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET);
  const facilitators = [
    ...(useCdp ? [new HTTPFacilitatorClient(createFacilitatorConfig(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET))] : []),
    new HTTPFacilitatorClient({ url: env.FACILITATOR_URL || 'https://facilitator.payai.network' }),
  ];
  const start = createFacilitatorStart(facilitators);
  const resourceServer = new x402ResourceServer(start.clients).register(BASE, new ExactEvmScheme()).register(SOLANA, new ExactSvmScheme());
  const routes = routesFor(env);
  start.attach(resourceServer, [...new Set(routes[`POST ${BUY_ROUTE}`].accepts.map((a) => a.network))]);
  // The challenge names buy.fizzl.eu also when called on the Render address.
  const paywall = onPublicHost(env.PUBLIC_URL || 'https://buy.fizzl.eu', paymentMiddleware(routes, resourceServer, undefined, undefined, false));
  const app = createBuyApp({ env, paywall });
  const port = Number(env.PORT) || 3000;
  app.listen(port, () => console.log(`fizzl-buy on :${port}`));
}

module.exports = { createBuyApp, routesFor, openApi, PRICE_USD, CAP_USD, BUY_ROUTE };
