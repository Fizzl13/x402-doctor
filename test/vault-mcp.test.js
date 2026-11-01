// Fizzl Pass vault over MCP (lib/mcp.js + lib/fizzl-vault.js): a paid tool call by a pass wallet earns credit back
// once @x402/mcp reports the settlement; a tool call with the pass proof on the request and no payment is paid from
// the vault.
process.env.BASE_RPC_URL = 'http://127.0.0.1:1';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { wrapMCPClientWithPayment } = require('@x402/mcp');
const { x402Client } = require('@x402/core/client');
const { ExactEvmScheme } = require('@x402/evm/exact/client');
const { createApp } = require('../server');
const { createPassVerifier } = require('../lib/fizzl-pass');
const { memoryVault } = require('../lib/fizzl-vault');

const BASE = 'eip155:8453';
const PAY_TO = '0x6B0F4651eD42893ab58139938175E4a69f175F25';
const servers = [];
const listen = (h) => new Promise((ok) => { const s = http.createServer(h).listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${s.address().port}`)); servers.push(s); });
const json = (res, v) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(v)); };
async function body(req) { let raw = ''; for await (const c of req) raw += c; return raw ? JSON.parse(raw) : {}; }
test.after(() => servers.forEach((s) => s.close()));

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const jwks = { keys: [{ kty: 'OKP', crv: 'Ed25519', kid: 'k', x: publicKey.export({ format: 'jwk' }).x }] };
const proof = (wallets) => { const b = `fzp1.${Buffer.from(JSON.stringify({ kid: 'k', tier: 'bronze', until: Date.now() + 86400000, wallets })).toString('base64url')}`; return `${b}.${crypto.sign(null, Buffer.from(b), privateKey).toString('base64url')}`; };

test('MCP: a paid preflight by a pass wallet earns 10% back; then a preflight with the proof and no payment is paid from the vault', async () => {
  const state = { settle: 0 };
  const facilitator = await listen(async (req, res) => {
    if (req.url.endsWith('/supported')) return json(res, { kinds: [{ x402Version: 2, scheme: 'exact', network: BASE }], extensions: [], signers: {} });
    const { paymentPayload } = await body(req);
    const from = paymentPayload.payload.authorization.from;
    if (req.url.endsWith('/verify')) return json(res, { isValid: true, payer: from });
    state.settle++;
    return json(res, { success: true, transaction: '0xsettled', network: BASE, payer: from });
  });
  const target = await listen((_req, res) => {
    const ch = { x402Version: 2, accepts: [{ scheme: 'exact', network: BASE, amount: '10000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }] };
    res.statusCode = 402; res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(ch)).toString('base64')); json(res, ch);
  });
  const vault = memoryVault();
  const app = createApp({ allowPrivate: true, env: { AGENT_PAYOUT_WALLET: PAY_TO, FACILITATOR_URL: facilitator, PASS_STATUS_URL: 'http://127.0.0.1:1/s' }, bazaarIndex: { lookup: async () => ({ resource: false, origin: false }) }, creditStore: null, vaultStore: vault, pass: createPassVerifier({ keys: jwks }) });
  const api = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${s.address().port}`)); servers.push(s); });

  const account = privateKeyToAccount(generatePrivateKey());
  const wallet = account.address.toLowerCase();
  const pass = proof([wallet]);
  const headers = { 'x-fizzl-pass': pass };

  // Paid with x402 over MCP (the diagnose costs $0.01): $0.001 back.
  const payments = new x402Client((_v, accepts) => accepts.find((a) => a.network === BASE)).register(BASE, new ExactEvmScheme(account));
  const paying = wrapMCPClientWithPayment(new Client({ name: 'paying-agent', version: '1.0.0' }), payments, { autoPayment: true });
  await paying.connect(new StreamableHTTPClientTransport(new URL(`${api}/mcp`), { requestInit: { headers } }));
  const paid = await paying.callTool('x402_diagnose', { url: target });
  assert.ok(!paid.isError, JSON.stringify(paid.content));
  assert.equal(paid.paymentMade, true);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await vault.balance([wallet]), 1000);
  await paying.close();

  // No payment, the proof on the request: the preflight ($0.001) is paid from the vault.
  const plain = new Client({ name: 'vault-agent', version: '1.0.0' });
  await plain.connect(new StreamableHTTPClientTransport(new URL(`${api}/mcp`), { requestInit: { headers } }));
  const settled = state.settle;
  const fromVault = await plain.callTool({ name: 'x402_preflight', arguments: { url: target } });
  assert.ok(!fromVault.isError, JSON.stringify(fromVault.content));
  assert.ok(['go', 'caution', 'no_go'].includes(JSON.parse(fromVault.content[0].text).verdict));
  assert.deepEqual(fromVault._meta['fizzl/vault'], { paid: true, usd: 0.001, balance_usd: 0 });
  assert.equal(state.settle, settled, 'no payment');
  // Empty now: the normal payment request.
  const again = await plain.callTool({ name: 'x402_preflight', arguments: { url: target } });
  assert.ok(again.isError || /accepts|payment/i.test(JSON.stringify(again)), 'asks for payment');
  assert.equal(again._meta?.['fizzl/vault'], undefined);
  await plain.close();
});
