// MCP server (Streamable HTTP, stateless) on POST /mcp, so MCP clients (Claude,
// Cursor, agent frameworks) and MCP directories can find and use x402 Doctor.
//
// Four tools:
// - x402_quick_check (free, rate-limited): pass/warn/fail and the main problems.
// - x402_diagnose ($0.01), x402_preflight ($0.001) and x402_fix ($0.05), via x402:
//   the same as GET /api/v1/diagnose, /preflight and /fix, paid inside the MCP
//   call (_meta["x402/payment"]) at the same prices, on Base or Solana.
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

const VERSION = '1.0.0';
const FREE_CALLS_PER_HOUR = 10;
const EXAMPLE_URL = 'https://ichimoku-signal.onrender.com/signal/BTC-USDT';

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
function validateArgs(args) {
  let parsed;
  try {
    parsed = new URL(String(args.url));
  } catch {
    return 'url is not a valid URL';
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return 'url must be http(s)';
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

function createMcpRouter({ resourceServer, config, diagnose, runPreflight, buildFixes }) {
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
          inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'The x402 endpoint (public http(s) URL)' } }, required: ['url'] },
          example: tool.example,
        }),
      });
      return wrapper;
    };
  }

  const limiter = createRateLimiter(FREE_CALLS_PER_HOUR, 60 * 60 * 1000);

  function buildServer(allowFree) {
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
        if (!allowFree()) return toolError(`Free limit reached (${FREE_CALLS_PER_HOUR}/hour). Use x402_diagnose ($0.01 USDC via x402), or the free web page https://x402-doctor.onrender.com.`);
        const invalid = validateArgs(args);
        if (invalid) return toolError(invalid);
        try {
          return text(summarize(await diagnose(args.url, args.method)));
        } catch (err) {
          return toolError(`could not check: ${err.message}`);
        }
      }
    );
    for (const tool of TOOLS) {
      server.registerTool(
        tool.name,
        {
          title: `${tool.title} (${tool.price} via x402)`,
          description: tool.description(tool.price),
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
              return text(await tool.run(args));
            } catch (err) {
              return toolError(`could not complete ${tool.name}: ${err.message}`); // not charged
            }
          })(args, extra);
        }
      );
    }
    return server;
  }

  const router = express.Router();
  router.post('/mcp', express.json({ limit: '64kb' }), async (req, res) => {
    const server = buildServer(() => limiter(req.ip));
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
