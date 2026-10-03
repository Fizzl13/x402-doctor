// MCP server (Streamable HTTP, stateless) on POST /mcp, so MCP clients (Claude,
// Cursor, agent frameworks) and MCP directories can find and use x402 Doctor.
//
// Tools:
// - x402_quick_check (free, rate-limited): pass/warn/fail and the main problems.
// - x402_diagnose ($0.01), x402_preflight ($0.001), x402_preflight_batch
//   ($0.005, up to 10 endpoints), x402_preflight_deep ($0.01) and x402_fix
//   ($0.05), via x402: the same as the GET /api/v1/... routes, paid inside the
//   MCP call (_meta["x402/payment"]) at the same prices, on Base or Solana.
//
// Invalid input is refused before payment; a failed call is not charged.

'use strict';

const express = require('express');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { createPaymentWrapper } = require('@x402/mcp');
const { declareDiscoveryExtension } = require('@x402/extensions/bazaar');
const { STACKS } = require('./stack');
const { paymentOf } = require('./receipt');

const VERSION = '1.0.0';
const FREE_CALLS_PER_HOUR = 10;
const EXAMPLE_URL = 'https://ichimoku-signal.fizzl.eu/signal/BTC-USDT';

const URL_ARG = z.string().describe('The x402 endpoint (public http(s) URL), e.g. https://api.example.com/paid');
const METHOD_ARG = z.enum(['GET', 'POST']).optional().describe('HTTP method of the paid route (default: GET, then POST)');

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });
const toolError = (message) => ({ ...text(message), isError: true });

function createRateLimiter(limit, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 10000) hits.clear();
    return true;
  };
}

// Same checks as validate() in paid-api.js, before any payment.
function urlError(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return 'url is not a valid URL';
  }
  return ['http:', 'https:'].includes(parsed.protocol) ? null : 'url must be http(s)';
}

function validateArgs(args) {
  const urls = Array.isArray(args.urls) ? args.urls : [args.url];
  for (const u of urls) {
    const error = urlError(u);
    if (error) return Array.isArray(args.urls) ? `${error}: ${String(u).slice(0, 200)}` : error;
  }
  if (args.max_usd !== undefined && !(Number(args.max_usd) > 0)) return 'max_usd must be a positive number, e.g. 0.05';
  if (args.network !== undefined && !/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/.test(String(args.network))) return 'network must be a CAIP-2 id, e.g. eip155:8453';
  return null;
}

// The short answer the free tool gives: the verdict and the first problems.
function summarize(report) {
  const problems = report.checks.filter((c) => c.status === 'fail' || c.status === 'warn');
  return {
    url: report.url,
    overall: report.overall,
    failures: problems.filter((c) => c.status === 'fail').length,
    warnings: problems.filter((c) => c.status === 'warn').length,
    top_problems: problems.sort((a, b) => (a.status === b.status ? 0 : a.status === 'fail' ? -1 : 1)).slice(0, 3).map((c) => `${c.status}: ${c.message}`),
    next: 'x402_diagnose ($0.01) returns every check with a hint; x402_fix ($0.05) returns the code changes for your stack.',
  };
}

function createMcpRouter({ resourceServer, config, diagnose, runPreflight, runBatch = null, runDeep = null, buildFixes, signer = null, feedback = null, checkPaymentProof = null }) {
  const TOOLS = [
    {
      name: 'x402_diagnose',
      accepts: config.accepts,
      price: config.price,
      title: 'Diagnose an x402 endpoint',
      summary: 'Every check of an x402 endpoint (402 challenge, accepts[], resource URL, Solana readiness, Bazaar/OpenAPI discovery, paywall) with a fix hint.',
      description: (p) => `Paid (${p} USDC via x402 on Base or Solana): diagnose an x402 endpoint the way a paying agent would, without paying it: the 402 challenge format, every accepts[] option, the resource URL, Solana settlement readiness, which wallets can pay, Bazaar/OpenAPI discovery and the browser paywall. Returns every check with pass/warn/fail and a fix hint. Same as GET /api/v1/diagnose.`,
      input: { url: URL_ARG, method: METHOD_ARG },
      example: { url: EXAMPLE_URL },
      tags: ['x402', 'developer-tools', 'diagnostics', 'payments'],
      run: (a) => diagnose(a.url, a.method),
    },
    {
      name: 'x402_preflight',
      accepts: config.preflightAccepts,
      price: config.preflightPrice,
      title: 'Check an x402 endpoint before paying it',
      summary: 'go / caution / no_go before an agent pays an x402 endpoint, with the recommended payment option and why.',
      description: (p) => `Paid (${p} USDC via x402 on Base or Solana): call this before your agent pays an x402 endpoint. Returns go, caution or no_go, the recommended payment option, and why: payment would fail, over your budget (max_usd), price above what is advertised, not HTTPS, unknown token, its 30-day track record. Never pays the endpoint. Same as GET /api/v1/preflight.`,
      input: {
        url: URL_ARG,
        method: METHOD_ARG,
        max_usd: z.number().positive().optional().describe('Your budget per call in USD, e.g. 0.05'),
        network: z.string().optional().describe('CAIP-2 network you want to pay on, e.g. eip155:8453'),
      },
      example: { url: EXAMPLE_URL, max_usd: 0.05 },
      tags: ['x402', 'payments', 'safety', 'pre-payment'],
      run: (a) => runPreflight(a.url, { method: a.method, maxUsd: a.max_usd, network: a.network }),
    },
    {
      name: 'x402_fix',
      accepts: config.fixAccepts,
      price: config.fixPrice,
      title: 'Fix plan for an x402 endpoint',
      summary: 'Diagnoses an x402 endpoint, then gives per problem the concrete change as code for your stack, filled in with your own values.',
      description: (p) => `Paid (${p} USDC via x402 on Base or Solana): diagnoses your x402 endpoint, then returns per problem the concrete change as code for your stack (${Object.keys(STACKS).join(', ')}), filled in with your own payTo, amount, network and route. Same as GET /api/v1/fix.`,
      input: { url: URL_ARG, method: METHOD_ARG, stack: z.enum(Object.keys(STACKS)).optional().describe('Your server stack (default: detected)') },
      example: { url: EXAMPLE_URL, stack: 'express' },
      tags: ['x402', 'developer-tools', 'fix', 'code'],
      run: async (a) => buildFixes(await diagnose(a.url, a.method), { stack: a.stack }),
    },
    ...(runBatch && config.batchAccepts ? [{
      name: 'x402_preflight_batch',
      accepts: config.batchAccepts,
      price: config.batchPrice,
      title: 'Check up to 10 x402 endpoints before paying',
      summary: 'go / caution / no_go for up to 10 x402 endpoints in one call, with totals.',
      description: (p) => `Paid (${p} USDC via x402 on Base or Solana): the pre-payment check for up to 10 x402 endpoints at once. Per endpoint go, caution or no_go, the recommended payment option and why, plus totals. For marketplaces and agents that weigh several services. Never pays the endpoints. Same as GET /api/v1/preflight/batch.`,
      input: {
        urls: z.array(z.string()).min(1).max(10).describe('The x402 endpoints to check (public http(s) URLs), at most 10'),
        method: METHOD_ARG,
        max_usd: z.number().positive().optional().describe('Your budget per call in USD, e.g. 0.05'),
        network: z.string().optional().describe('CAIP-2 network you want to pay on, e.g. eip155:8453'),
      },
      example: { urls: [EXAMPLE_URL, 'https://presign-guard.fizzl.eu/v1/token'], max_usd: 0.05 },
      tags: ['x402', 'payments', 'safety', 'pre-payment', 'batch'],
      run: (a) => runBatch(a.urls, { method: a.method, maxUsd: a.max_usd, network: a.network }),
    }] : []),
    ...(runDeep && config.deepAccepts ? [{
      name: 'x402_preflight_deep',
      accepts: config.deepAccepts,
      price: config.deepPrice,
      title: 'Deep check of an x402 endpoint before an expensive payment',
      summary: 'The pre-payment verdict plus the full diagnosis, the daily history, the seller\'s other endpoints and domain moves.',
      description: (p) => `Paid (${p} USDC via x402 on Base or Solana): for expensive calls. The pre-payment verdict (go, caution or no_go) plus the full diagnosis, the 30-day history per day, how reliable the seller's other endpoints are and whether the endpoint moved domains. Never pays the endpoint. Same as GET /api/v1/preflight/deep.`,
      input: {
        url: URL_ARG,
        method: METHOD_ARG,
        max_usd: z.number().positive().optional().describe('Your budget per call in USD, e.g. 0.5'),
        network: z.string().optional().describe('CAIP-2 network you want to pay on, e.g. eip155:8453'),
      },
      example: { url: 'https://ichimoku-signal.fizzl.eu/setups', max_usd: 0.5 },
      tags: ['x402', 'payments', 'safety', 'pre-payment', 'due-diligence'],
      run: (a) => runDeep(a.url, { method: a.method, maxUsd: a.max_usd, network: a.network }),
    }] : []),
  ];

  const wrappers = {};
  for (const tool of TOOLS) {
    let wrapper = null;
    wrappers[tool.name] = async () => {
      if (wrapper) return wrapper;
      await resourceServer.initialize();
      const accepts = [];
      for (const option of tool.accepts) accepts.push(...(await resourceServer.buildPaymentRequirements(option)));
      if (!accepts.length) throw new Error('paid tools not configured (no payout wallet)');
      wrapper = createPaymentWrapper(resourceServer, {
        accepts,
        resource: { url: `mcp://tool/${tool.name}`, description: tool.summary, mimeType: 'application/json', serviceName: 'x402 Doctor', tags: tool.tags },
        extensions: declareDiscoveryExtension({
          toolName: tool.name,
          description: tool.summary,
          transport: 'streamable-http',
          inputSchema: tool.input.urls
            ? { type: 'object', properties: { urls: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'The x402 endpoints (public http(s) URLs)' } }, required: ['urls'] }
            : { type: 'object', properties: { url: { type: 'string', description: 'The x402 endpoint (public http(s) URL)' } }, required: ['url'] },
          example: tool.example,
        }),
      });
      return wrapper;
    };
  }

  const limiter = createRateLimiter(FREE_CALLS_PER_HOUR, 60 * 60 * 1000);

  function buildServer(allowFree, caller = {}) {
    const server = new McpServer({ name: 'x402-doctor', version: VERSION });
    server.registerTool(
      'x402_quick_check',
      {
        title: 'Quick x402 endpoint check (free)',
        description: `Free: does this x402 endpoint work for a paying agent? Returns pass, warn or fail with the number of problems and the top three. Limited to ${FREE_CALLS_PER_HOUR} calls per hour. For every check use x402_diagnose ($0.01); for code changes x402_fix ($0.05); before paying someone else's endpoint x402_preflight ($0.001).`,
        inputSchema: { url: URL_ARG, method: METHOD_ARG },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async (args) => {
        if (!allowFree()) return toolError(`Free limit reached (${FREE_CALLS_PER_HOUR}/hour). Use x402_diagnose ($0.01 USDC via x402), or the free web page https://x402-doctor.fizzl.eu.`);
        const invalid = validateArgs(args);
        if (invalid) return toolError(invalid);
        try {
          return text(summarize(await diagnose(args.url, args.method)));
        } catch (err) {
          return toolError(`could not check: ${err.message}`);
        }
      }
    );
    if (checkPaymentProof) {
      server.registerTool(
        'check_payment_proof',
        {
          title: 'Check an x402 payment proof (free)',
          description: `Free: after paying an x402 endpoint, pass the PAYMENT-RESPONSE header it returned (X-PAYMENT-RESPONSE in v1). Returns the transaction, network and payer it names, whether that transaction exists on-chain and succeeded, and which USDC moved from whom to whom, with an explorer link. Read-only. Limited to ${FREE_CALLS_PER_HOUR} calls per hour.`,
          inputSchema: { header: z.string().min(8).max(20000).describe('The PAYMENT-RESPONSE header value (base64 JSON)') },
          annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (args) => {
          if (!allowFree()) return toolError(`Free limit reached (${FREE_CALLS_PER_HOUR}/hour). Use the free web page https://x402-doctor.fizzl.eu/settlement.`);
          try {
            return text(await checkPaymentProof(args.header));
          } catch (err) {
            return toolError(err.message);
          }
        }
      );
    }
    for (const tool of TOOLS) {
      server.registerTool(
        tool.name,
        {
          title: `${tool.title} (${tool.price} via x402)`,
          description: `${tool.description(tool.price)} The answer carries a signed receipt (EIP-191, bound to your arguments) that proves later which verdict you got.`,
          inputSchema: tool.input,
          annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (args, extra) => {
          const invalid = validateArgs(args); // before the payment step
          if (invalid) return toolError(invalid);
          let paid;
          try {
            paid = await wrappers[tool.name]();
          } catch (err) {
            return toolError(`payments unavailable: ${err.message}`);
          }
          return paid(async () => {
            try {
              const result = await tool.run(args);
              // Signed like the HTTP answers (receipt.js): route "mcp <tool>", input = the tool arguments.
              const payment = paymentOf(extra && extra._meta && extra._meta['x402/payment']);
              return text(signer && result && typeof result === 'object' ? await signer.sign(result, { route: `mcp ${tool.name}`, input: args, payment }) : result);
            } catch (err) {
              return toolError(`could not complete ${tool.name}: ${err.message}`); // not charged
            }
          })(args, extra);
        }
      );
    }
    if (feedback) {
      server.registerTool(
        feedback.mcpTool.name,
        {
          title: feedback.mcpTool.title,
          description: feedback.mcpTool.description,
          inputSchema: feedback.mcpShape(z),
          annotations: { readOnlyHint: false, openWorldHint: false },
        },
        async (args) => feedback.mcpCall(args, caller)
      );
    }
    return server;
  }

  const router = express.Router();
  router.post('/mcp', express.json({ limit: '64kb' }), async (req, res) => {
    const server = buildServer(() => limiter(req.ip), { ip: req.ip, userAgent: req.headers['user-agent'] });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[mcp] error:', err);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null });
    }
  });
  router.all('/mcp', (_req, res) => {
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed; POST JSON-RPC to /mcp' }, id: null });
  });
  return router;
}

module.exports = { createMcpRouter, FREE_CALLS_PER_HOUR, VERSION, summarize };
