// The MCP check against hand-made servers: broken payment answers, SSE, sessions.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { checkMcp, exampleArgs, toolExample, rpcAnswer } = require('../lib/mcp-check');
const { createSafeFetch } = require('../lib/safe-fetch');

const servers = [];
test.after(() => servers.forEach((s) => s.close()));
const safeFetch = createSafeFetch({ allowPrivate: true });
const PR = { x402Version: 2, error: 'payment required', resource: { url: 'mcp://tool/lookup' }, accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '10000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0x6B0F4651eD42893ab58139938175E4a69f175F25', maxTimeoutSeconds: 60 }] };

// A JSON-RPC MCP server; onCall(name, args) gives the tools/call result or { error }.
function mcpServer({ onCall, tools, sse = false, session = null, requireSession = false }) {
  const seen = { calls: [] };
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      let raw = '';
      for await (const c of req) raw += c;
      const msg = raw ? JSON.parse(raw) : {};
      if (msg.id === undefined) { res.statusCode = 202; return res.end(); }
      if (requireSession && msg.method !== 'initialize' && req.headers['mcp-session-id'] !== session) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'no session' } }));
      }
      let answer;
      if (msg.method === 'initialize') answer = { result: { protocolVersion: '2025-06-18', serverInfo: { name: 'test-mcp', version: '1.0' }, capabilities: { tools: {} } } };
      else if (msg.method === 'tools/list') answer = { result: { tools } };
      else if (msg.method === 'tools/call') {
        seen.calls.push(msg.params);
        const out = onCall(msg.params.name, msg.params.arguments);
        answer = out.error ? { error: out.error } : { result: out };
      }
      const body = JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...answer });
      if (session && msg.method === 'initialize') res.setHeader('mcp-session-id', session);
      if (sse) {
        res.setHeader('content-type', 'text/event-stream');
        res.end(`event: message\ndata: ${body}\n\n`);
      } else {
        res.setHeader('content-type', 'application/json');
        res.end(body);
      }
    }).listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/mcp`, seen }));
    servers.push(server);
  });
}
const paidTool = { name: 'lookup', description: 'Paid: $0.01 USDC via x402 per call.', inputSchema: { type: 'object', properties: { ioc: { type: 'string' }, limit: { type: 'integer', minimum: 5 }, kind: { enum: ['ip', 'domain'] } }, required: ['ioc', 'limit', 'kind'] } };
const byId = (checks, id) => checks.filter((c) => c.id === id);

test('the @x402/mcp format (structuredContent + text) over SSE with a session passes', async () => {
  const { url, seen } = await mcpServer({ tools: [paidTool], sse: true, session: 's-1', requireSession: true, onCall: () => ({ isError: true, structuredContent: PR, content: [{ type: 'text', text: JSON.stringify(PR) }] }) });
  const checks = [];
  const out = await checkMcp(url, safeFetch, checks);
  assert.deepEqual(out.challenge, PR);
  assert.equal(out.mcp.session, true);
  assert.equal(byId(checks, 'mcp-server')[0].status, 'pass');
  assert.equal(byId(checks, 'mcp-payment-required')[0].status, 'pass');
  assert.deepEqual(seen.calls[0], { name: 'lookup', arguments: { ioc: 'test', limit: 5, kind: 'ip' } });
});

test('payment requirement only in structuredContent fails (text is required); only in text warns', async () => {
  let checks = [];
  let { url } = await mcpServer({ tools: [paidTool], onCall: () => ({ isError: true, structuredContent: PR, content: [{ type: 'text', text: 'pay first' }] }) });
  await checkMcp(url, safeFetch, checks);
  assert.equal(byId(checks, 'mcp-payment-text')[0].status, 'fail');
  checks = [];
  ({ url } = await mcpServer({ tools: [paidTool], onCall: () => ({ isError: true, content: [{ type: 'text', text: JSON.stringify(PR) }] }) }));
  await checkMcp(url, safeFetch, checks);
  assert.equal(byId(checks, 'mcp-payment-required')[0].status, 'pass');
  assert.equal(byId(checks, 'mcp-payment-structured')[0].status, 'warn');
});

test('a JSON-RPC error, a plain tool error, or a free answer instead of a payment requirement', async () => {
  const cases = [
    [() => ({ error: { code: 402, message: 'Payment required' } }), 'fail', /JSON-RPC error \(402/],
    [() => ({ isError: true, content: [{ type: 'text', text: 'Missing PAYMENT-SIGNATURE header' }] }), 'fail', /Missing PAYMENT-SIGNATURE/],
    [() => ({ isError: true, content: [{ type: 'text', text: 'token must be a 0x-prefixed address' }] }), 'warn', /refused before the payment step/],
    [() => ({ content: [{ type: 'text', text: 'here you go' }] }), 'warn', /answered without payment/],
  ];
  for (const [onCall, status, message] of cases) {
    const { url } = await mcpServer({ tools: [paidTool], onCall });
    const checks = [];
    const out = await checkMcp(url, safeFetch, checks);
    assert.equal(out.challenge, null);
    const c = byId(checks, 'mcp-payment-required')[0];
    assert.equal(c.status, status);
    assert.match(c.message, message);
  }
});

test('free and destructive tools are never called; at most two calls', async () => {
  const tools = [
    { name: 'free_one', description: 'Free: quick look. Paid details via lookup ($0.01).' },
    { name: 'wipe', description: 'Paid $1: deletes things', annotations: { destructiveHint: true } },
    { ...paidTool, name: 'a' }, { ...paidTool, name: 'b' }, { ...paidTool, name: 'c' },
  ];
  const { url, seen } = await mcpServer({ tools, onCall: () => ({ isError: true, structuredContent: PR, content: [{ type: 'text', text: JSON.stringify(PR) }] }) });
  const checks = [];
  await checkMcp(url, safeFetch, checks);
  assert.deepEqual(seen.calls.map((c) => c.name), ['a', 'b']);
});

test('no paid-looking tool: a warning, no calls; not MCP at all: null', async () => {
  const { url, seen } = await mcpServer({ tools: [{ name: 'echo', description: 'Echoes text.' }], onCall: () => ({}) });
  const checks = [];
  await checkMcp(url, safeFetch, checks);
  assert.equal(byId(checks, 'mcp-paid-tools')[0].status, 'warn');
  assert.equal(seen.calls.length, 0);

  const plain = await new Promise((resolve) => {
    const s = http.createServer((_req, res) => res.end('{"ok":true}')).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${s.address().port}/`));
    servers.push(s);
  });
  assert.equal(await checkMcp(plain, safeFetch, []), null);
});

test('HTTP 402 on tools/call (PAYMENT-REQUIRED header): read, warned about for @x402/mcp clients', async () => {
  const server = await new Promise((resolve) => {
    const s = http.createServer(async (req, res) => {
      let raw = '';
      for await (const c of req) raw += c;
      const msg = JSON.parse(raw);
      if (msg.id === undefined) { res.statusCode = 202; return res.end(); }
      res.setHeader('content-type', 'application/json');
      if (msg.method === 'initialize') return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'http402' } } }));
      if (msg.method === 'tools/list') return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [paidTool] } }));
      res.statusCode = 402;
      res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(PR)).toString('base64'));
      res.end('{"error":"payment required"}');
    }).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${s.address().port}/api/mcp`));
    servers.push(s);
  });
  const checks = [];
  const out = await checkMcp(server, safeFetch, checks);
  assert.deepEqual(out.challenge, PR);
  const c = byId(checks, 'mcp-payment-required')[0];
  assert.equal(c.status, 'warn');
  assert.match(c.message, /HTTP 402 .* PAYMENT-REQUIRED header/);
});

test("a tool's own example (_meta.examples) is used instead of guessed arguments", async () => {
  const example = { ioc: '8.8.8.8', limit: 10, kind: 'ip' };
  const { url, seen } = await mcpServer({ tools: [{ ...paidTool, _meta: { examples: [example] } }], onCall: () => ({ isError: true, structuredContent: PR, content: [{ type: 'text', text: JSON.stringify(PR) }] }) });
  await checkMcp(url, safeFetch, []);
  assert.deepEqual(seen.calls[0].arguments, example);
  assert.deepEqual(toolExample({ inputSchema: { type: 'object', examples: [{ a: 1 }] } }), { a: 1 });
  assert.equal(toolExample({ _meta: { examples: ['x'] } }), null);
});

test('helpers: example arguments and SSE parsing', () => {
  assert.deepEqual(exampleArgs({ type: 'object', properties: { type: { enum: ['approval'] }, token: { type: 'string' }, note: { type: 'string' } }, required: ['type'] }), { type: 'approval', token: '0x0000000000000000000000000000000000000001' });
  assert.deepEqual(exampleArgs({ type: 'object', properties: { u: { type: 'string', format: 'uri' }, n: { type: 'number' }, d: { type: 'string', default: 'x' } }, required: ['u', 'n', 'd'] }), { u: 'https://example.com', n: 1, d: 'x' });
  const res = { headers: new Map([['content-type', 'text/event-stream']]), text: 'event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{}}\n\n' };
  res.headers.get = res.headers.get.bind(res.headers);
  assert.deepEqual(rpcAnswer(res, 7), { jsonrpc: '2.0', id: 7, result: {} });
});
