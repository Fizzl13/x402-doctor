// MCP endpoint (POST /mcp): a real MCP client and a real x402 MCP client paying on
// Base, against a mock facilitator that verifies the EIP-3009 signature.
process.env.BASE_RPC_URL = 'http://127.0.0.1:1';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { verifyTypedData } = require('viem');
const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { wrapMCPClientWithPayment } = require('@x402/mcp');
const { x402Client } = require('@x402/core/client');
const { ExactEvmScheme } = require('@x402/evm/exact/client');
const { createApp } = require('../server');
const { FREE_CALLS_PER_HOUR } = require('../lib/mcp');

const BASE = 'eip155:8453';
const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const PAY_TO_BASE = '0x6B0F4651eD42893ab58139938175E4a69f175F25';
const PAY_TO_SOLANA = 'ATWJ82T8nRdQwZnaysB68N5EpaSvLRsQP4h6eWmaJBH9';

const servers = [];
const state = { verify: 0, settle: 0 };
function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    servers.push(server);
  });
}
async function body(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}
const json = (res, value) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(value));
};

let facilitatorUrl;
let targetUrl;
let api;

test.before(async () => {
  facilitatorUrl = await listen(async (req, res) => {
    if (req.url.endsWith('/supported')) {
      return json(res, {
        kinds: [
          { x402Version: 2, scheme: 'exact', network: BASE },
          { x402Version: 2, scheme: 'exact', network: SOLANA, extra: { feePayer: '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4' } },
        ],
        extensions: [],
        signers: {},
      });
    }
    const { paymentPayload, paymentRequirements: reqs } = await body(req);
    const { authorization, signature } = paymentPayload.payload;
    const valid = await verifyTypedData({
      address: authorization.from,
      domain: { name: reqs.extra.name, version: reqs.extra.version, chainId: 8453, verifyingContract: reqs.asset },
      types: {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'TransferWithAuthorization',
      message: authorization,
      signature,
    });
    const ok = valid && authorization.to === reqs.payTo && BigInt(authorization.value) >= BigInt(reqs.amount);
    if (req.url.endsWith('/verify')) {
      state.verify++;
      return json(res, ok ? { isValid: true, payer: authorization.from } : { isValid: false, invalidReason: 'invalid_signature', payer: authorization.from });
    }
    state.settle++;
    return json(res, { success: true, transaction: '0xsettled', network: BASE, payer: authorization.from });
  });

  // The endpoint being diagnosed: a minimal x402 v2 service.
  targetUrl = await listen((_req, res) => {
    const challenge = { x402Version: 2, accepts: [{ scheme: 'exact', network: BASE, amount: '10000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: PAY_TO_BASE, maxTimeoutSeconds: 60 }] };
    res.statusCode = 402;
    res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(challenge)).toString('base64'));
    json(res, challenge);
  });

  const env = { AGENT_PAYOUT_WALLET: PAY_TO_BASE, AGENT_PAYOUT_WALLET_SOLANA: PAY_TO_SOLANA, FACILITATOR_URL: facilitatorUrl };
  const trustIndex = {
    lookup: async (u) => (u.startsWith(targetUrl) ? { days_checked: 5, days_payable: 1, payable_ratio: 0.2, history: 'nnngn', last: 'n', streak: 1 } : null),
    refresh: () => Promise.resolve(),
    summary: () => ({ updated: '2026-09-23T03:00:00Z', days: 5, resources: 1, latest: { go: 0, caution: 0, no_go: 1, unreachable: 0 } }),
  };
  const app = createApp({ allowPrivate: true, env, bazaarIndex: { lookup: async () => ({ resource: false, origin: false }) }, trustIndex });
  api = await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    servers.push(server);
  });
});

test.after(() => servers.forEach((s) => s.close()));
test.beforeEach(() => {
  state.verify = 0;
  state.settle = 0;
});

async function mcpClient() {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${api}/mcp`)));
  return client;
}

test('mcp: a free quick check and three paid tools with their prices', async () => {
  const client = await mcpClient();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['x402_diagnose', 'x402_fix', 'x402_preflight', 'x402_quick_check']);
  assert.match(tools.find((t) => t.name === 'x402_diagnose').description, /\$0\.01/);
  assert.match(tools.find((t) => t.name === 'x402_preflight').description, /\$0\.001/);
  assert.match(tools.find((t) => t.name === 'x402_fix').description, /\$0\.05/);
  await client.close();
});

test('mcp: the free quick check gives the verdict and the top problems', async () => {
  const client = await mcpClient();
  const result = await client.callTool({ name: 'x402_quick_check', arguments: { url: targetUrl } });
  assert.ok(!result.isError, JSON.stringify(result.content));
  const out = JSON.parse(result.content[0].text);
  assert.ok(['pass', 'warn', 'fail'].includes(out.overall));
  assert.ok(Array.isArray(out.top_problems) && out.top_problems.length <= 3);
  assert.equal(out.checks, undefined, 'not the full report');
  await client.close();
});

test('mcp: a paid tool without payment answers with a challenge on Base and Solana, invalid input is refused first', async () => {
  const client = await mcpClient();
  const result = await client.callTool({ name: 'x402_fix', arguments: { url: targetUrl } });
  assert.ok(result.isError);
  const challenge = result.structuredContent || JSON.parse(result.content[0].text);
  assert.deepEqual(challenge.accepts.map((a) => [a.network, a.amount]).sort(), [[BASE, '50000'], [SOLANA, '50000']].sort());
  assert.equal(challenge.extensions.bazaar.info.input.toolName, 'x402_fix');
  const bad = await client.callTool({ name: 'x402_diagnose', arguments: { url: 'ftp://nope' } });
  assert.ok(bad.isError);
  assert.match(bad.content[0].text, /http\(s\)/);
  assert.equal(state.verify, 0);
  await client.close();
});

test('mcp: a real signed Base payment returns the full report and settles once', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const payments = new x402Client((_v, accepts) => accepts.find((a) => a.network === BASE)).register(BASE, new ExactEvmScheme(account));
  const client = wrapMCPClientWithPayment(new Client({ name: 'paying-agent', version: '1.0.0' }), payments, { autoPayment: true });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${api}/mcp`)));
  const result = await client.callTool('x402_diagnose', { url: targetUrl });
  assert.ok(!result.isError, JSON.stringify(result.content));
  const report = JSON.parse(result.content[0].text);
  assert.ok(Array.isArray(report.checks) && report.checks.length > 5);
  assert.equal(result.paymentMade, true);
  assert.deepEqual([state.verify, state.settle], [1, 1]);
  const pre = JSON.parse((await client.callTool('x402_preflight', { url: targetUrl, max_usd: 0.05 })).content[0].text);
  assert.ok(['go', 'caution', 'no_go'].includes(pre.verdict));
  await client.close();
});

test('mcp: the free quick check is rate limited', async () => {
  const client = await mcpClient();
  let last;
  for (let i = 0; i < FREE_CALLS_PER_HOUR + 1; i++) last = await client.callTool({ name: 'x402_quick_check', arguments: { url: targetUrl } });
  assert.ok(last.isError);
  assert.match(last.content[0].text, /Free limit reached/);
  await client.close();
});
