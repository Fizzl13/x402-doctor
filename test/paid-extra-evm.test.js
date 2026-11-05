// The Doctor's paid routes (and Fizzl Buy's) also take USDC on Polygon, Arbitrum and Avalanche C-Chain: in production
// (CDP configured) to the Base payout wallet, or <NAME>_PAY_TO; PayAI (or CDP, where it lists them) settles them.

process.env.BASE_RPC_URL = 'http://127.0.0.1:1';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../server');
const { paymentConfig, EXTRA_EVM } = require('../lib/paid-api');
const { routesFor, networksText } = require('../buy-server');

const BASE = 'eip155:8453';
const USDC = { 'eip155:137': '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', 'eip155:42161': '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 'eip155:43114': '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E' };
const PAY_TO_BASE = '0x6B0F4651eD42893ab58139938175E4a69f175F25';
const OTHER = '0x551faCB18b3f173F300c944a3BDcbe1A2847A6AF';
const CDP = { CDP_API_KEY_ID: 'id', CDP_API_KEY_SECRET: 'secret' };
const NETWORKS = Object.values(EXTRA_EVM);

const servers = [];
test.after(() => servers.forEach((s) => s.close()));
const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  servers.push(server);
});
const facilitator = (networks) => listen((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(req.url.endsWith('/supported')
    ? { kinds: networks.map((network) => ({ x402Version: 2, scheme: 'exact', network })), extensions: [], signers: {} }
    : { isValid: false }));
});
async function challengeFor(env) {
  const app = createApp({ allowPrivate: true, env, bazaarIndex: { lookup: async () => ({ resource: false, origin: false }) } });
  const api = await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    servers.push(server);
  });
  const res = await fetch(`${api}/api/v1/preflight?url=${encodeURIComponent('https://example.com/')}`);
  assert.equal(res.status, 402);
  return JSON.parse(Buffer.from(res.headers.get('payment-required'), 'base64').toString('utf8'));
}

test('paymentConfig: Polygon, Arbitrum and Avalanche in production to the Base wallet; <NAME>_PAY_TO or "off"; not in local runs', () => {
  assert.deepEqual(NETWORKS, ['eip155:137', 'eip155:42161', 'eip155:43114']);
  const base = { AGENT_PAYOUT_WALLET: PAY_TO_BASE };
  assert.equal(paymentConfig(base).accepts.some((a) => NETWORKS.includes(a.network)), false, 'no CDP: local or test run');
  const accepts = paymentConfig({ ...base, ...CDP }).preflightAccepts;
  for (const n of NETWORKS) {
    const o = accepts.find((a) => a.network === n);
    assert.equal(o.payTo, PAY_TO_BASE, n);
    assert.equal(o.price, '$0.001', `${n}: a dollar price, USDC is the default asset there`);
  }
  assert.equal(paymentConfig({ ...base, ...CDP, AVALANCHE_PAY_TO: OTHER }).accepts.find((a) => a.network === 'eip155:43114').payTo, OTHER);
  assert.equal(paymentConfig({ ...base, ...CDP, POLYGON_PAY_TO: 'off' }).accepts.some((a) => a.network === 'eip155:137'), false);
  assert.equal(paymentConfig({ ...base, ...CDP }).accepts[0].network, BASE, 'Base stays first (the paywall offers it)');
});

test('402 offers USDC on Polygon, Arbitrum and Avalanche when the facilitator lists them, at the dollar price', async () => {
  const payai = await facilitator([BASE, ...NETWORKS]);
  const challenge = await challengeFor({ AGENT_PAYOUT_WALLET: PAY_TO_BASE, FACILITATOR_URL: payai, POLYGON_PAY_TO: PAY_TO_BASE, ARBITRUM_PAY_TO: PAY_TO_BASE, AVALANCHE_PAY_TO: PAY_TO_BASE });
  for (const n of NETWORKS) {
    const o = challenge.accepts.find((a) => a.network === n);
    assert.ok(o, `no ${n} option in ${JSON.stringify(challenge.accepts.map((a) => a.network))}`);
    assert.equal(o.asset.toLowerCase(), USDC[n].toLowerCase(), n);
    assert.equal(o.amount, '1000', `${n}: $0.001 at 6 decimals`);
    assert.equal(o.payTo, PAY_TO_BASE);
    assert.ok(o.extra?.name && o.extra?.version, `${n}: the EIP-712 domain for the signature`);
  }
});

test('402 leaves a network out when no facilitator lists it (the others still pay)', async () => {
  const payai = await facilitator([BASE, 'eip155:43114']);
  const challenge = await challengeFor({ AGENT_PAYOUT_WALLET: PAY_TO_BASE, FACILITATOR_URL: payai, POLYGON_PAY_TO: PAY_TO_BASE, ARBITRUM_PAY_TO: PAY_TO_BASE, AVALANCHE_PAY_TO: PAY_TO_BASE });
  const nets = challenge.accepts.map((a) => a.network);
  assert.ok(nets.includes('eip155:43114'));
  assert.equal(nets.includes('eip155:137'), false);
  assert.equal(nets.includes('eip155:42161'), false);
  assert.ok(nets.includes(BASE));
});

test('Fizzl Buy offers $0.02 in USDC on the three networks too, and names them', () => {
  const accepts = routesFor({ AGENT_PAYOUT_WALLET: OTHER, ...CDP })['POST /v1/buy'].accepts;
  for (const n of NETWORKS) {
    const o = accepts.find((a) => a.network === n);
    assert.equal(o.payTo, OTHER, n);
    assert.equal(o.price, '$0.02');
    assert.equal(o.maxTimeoutSeconds, 300);
  }
  assert.equal(networksText(routesFor({ AGENT_PAYOUT_WALLET: PAY_TO_BASE, POLYGON_PAY_TO: OTHER, AVALANCHE_PAY_TO: OTHER })['POST /v1/buy'].accepts), 'USDC on Base, Polygon or Avalanche');
});

test('usage log: USDC payments on the three networks are named and counted in dollars', () => {
  const { usdOf, networkName } = require('../lib/usage-log');
  for (const n of NETWORKS) assert.equal(usdOf({ network: n, asset: USDC[n], amount: '20000' }), 0.02, n);
  if (typeof networkName === 'function') assert.equal(networkName('eip155:43114'), 'avalanche');
});
