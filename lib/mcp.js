// MCP server (Streamable HTTP, stateless) on POST /mcp, so MCP clients (Claude,
// Cursor, agent frameworks) and MCP directories can find and use x402 Doctor.
//
// Tools:
// - x402_quick_check (free, rate-limited): pass/warn/fail and the main problems.
// - x402_diagnose ($0.01), x402_preflight ($0.001), x402_preflight_batch
//   ($0.005, up to 10 endpoints), x402_preflight_deep ($0.01) and x402_fix
//   ($0.05), via x402: the same as the GET /api/v1/... routes, paid inside the
//   MCP call (_meta["x402/payment"]) at the same prices and on the same networks.
// - x402_delivery_check ($0.25): the paid delivery check (lib/delivery-checks.js), x402 Doctor buys the endpoint
//   once; x402_delivery_status (free) follows the job. Only with a job store (CREDITS_REDIS_URL).
// - verify_receipt (free): checks the signed receipt of a paid answer, as POST /api/v1/verify.
//
// Invalid input is refused before payment; a failed call is not charged.

'use strict';

const express = require('express');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { createPaymentWrapper } = require('@x402/mcp');
const { declareDiscoveryExtension } = require('@x402/extensions/bazaar');
const { STACKS } = require('./stack');
const { paymentOf } = require('./receipt');
const { NETWORK_ID_RE } = require('./networks');
const { merchantExtension } = require('./merchant');
const { normaliseBody } = require('./request-body');

const VERSION = '1.0.3';
const FREE_CALLS_PER_HOUR = 10;
// Claude calls remote MCP servers from Anthropic's outbound range (platform.claude.com/docs/en/api/ip-addresses), so
// every Claude user of a connector arrives from the same few addresses. A per-IP limit would hold all of them to one
// caller's 10 an hour; they share a larger pool instead.
const ANTHROPIC_OUTBOUND = [['160.79.104.0', 21]];
const SHARED_FREE_CALLS_PER_HOUR = 300;

function ipv4Number(ip) {
  const m = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || ''));
  if (!m || m.slice(1).some((p) => Number(p) > 255)) return null;
  return m.slice(1).reduce((n, p) => n * 256 + Number(p), 0);
}

function isAnthropicIp(ip) {
  const n = ipv4Number(ip);
  if (n === null) return false;
  return ANTHROPIC_OUTBOUND.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(ipv4Number(base) / 2 ** (32 - bits)));
}
const EXAMPLE_URL = 'https://ichimoku-signal.fizzl.eu/signal/BTC-USDT';

const URL_ARG = z.string().describe('The x402 endpoint (public http(s) URL), e.g. https://api.example.com/paid');
const METHOD_ARG = z.enum(['GET', 'POST']).optional().describe('HTTP method of the paid route (default: GET, then POST)');
const BODY_ARG = z.string().max(16 * 1024).optional().describe('Example JSON request body, for a POST route that checks its input before the 402 (implies POST). Without it, {} is sent and the requestBody example in the endpoint\'s /openapi.json is tried.');

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });
const toolError = (message) => ({ ...text(message), isError: true });
// A successful answer: the JSON as text (for clients that read text) and as structuredContent (matching the tool's outputSchema).
const json = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? { ...text(value), structuredContent: value } : text(value));

// Output schemas: the fields an agent acts on. Extra fields are allowed (passthrough), so new fields never break a call.
// MCP clients validate structuredContent even on an error result, and an unpaid call to a paid tool answers with
// x402's payment requirement as structuredContent ({ x402Version, accepts, ... }): so every field of a paid tool's
// schema is optional, and that answer passes as well.
const obj = (shape) => z.object(shape).passthrough();
// Loose on purpose: a paid answer must never fail the client's check after the payment went through.
const opt = (t) => t.nullable().optional();
const LIST = z.array(z.record(z.string(), z.unknown()));
const OVERALL = z.string().describe('pass, warn or fail');
const VERDICT = z.string().describe('go: pay; caution: ask first; no_go: do not pay');
const PAID = {
  receipt: opt(z.record(z.string(), z.unknown())).describe('Signed receipt (EIP-191) binding the answer to your arguments'),
  accepts: opt(LIST).describe('Only on an unpaid call: the x402 payment options'),
};
const OUTPUT = {
  x402_quick_check: obj({
    url: z.string().optional(),
    overall: OVERALL.describe('pass, warn or fail'),
    failures: z.number(),
    warnings: z.number(),
    top_problems: z.array(z.string()).describe('Up to three problems, failures first'),
    next: z.string().optional(),
  }),
  x402_trust_record: obj({
    url: z.string(),
    found: z.boolean().describe('false: not in the Trust Index (see how_to_list)'),
    days_checked: opt(z.number()),
    days_payable: opt(z.number()).describe('Days the daily scan found it payable (go or caution)'),
    payable_ratio: opt(z.number()),
    last: opt(z.string()).describe('Latest day: g go, c caution, n no_go, x unreachable'),
    last_scan: opt(z.record(z.string(), z.unknown())).describe('The latest verdict, reasons, price and networks'),
    submitted: opt(z.boolean()).describe('Added by its seller, not listed in a registry'),
    how_to_list: opt(z.string()),
  }),
  x402_trust_add: obj({
    ok: z.boolean().describe('true: added, already added, or already listed'),
    status: opt(z.string()).describe('added, submitted (already added) or listed (a registry lists it)'),
    url: opt(z.string()),
    verdict: opt(z.string()).describe('The pre-payment verdict when it was added'),
    message: opt(z.string()),
    error: opt(z.string()).describe('Why it was not added'),
    check: opt(z.string()).describe('The free web check for this URL'),
  }),
  check_payment_proof: obj({
    overall: OVERALL,
    decoded: z.record(z.string(), z.unknown()).optional().describe('Transaction, network and payer named in the header'),
    explorer: z.string().nullable().optional().describe('Explorer link for the transaction'),
    onchain: z.record(z.string(), z.unknown()).nullable().optional().describe('Whether the transaction exists and succeeded, and the USDC transfers'),
    checks: LIST.optional(),
  }),
  x402_diagnose: obj({
    url: opt(z.string()),
    overall: opt(OVERALL).describe('pass, warn or fail (absent on the payment requirement)'),
    checks: opt(LIST).describe('Every check with its status, message and hint'),
    ...PAID,
  }),
  x402_preflight: obj({
    url: opt(z.string()),
    verdict: opt(VERDICT),
    safe_to_pay: opt(z.boolean()),
    summary: opt(z.string()).describe('One line, e.g. OK to pay: $0.02 on Base.'),
    options: opt(LIST).describe('Each payment option with its network, price and problems'),
    reasons: opt(LIST),
    ...PAID,
  }),
  x402_fix: obj({
    url: opt(z.string()),
    overall: opt(OVERALL),
    summary: opt(z.string()),
    fixes: opt(LIST).describe('Each problem with steps and code for your stack'),
    improvements: opt(LIST).describe('Not wrong, but makes the service easier to find, trust or pay: steps and code'),
    unfixed: opt(LIST),
    ...PAID,
  }),
  x402_preflight_batch: obj({
    count: opt(z.number()),
    counts: opt(z.record(z.string(), z.number())).describe('How many go, caution, no_go and unknown'),
    results: opt(LIST).describe('One preflight per endpoint'),
    ...PAID,
  }),
  x402_preflight_deep: obj({
    url: opt(z.string()),
    verdict: opt(VERDICT),
    safe_to_pay: opt(z.boolean()),
    summary: opt(z.string()),
    options: opt(LIST),
    reasons: opt(LIST),
    ...PAID,
  }),
  x402_delivery_check: obj({
    id: opt(z.string()).describe('The job id: pass it to x402_delivery_status'),
    url: opt(z.string()),
    status: opt(z.string()).describe('queued, then done'),
    endpoint_price_usd: opt(z.number()),
    status_url: opt(z.string()),
    ...PAID,
  }),
  verify_receipt: obj({
    valid: z.boolean().describe('true: signed by an x402 Doctor signer, unchanged, and (when route and input are given) for that request'),
    reason: z.string().optional().describe('Why it is not valid'),
    signer: z.string().optional().describe('The address that signed it'),
    known_signer: z.boolean().nullable().optional().describe('Whether that address is a current, retired or certified x402 Doctor signer'),
    signer_status: z.string().nullable().optional().describe('current, retired or certified'),
    input_matches: z.boolean().optional().describe('Only with route and input: whether the receipt is for exactly that request'),
  }),
  x402_delivery_status: obj({
    id: z.string(),
    url: opt(z.string()),
    status: z.string().describe('awaiting_payment, queued or done'),
    result: opt(z.record(z.string(), z.unknown())).describe('Once done: paid_and_delivered, result, charged_usd, transaction, cache (could a CDN serve the paid answer to callers who did not pay)'),
    status_url: opt(z.string()),
  }),
};

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
  if (args.network !== undefined && !NETWORK_ID_RE.test(String(args.network))) return 'network must be a CAIP-2 id, e.g. eip155:8453';
  if (args.body !== undefined && args.body !== '') {
    if (Array.isArray(args.urls)) return 'body goes with one endpoint: use x402_preflight for each POST route that needs one';
    const { error } = normaliseBody(args.body);
    if (error) return error;
    if (args.method === 'GET') return 'body goes with POST';
  }
  return null;
}

// An example body implies POST.
function methodOf(args) {
  return args.body ? 'POST' : args.method;
}

// The short answer the free tool gives: the verdict and the first problems.
function summarize(report, { free = false } = {}) {
  const problems = report.checks.filter((c) => c.status === 'fail' || c.status === 'warn');
  return {
    url: report.url,
    overall: report.overall,
    failures: problems.filter((c) => c.status === 'fail').length,
    warnings: problems.filter((c) => c.status === 'warn').length,
    top_problems: problems.sort((a, b) => (a.status === b.status ? 0 : a.status === 'fail' ? -1 : 1)).slice(0, 3).map((c) => `${c.status}: ${c.message}`),
    next: free
      ? 'The full report, with a fix hint per problem, is free on https://x402-doctor.fizzl.eu.'
      : 'x402_diagnose ($0.01) returns every check with a hint; x402_fix ($0.05) returns the code changes for your stack.',
  };
}

// The paid delivery check over MCP. Checked before payment like the HTTP route (nothing is charged for a refusal);
// the job is queued inside the paid call and released to the queue only once the payment settled, which @x402/mcp
// reports in the result's _meta["x402/payment-response"] (as the HTTP route waits for PAYMENT-RESPONSE).
async function deliveryToolCall({ delivery, paid, args, extra, ip, sign = (r) => r }) {
  const check = await delivery.precheck({ url: args.url, method: args.method }, ip);
  if (check.status) return toolError(check.error);
  let job = null;
  const out = await paid(async () => {
    try {
      job = await delivery.queue(check);
      return json(await sign(delivery.view(job)));
    } catch (err) {
      return toolError(`could not queue the check (${err.message}); nothing was charged`);
    }
  })(args, extra);
  const settlement = out && out._meta && out._meta['x402/payment-response'];
  if (job && !out.isError && settlement && settlement.success) {
    await delivery.settle(job, settlement.transaction || '').catch((err) => console.error('[delivery] settle mark failed:', err.message));
  }
  return out;
}

// accepts[] for a paid tool from the supported kinds the HTTP paywall fetched at start. Only
// when those aren't there yet are the facilitators asked: initialize() empties the kinds the
// paywall shares and asks every facilitator again, so running it while one was slow or down
// left every paid route without that network, answering 500 until a restart (14 Oct, 04:11 UTC).
async function requirementsFor(resourceServer, options) {
  const build = async () => {
    const accepts = [];
    for (const option of options) accepts.push(...(await resourceServer.buildPaymentRequirements(option)));
    return accepts;
  };
  try {
    return await build();
  } catch {
    await resourceServer.initialize();
    return build();
  }
}

function createMcpRouter({ resourceServer, config, diagnose, runPreflight, runBatch = null, runDeep = null, buildFixes, signer = null, feedback = null, checkPaymentProof = null, verifyReceipt = null, delivery = null, trust = null, sharedFreePerHour = SHARED_FREE_CALLS_PER_HOUR }) {
  const TOOLS = [
    {
      name: 'x402_diagnose',
      accepts: config.accepts,
      price: config.price,
      title: 'Diagnose an x402 endpoint',
      summary: 'Every check of an x402 endpoint (402 challenge, accepts[], resource URL, Solana readiness, Bazaar/OpenAPI discovery, paywall) with a fix hint.',
      description: (p) => `Paid (${p} via x402 in USDC on Base, Solana, Algorand or Stellar, or in RLUSD on the XRP Ledger): diagnose an x402 endpoint the way a paying agent would, without paying it: the 402 challenge format, every accepts[] option, the resource URL, Solana settlement readiness, which wallets can pay, Bazaar/OpenAPI discovery and the browser paywall. Returns every check with pass/warn/fail and a fix hint. For the endpoint's owner or a developer debugging it; to decide whether to pay someone else's endpoint, use x402_preflight. Same as GET /api/v1/diagnose.`,
      input: { url: URL_ARG, method: METHOD_ARG, body: BODY_ARG },
      example: { url: EXAMPLE_URL },
      tags: ['x402', 'developer-tools', 'diagnostics', 'payments'],
      run: (a) => diagnose(a.url, methodOf(a), a.body),
    },
    {
      name: 'x402_preflight',
      accepts: config.preflightAccepts,
      price: config.preflightPrice,
      title: 'Check an x402 endpoint before paying it',
      summary: 'go / caution / no_go before an agent pays an x402 endpoint, with the recommended payment option and why.',
      description: (p) => `Paid (${p} via x402 in USDC on Base, Solana, Algorand or Stellar, or in RLUSD on the XRP Ledger): call this before your agent pays an x402 endpoint. Returns go, caution or no_go, the recommended payment option, and why: payment would fail, the seller's payout address is on the OFAC SDN sanctions list, over your budget (max_usd), price above what is advertised, not HTTPS, unknown token, its 30-day track record. Never pays the endpoint. The buyer's check for one call; for several endpoints at once use x402_preflight_batch, before a payment above about $1 x402_preflight_deep, and to debug your own endpoint x402_diagnose. Same as GET /api/v1/preflight.`,
      input: {
        url: URL_ARG,
        method: METHOD_ARG,
        body: BODY_ARG,
        max_usd: z.number().positive().optional().describe('Your budget per call in USD, e.g. 0.05'),
        network: z.string().optional().describe('CAIP-2 network you want to pay on, e.g. eip155:8453'),
        client: z.enum(['gateway']).optional().describe("Set to gateway when your agent pays with Circle's Gateway client (@circle-fin/x402-batching) from a Gateway balance: Gateway-only endpoints are then not a caution, and Gateway options are recommended first."),
      },
      example: { url: EXAMPLE_URL, max_usd: 0.05 },
      tags: ['x402', 'payments', 'safety', 'pre-payment'],
      run: (a) => runPreflight(a.url, { method: methodOf(a), body: a.body, maxUsd: a.max_usd, network: a.network, client: a.client }),
    },
    {
      name: 'x402_fix',
      accepts: config.fixAccepts,
      price: config.fixPrice,
      title: 'Fix plan for an x402 endpoint',
      summary: 'Diagnoses an x402 endpoint, then gives per problem the concrete change as code for your stack, filled in with your own values.',
      description: (p) => `Paid (${p} via x402 in USDC on Base, Solana, Algorand or Stellar, or in RLUSD on the XRP Ledger): diagnoses your x402 endpoint, then returns per problem the concrete change as code for your stack (${Object.keys(STACKS).join(', ')}), filled in with your own payTo, amount, network and route. A working endpoint gets improvements too (ERC-8004 identity, Base Builder Code, x402scan ownership proof, skill.md, browser paywall, Bazaar output schema), each with code. For the endpoint's owner: includes the diagnosis, so there is no need to call x402_diagnose first. Same as GET /api/v1/fix.`,
      input: { url: URL_ARG, method: METHOD_ARG, body: BODY_ARG, stack: z.enum(Object.keys(STACKS)).optional().describe('Your server stack (default: detected)') },
      example: { url: EXAMPLE_URL, stack: 'express' },
      tags: ['x402', 'developer-tools', 'fix', 'code'],
      run: async (a) => buildFixes(await diagnose(a.url, methodOf(a), a.body), { stack: a.stack }),
    },
    ...(runBatch && config.batchAccepts ? [{
      name: 'x402_preflight_batch',
      accepts: config.batchAccepts,
      price: config.batchPrice,
      title: 'Check up to 10 x402 endpoints before paying',
      summary: 'go / caution / no_go for up to 10 x402 endpoints in one call, with totals.',
      description: (p) => `Paid (${p} via x402 in USDC on Base, Solana, Algorand or Stellar, or in RLUSD on the XRP Ledger): the pre-payment check for up to 10 x402 endpoints at once. Per endpoint go, caution or no_go, the recommended payment option and why, plus totals. For marketplaces and agents that weigh several services. Never pays the endpoints. Same as GET /api/v1/preflight/batch.`,
      input: {
        urls: z.array(z.string()).min(1).max(10).describe('The x402 endpoints to check (public http(s) URLs), at most 10'),
        method: METHOD_ARG,
        max_usd: z.number().positive().optional().describe('Your budget per call in USD, e.g. 0.05'),
        network: z.string().optional().describe('CAIP-2 network you want to pay on, e.g. eip155:8453'),
        client: z.enum(['gateway']).optional().describe("Set to gateway when your agent pays with Circle's Gateway client (@circle-fin/x402-batching) from a Gateway balance: Gateway-only endpoints are then not a caution, and Gateway options are recommended first."),
      },
      example: { urls: [EXAMPLE_URL, 'https://presign-guard.fizzl.eu/v1/token'], max_usd: 0.05 },
      tags: ['x402', 'payments', 'safety', 'pre-payment', 'batch'],
      run: (a) => runBatch(a.urls, { method: a.method, maxUsd: a.max_usd, network: a.network, client: a.client }),
    }] : []),
    ...(runDeep && config.deepAccepts ? [{
      name: 'x402_preflight_deep',
      accepts: config.deepAccepts,
      price: config.deepPrice,
      title: 'Deep check of an x402 endpoint before an expensive payment',
      summary: 'The pre-payment verdict plus the full diagnosis, the daily history, the seller\'s other endpoints and domain moves.',
      description: (p) => `Paid (${p} via x402 in USDC on Base, Solana, Algorand or Stellar, or in RLUSD on the XRP Ledger): for expensive calls. The pre-payment verdict (go, caution or no_go) plus the full diagnosis, the 30-day history per day, how reliable the seller's other endpoints are and whether the endpoint moved domains. Never pays the endpoint. Worth it before a payment above about $1; for an ordinary call x402_preflight is enough. Same as GET /api/v1/preflight/deep.`,
      input: {
        url: URL_ARG,
        method: METHOD_ARG,
        body: BODY_ARG,
        max_usd: z.number().positive().optional().describe('Your budget per call in USD, e.g. 0.5'),
        network: z.string().optional().describe('CAIP-2 network you want to pay on, e.g. eip155:8453'),
        client: z.enum(['gateway']).optional().describe("Set to gateway when your agent pays with Circle's Gateway client (@circle-fin/x402-batching) from a Gateway balance: Gateway-only endpoints are then not a caution, and Gateway options are recommended first."),
      },
      example: { url: 'https://ichimoku-signal.fizzl.eu/setups', max_usd: 0.5 },
      tags: ['x402', 'payments', 'safety', 'pre-payment', 'due-diligence'],
      run: (a) => runDeep(a.url, { method: methodOf(a), body: a.body, maxUsd: a.max_usd, network: a.network, client: a.client }),
    }] : []),
    ...(delivery && delivery.accepts ? [{
      name: 'x402_delivery_check',
      accepts: delivery.accepts,
      price: delivery.price,
      title: 'Have an x402 endpoint bought once: paid and delivered?',
      summary: 'x402 Doctor buys an x402 endpoint once with its declared example input and publishes whether it was paid and delivered.',
      description: (p) => `Paid (${p} via x402 in USDC on Base, Solana, Algorand or Stellar, or in RLUSD on the XRP Ledger): not a reading but a purchase. x402 Doctor buys the endpoint once (at most $${delivery.capUsd}, USDC on Base, from its own wallet) with the example input its listing declares, checks the answer against the declared output schema, has TypeSafe's Jev judge whether it is what was paid for, and measures the charge on chain. Answers with a job id at once; follow it with x402_delivery_status (free), the result usually comes within minutes. The endpoint must get a "go" from the pre-payment check and be payable in USDC on Base; otherwise it is refused before payment. Same as GET /api/v1/delivery-check.`,
      input: { url: URL_ARG.describe('The x402 endpoint to buy once (https, someone else\'s, payable in USDC on Base)'), method: METHOD_ARG },
      example: { url: delivery.example },
      tags: ['x402', 'payments', 'verification', 'delivery', 'trust'],
      delivery: true,
    }] : []),
  ];

  const wrappers = {};
  for (const tool of TOOLS) {
    let wrapper = null;
    wrappers[tool.name] = async () => {
      if (wrapper) return wrapper;
      const accepts = await requirementsFor(resourceServer, tool.accepts);
      if (!accepts.length) throw new Error('paid tools not configured (no payout wallet)');
      wrapper = createPaymentWrapper(resourceServer, {
        accepts,
        resource: { url: `mcp://tool/${tool.name}`, description: tool.summary, mimeType: 'application/json', serviceName: 'x402 Doctor', tags: tool.tags },
        extensions: {
          ...declareDiscoveryExtension({
            toolName: tool.name,
            description: tool.summary,
            transport: 'streamable-http',
            inputSchema: tool.input.urls
              ? { type: 'object', properties: { urls: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'The x402 endpoints (public http(s) URLs)' } }, required: ['urls'] }
              : { type: 'object', properties: { url: { type: 'string', description: 'The x402 endpoint (public http(s) URL)' } }, required: ['url'] },
            example: tool.example,
          }),
          ...merchantExtension,
        },
      });
      return wrapper;
    };
  }

  const limiter = createRateLimiter(FREE_CALLS_PER_HOUR, 60 * 60 * 1000);
  const shared = createRateLimiter(sharedFreePerHour, 60 * 60 * 1000);
  const allowFreeFor = (ip) => () => (isAnthropicIp(ip) ? shared('anthropic') : limiter(ip));

  // free: only the free tools, for directories whose clients don't pay (POST /mcp/free, e.g. Claude's connectors
  // directory): no paid tool, nothing that buys, no feedback tool, and descriptions that don't point to paid tools.
  function buildServer(allowFree, caller = {}, { free = false } = {}) {
    const server = new McpServer({ name: 'x402-doctor', version: VERSION, title: 'x402 Doctor', websiteUrl: 'https://x402-doctor.fizzl.eu', icons: [{ src: 'https://x402-doctor.fizzl.eu/icon.png', mimeType: 'image/png', sizes: ['512x512'] }] });
    server.registerTool(
      'x402_quick_check',
      {
        title: 'Quick x402 endpoint check (free)',
        description: free
          ? `Free: does this x402 endpoint work for a paying agent? Returns pass, warn or fail with the number of problems and the top three. Never pays the endpoint. Limited to ${FREE_CALLS_PER_HOUR} calls per hour; the full report with a fix hint per problem is free on https://x402-doctor.fizzl.eu.`
          : `Free: does this x402 endpoint work for a paying agent? Returns pass, warn or fail with the number of problems and the top three. Limited to ${FREE_CALLS_PER_HOUR} calls per hour. For every check use x402_diagnose ($0.01); for code changes x402_fix ($0.05); before paying someone else's endpoint x402_preflight ($0.001).`,
        inputSchema: { url: URL_ARG, method: METHOD_ARG, body: BODY_ARG },
        outputSchema: OUTPUT.x402_quick_check,
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async (args) => {
        if (!allowFree()) return toolError(free ? 'Free limit reached for this hour. Try again later, or use the free web page https://x402-doctor.fizzl.eu.' : `Free limit reached (${FREE_CALLS_PER_HOUR}/hour). Use x402_diagnose ($0.01 USDC via x402), or the free web page https://x402-doctor.fizzl.eu.`);
        const invalid = validateArgs(args);
        if (invalid) return toolError(invalid);
        try {
          return json(summarize(await diagnose(args.url, methodOf(args), args.body), { free }));
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
          outputSchema: OUTPUT.check_payment_proof,
          annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (args) => {
          if (!allowFree()) return toolError(`Free limit reached (${FREE_CALLS_PER_HOUR}/hour). Use the free web page https://x402-doctor.fizzl.eu/settlement.`);
          try {
            return json(await checkPaymentProof(args.header));
          } catch (err) {
            return toolError(err.message);
          }
        }
      );
    }
    // The x402 Trust Index (free): an endpoint's daily record, and adding one no registry lists yet (its seller's
    // agent, right after deploying it). Same as GET /api/trust and POST /api/trust/submit.
    if (trust) {
      server.registerTool(
        'x402_trust_record',
        {
          title: 'x402 Trust Index record (free)',
          description: `Free: the daily track record of a paid x402 or MPP endpoint from the x402 Trust Index: on how many of the last 30 scanned days an agent could pay it, the latest verdict and reasons, price and networks. found: false when it is not in the index; add your own endpoint with x402_trust_add. Limited to ${FREE_CALLS_PER_HOUR} calls per hour.${free ? '' : ' Before paying, x402_preflight ($0.001) checks the live 402 and includes this record.'}`,
          inputSchema: { url: URL_ARG },
          outputSchema: OUTPUT.x402_trust_record,
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (args) => {
          if (!allowFree()) return toolError(`Free limit reached (${FREE_CALLS_PER_HOUR}/hour). Use GET https://x402-doctor.fizzl.eu/api/trust?url=… (free).`);
          try {
            const href = new URL(args.url).href;
            const record = await trust.lookup(href);
            if (!record) return json({ url: href, found: false, how_to_list: trust.howToList });
            const { history, days, ...rest } = record;
            return json({ url: href, found: true, ...rest, history });
          } catch (err) {
            return toolError(`could not look it up: ${err.message}`);
          }
        }
      );
      server.registerTool(
        'x402_trust_add',
        {
          title: 'Add your endpoint to the x402 Trust Index (free)',
          description: `Free: add your own paid endpoint to the x402 Trust Index when no registry lists it yet (CDP Bazaar, Circle's Agent Marketplace, GoPlausible, XRPL AI Hub, nohumans.directory, PayAPI Market, MPP directory). x402 Doctor first checks that it answers 402 with a payment challenge (x402, MPP or L402); the next daily scan starts its record, which buyers' agents see before they pay. At most 25 endpoints per host. Limited to ${FREE_CALLS_PER_HOUR} calls per hour.`,
          inputSchema: { url: URL_ARG },
          outputSchema: OUTPUT.x402_trust_add,
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        },
        async (args) => {
          if (!allowFree()) return toolError(`Free limit reached (${FREE_CALLS_PER_HOUR}/hour). Use POST https://x402-doctor.fizzl.eu/api/trust/submit (free).`);
          try {
            const out = await trust.submit(args.url);
            return json({ ok: out.status < 400, ...out.body });
          } catch (err) {
            return toolError(`could not add it: ${err.message}`);
          }
        }
      );
    }
    if (verifyReceipt && !free) {
      server.registerTool(
        'verify_receipt',
        {
          title: 'Verify a signed x402 Doctor answer (free)',
          description: 'Free: check the signed receipt that every paid x402 Doctor answer carries (diagnose, preflight, batch, deep, fix, delivery check; HTTP or MCP), for example to prove later which verdict you got before paying an endpoint. Pass the whole answer as response. Returns valid, the signer and whether it is an x402 Doctor signer; with route and input also whether the receipt is for exactly that request. A changed verdict or receipt fails. Read-only, nothing is stored. Same as POST /api/v1/verify.',
          inputSchema: {
            response: z.record(z.string(), z.unknown()).describe('The whole paid answer as you received it, including its receipt'),
            route: z.string().optional().describe('The request it answered: "mcp <tool name>" for an MCP answer (e.g. "mcp x402_preflight"), "GET /api/v1/preflight" for an HTTP one'),
            input: z.record(z.string(), z.unknown()).optional().describe('The tool arguments you sent (MCP), or the query parameters as strings (HTTP)'),
          },
          outputSchema: OUTPUT.verify_receipt,
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (args) => {
          try {
            return json(await verifyReceipt(args.response, args.route, args.input));
          } catch (err) {
            return toolError(`could not verify: ${err.message}`);
          }
        }
      );
    }
    for (const tool of free ? [] : TOOLS) {
      server.registerTool(
        tool.name,
        {
          title: `${tool.title} (${tool.price} via x402)`,
          description: `${tool.description(tool.price)} The answer carries a signed receipt (EIP-191, bound to your arguments) that proves later which verdict you got.`,
          inputSchema: tool.input,
          ...(OUTPUT[tool.name] ? { outputSchema: OUTPUT[tool.name] } : {}),
          // The delivery check buys the endpoint (from x402 Doctor's own wallet): not a reading.
          annotations: tool.delivery ? { readOnlyHint: false, destructiveHint: false, openWorldHint: true } : { readOnlyHint: true, openWorldHint: true },
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
          if (tool.delivery) {
            const payment = paymentOf(extra && extra._meta && extra._meta['x402/payment']);
            const sign = (result) => (signer ? signer.sign(result, { route: `mcp ${tool.name}`, input: args, payment }) : result);
            return deliveryToolCall({ delivery, paid, args, extra, ip: caller.ip, sign });
          }
          return paid(async () => {
            try {
              const result = await tool.run(args);
              // Signed like the HTTP answers (receipt.js): route "mcp <tool>", input = the tool arguments.
              const payment = paymentOf(extra && extra._meta && extra._meta['x402/payment']);
              return json(signer && result && typeof result === 'object' ? await signer.sign(result, { route: `mcp ${tool.name}`, input: args, payment }) : result);
            } catch (err) {
              return toolError(`could not complete ${tool.name}: ${err.message}`); // not charged
            }
          })(args, extra);
        }
      );
    }
    if (delivery && !free) {
      server.registerTool(
        'x402_delivery_status',
        {
          title: 'Status of a delivery check (free)',
          description: 'Free: the status of a delivery check ordered with x402_delivery_check (or GET /api/v1/delivery-check): awaiting_payment, queued or done, and once done the result: paid_and_delivered, the outcome, the charge measured on chain and the transaction.',
          inputSchema: { id: z.string().regex(/^[a-z0-9]{10}$/).describe('The job id x402_delivery_check answered with') },
          outputSchema: OUTPUT.x402_delivery_status,
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (args) => {
          try {
            const view = await delivery.status(args.id);
            return view ? json(view) : toolError('unknown delivery check');
          } catch (err) {
            return toolError(`could not read the status: ${err.message}`);
          }
        }
      );
    }
    if (feedback && !free) {
      server.registerTool(
        feedback.mcpTool.name,
        {
          title: feedback.mcpTool.title,
          description: feedback.mcpTool.description,
          inputSchema: feedback.mcpShape(z),
          ...(feedback.mcpOutputShape ? { outputSchema: feedback.mcpOutputShape(z) } : {}),
          annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        },
        async (args) => feedback.mcpCall(args, caller)
      );
    }
    return server;
  }

  const router = express.Router();
  const handle = (free) => async (req, res) => {
    const server = buildServer(allowFreeFor(req.ip), { ip: req.ip, userAgent: req.headers['user-agent'] }, { free });
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
  };
  // 256 kB like POST /api/v1/verify: a signed diagnose answer passed to verify_receipt can be larger than 64 kB
  // (server.js parses /mcp and /mcp/free with the same limit before its 4 kB parser).
  router.post('/mcp', express.json({ limit: '256kb' }), handle(false));
  router.post('/mcp/free', express.json({ limit: '256kb' }), handle(true));
  // Static server card (SEP-1649) for MCP directories: the same tools as tools/list on /mcp,
  // read once from a server built like the one per request, so it never goes stale.
  let card = null;
  router.get('/.well-known/mcp/server-card.json', async (_req, res) => {
    try {
      card = card || serverCard(buildServer(() => false)).catch((err) => { card = null; throw err; });
      res.set('Access-Control-Allow-Origin', '*').set('Cache-Control', 'public, max-age=3600').json(await card);
    } catch (err) {
      console.error('[mcp] server card:', err);
      res.status(500).json({ error: 'server card unavailable' });
    }
  });
  router.all(['/mcp', '/mcp/free'], (req, res) => {
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: `Method not allowed; POST JSON-RPC to ${req.path}` }, id: null });
  });
  return router;
}

// The server card: serverInfo, transport and capabilities as initialize returns them, and
// the tools as tools/list returns them, over an in-memory client.
async function serverCard(server) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'server-card', version: VERSION });
  await server.connect(serverSide);
  try {
    await client.connect(clientSide);
    const { tools } = await client.listTools();
    return {
      serverInfo: client.getServerVersion(),
      transport: { type: 'streamable-http', endpoint: '/mcp' },
      capabilities: client.getServerCapabilities(),
      authentication: { required: false },
      tools,
      resources: [],
      prompts: [],
    };
  } finally {
    await client.close();
    await server.close();
  }
}

module.exports = { createMcpRouter, serverCard, FREE_CALLS_PER_HOUR, SHARED_FREE_CALLS_PER_HOUR, isAnthropicIp, VERSION, summarize, deliveryToolCall };
