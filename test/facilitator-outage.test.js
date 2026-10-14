// One facilitator's trouble must not take down every paid route (14 Oct 2026, 04:11–04:17 UTC:
// each paid route answered 500 for six minutes).
process.env.BASE_RPC_URL = 'http://127.0.0.1:1';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { createApp } = require('../server');

const BASE = 'eip155:8453';
const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const PAY_TO_BASE = '0x6B0F4651eD42893ab58139938175E4a69f175F25';
const PAY_TO_SOLANA = 'ATWJ82T8nRdQwZnaysB68N5EpaSvLRsQP4h6eWmaJBH9';
const KINDS = {
  [BASE]: { x402Version: 2, scheme: 'exact', network: BASE },
  [SOLANA]: { x402Version: 2, scheme: 'exact', network: SOLANA, extra: { feePayer: '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4' } },
};

const servers = [];
const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  servers.push(server);
});
test.after(() => servers.forEach((s) => s.close()));

// A Doctor whose facilitator answers /supported with the networks in `facilitator.networks`,
// or 503 while `facilitator.down`.
async function doctor(facilitator) {
  const facilitatorUrl = await listen((req, res) => {
    if (req.url.endsWith('/supported')) {
      facilitator.asked = (facilitator.asked || 0) + 1;
      if (facilitator.down) { res.statusCode = 503; return res.end('down'); }
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ kinds: facilitator.networks.map((n) => KINDS[n]), extensions: [], signers: {} }));
    }
    res.statusCode = 500;
    res.end();
  });
  const env = { AGENT_PAYOUT_WALLET: PAY_TO_BASE, AGENT_PAYOUT_WALLET_SOLANA: PAY_TO_SOLANA, FACILITATOR_URL: facilitatorUrl };
  const trustIndex = { lookup: async () => null, refresh: () => Promise.resolve(), summary: () => null };
  const app = createApp({ allowPrivate: true, env, bazaarIndex: { lookup: async () => ({ resource: false, origin: false }) }, trustIndex });
  return listen(app);
}

async function quote(api) {
  const res = await fetch(`${api}/api/v1/diagnose?url=https://example.com`);
  const challenge = res.headers.get('payment-required');
  return { status: res.status, networks: challenge ? JSON.parse(Buffer.from(challenge, 'base64').toString()).accepts.map((a) => a.network).sort() : [] };
}

test('a paid MCP tool does not ask the facilitators again: the paid routes keep their 402 while a facilitator is down', async () => {
  const facilitator = { networks: [BASE, SOLANA] };
  const api = await doctor(facilitator);
  assert.deepEqual(await quote(api), { status: 402, networks: [BASE, SOLANA].sort() });

  facilitator.down = true;
  const asked = facilitator.asked;
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${api}/mcp`)));
  const result = await client.callTool({ name: 'x402_fix', arguments: { url: 'https://example.com' } });
  await client.close();
  assert.deepEqual(await quote(api), { status: 402, networks: [BASE, SOLANA].sort() });
  assert.equal(facilitator.asked, asked, 'the supported kinds from the start are reused');
  assert.ok(result.isError, 'the unpaid tool call answers with its price');
  assert.deepEqual((result.structuredContent || JSON.parse(result.content[0].text)).accepts.map((a) => a.network).sort(), [BASE, SOLANA].sort());
});

test('a start with every facilitator down is tried again on the next paid call', async () => {
  const facilitator = { networks: [BASE, SOLANA], down: true };
  const api = await doctor(facilitator);
  assert.notEqual((await quote(api)).status, 402);
  facilitator.down = false;
  assert.deepEqual(await quote(api), { status: 402, networks: [BASE, SOLANA].sort() });
});
