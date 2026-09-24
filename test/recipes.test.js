const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFixes, toAtomic, usd } = require('../lib/recipes');
const { detectStack } = require('../lib/stack');

const BASE = 'eip155:8453';
const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const PAY_TO = '0x6B0F4651eD42893ab58139938175E4a69f175F25';

function report({ url = 'https://api.example.com/paid', method = 'GET', checks = [], accepts = [{ scheme: 'exact', network: BASE, amount: '10000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: PAY_TO }], probes, challenge } = {}) {
  return {
    url,
    method,
    overall: checks.some((c) => c.status === 'fail') ? 'fail' : 'warn',
    checks,
    challenge: challenge === undefined ? { x402Version: 2, resource: { url, description: 'A thing', mimeType: 'application/json' }, accepts } : challenge,
    probes: probes || [{ method, status: 402, headers: { 'x-powered-by': 'Express' } }],
  };
}
const fix = (out, recipe) => out.fixes.find((f) => f.recipe === recipe);
const code = (f) => f.code.map((c) => c.snippet).join('\n');

test('amount helpers', () => {
  assert.equal(toAtomic('0.01'), '10000');
  assert.equal(toAtomic('$0.02'), '20000');
  assert.equal(toAtomic('1.5'), '1500000');
  assert.equal(toAtomic('abc'), null);
  assert.deepEqual(['10000', '1000', '2500000'].map(usd), ['$0.01', '$0.001', '$2.50']);
});

test('stack detection from response headers, and the override', () => {
  const r = (headers, challenge = null) => ({ probes: [{ status: 402, headers }], challenge });
  assert.equal(detectStack(r({ 'x-powered-by': 'Express' })).id, 'express');
  assert.equal(detectStack(r({ 'x-powered-by': 'Next.js' })).id, 'next');
  assert.equal(detectStack(r({ server: 'uvicorn' })).id, 'python');
  assert.equal(detectStack(r({ 'x-vercel-id': 'fra1::abc' }, { x402Version: 2 })).detected_from, 'x402 v2 challenge, hosted on Vercel');
  assert.equal(detectStack(r({})).id, 'generic');
  assert.equal(detectStack(r({ 'x-powered-by': 'Express' }), 'hono').id, 'hono');
});

test('no 402 but 200: the free-tier / middleware-order fix with this route', () => {
  const out = buildFixes(report({
    url: 'https://pg1.example/api/mcp', method: 'POST', challenge: null,
    checks: [{ id: 'returns-402', status: 'fail', message: 'Endpoint did not return 402 Payment Required (POST 200).' }],
    probes: [{ method: 'POST', status: 200, headers: { 'x-vercel-id': 'x' } }],
  }));
  const f = fix(out, 'no-402');
  assert.match(f.title, /200 without asking for payment/);
  assert.match(code(f), /"POST \/api\/mcp"/);
  assert.match(code(f), /x-free-tier/);
});

test('no 402: auth first, validation first, unreachable', () => {
  const probe = (status, extra = {}) => buildFixes(report({ challenge: null, checks: [{ id: 'returns-402', status: 'fail', message: 'no 402' }], probes: [{ method: 'GET', status, headers: {}, ...extra }] }));
  assert.match(fix(probe(401), 'no-402').title, /Authentication runs before the paywall/);
  assert.match(fix(probe(400), 'no-402').title, /Input validation/);
  assert.match(fix(probe(null, { error: 'ENOTFOUND' }), 'no-402').title, /cannot be reached/);
});

test('decimal amount -> atomic units, with the SDK price for Node stacks', () => {
  const out = buildFixes(report({ accepts: [{ network: BASE, amount: '0.01', payTo: PAY_TO }], checks: [{ id: 'accepts[0]-amount', status: 'warn', message: 'amount "0.01" looks like a decimal' }] }));
  const f = fix(out, 'amount');
  assert.equal(f.title, 'Amount "0.01" → "10000" ($0.01)');
  assert.match(code(f), /price: "\$0\.01"/);
  assert.match(code(f), /"amount": "10000"/);
});

test('payTo: names the likely cause (quotes, wrong chain) and validates at startup', () => {
  const quoted = buildFixes(report({ accepts: [{ network: BASE, amount: '10000', payTo: `"${PAY_TO}"` }], checks: [{ id: 'accepts[0]-payto', status: 'fail', message: 'payTo invalid' }] }));
  assert.match(fix(quoted, 'payto').why, /wrapped in quotes/);
  assert.match(code(fix(quoted, 'payto')), /0x\[0-9a-fA-F\]\{40\}/);
  const solana = buildFixes(report({ accepts: [{ network: BASE, amount: '10000', payTo: 'ATWJ82T8nRdQwZnaysB68N5EpaSvLRsQP4h6eWmaJBH9' }], checks: [{ id: 'accepts[0]-payto', status: 'fail', message: 'payTo invalid' }] }));
  assert.match(fix(solana, 'payto').why, /Solana address on an EVM network/);
});

test('legacy network name -> CAIP-2', () => {
  const out = buildFixes(report({ accepts: [{ network: 'base', amount: '10000', payTo: PAY_TO }], checks: [{ id: 'accepts[0]-network', status: 'warn', message: 'network "base" is a v1 name' }] }));
  assert.equal(fix(out, 'network').title, 'Network "base" → "eip155:8453"');
});

test('Solana fee payer and USDC account, EIP-712 domain', () => {
  const out = buildFixes(report({
    accepts: [{ network: BASE, amount: '10000', payTo: PAY_TO }, { network: SOLANA, amount: '10000', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', payTo: 'ATWJ82T8nRdQwZnaysB68N5EpaSvLRsQP4h6eWmaJBH9' }],
    checks: [
      { id: 'accepts[0]-extra', status: 'fail', message: 'extra.name/extra.version (the token\'s EIP-712 domain) is missing' },
      { id: 'accepts[1]-extra', status: 'fail', message: 'no extra.feePayer.' },
      { id: 'solana-payout-account', status: 'fail', message: 'no token account', option: 1 },
    ],
  }));
  assert.match(code(fix(out, 'eip712')), /"name":"USD Coin","version":"2"/);
  assert.match(code(fix(out, 'fee-payer')), /ExactSvmScheme/);
  assert.match(code(fix(out, 'solana-account')), /spl-token create-account EPjF\S+ --owner ATWJ82T8/);
});

test('http resource URL behind a proxy -> trust proxy (Express)', () => {
  const out = buildFixes(report({ checks: [{ id: 'resource-url', status: 'fail', message: 'resource.url is http://api.example.com/paid but the endpoint is served over https.' }] }));
  assert.match(code(fix(out, 'resource-https')), /app\.set\("trust proxy", 1\)/);
});

test('body mirror: the middleware for Node stacks, only the body shape for generic', () => {
  const check = [{ id: 'envelope-body-mirror', status: 'warn', message: 'Payment challenge is delivered only via the header' }];
  assert.match(code(fix(buildFixes(report({ checks: check })), 'body-mirror')), /function mirrorChallengeIntoBody/);
  assert.doesNotMatch(code(fix(buildFixes(report({ checks: check }), { stack: 'python' }), 'body-mirror')), /mirrorChallengeIntoBody/);
});

test('Bazaar declaration uses the real query parameters and the route key', () => {
  const out = buildFixes(report({ url: 'https://api.example.com/v1/price?symbol=BTC', checks: [{ id: 'bazaar', status: 'warn', message: 'No Bazaar discovery extension' }] }));
  const snippet = code(fix(out, 'bazaar'));
  assert.match(snippet, /input: \{"symbol":"BTC"\}/);
  assert.match(snippet, /"GET \/v1\/price"/);
  assert.match(snippet, /extensions: discovery/);
});

test('openapi.json is valid JSON with x-payment-info for this route', () => {
  const out = buildFixes(report({ checks: [{ id: 'openapi-present', status: 'warn', message: 'No /openapi.json (HTTP 404).' }] }));
  const spec = JSON.parse(fix(out, 'openapi').code.find((c) => c.language === 'json').snippet);
  assert.equal(spec.paths['/paid'].get['x-payment-info'].price.amount, '0.01');
  assert.deepEqual(spec.paths['/paid'].get['x-payment-info'].networks, [BASE]);
});

test('testnet paywall on mainnet', () => {
  const out = buildFixes(report({ checks: [{ id: 'paywall', status: 'fail', message: 'The browser paywall runs in testnet mode' }] }));
  assert.match(code(fix(out, 'paywall-testnet')), /testnet: false/);
});

test('blocking fixes first; info checks ignored; unknown warnings listed as unfixed; duplicates merged', () => {
  const out = buildFixes(report({
    accepts: [{ network: BASE, amount: '0.01', payTo: PAY_TO }, { network: BASE, amount: '0.01', payTo: PAY_TO }],
    checks: [
      { id: 'accepts[0]-amount', status: 'warn', message: 'decimal' },
      { id: 'accepts[1]-amount', status: 'warn', message: 'decimal' },
      { id: 'returns-402', status: 'pass', message: 'ok' },
      { id: 'paywall', status: 'info', message: 'No browser paywall' },
      { id: 'something-new', status: 'warn', message: 'future check' },
      { id: 'accepts[0]-payto', status: 'fail', message: 'payTo invalid' },
    ],
  }));
  assert.deepEqual(out.fixes.map((f) => f.recipe), ['payto', 'amount']);
  assert.deepEqual(out.fixes[1].checks, ['accepts[0]-amount', 'accepts[1]-amount']);
  assert.deepEqual(out.unfixed.map((u) => u.id), ['something-new']);
  assert.match(out.summary, /^2 fixes \(1 blocking\)/);
});

test('nothing to fix', () => {
  const out = buildFixes(report({ checks: [{ id: 'returns-402', status: 'pass', message: 'ok' }] }));
  assert.equal(out.summary, 'Nothing to fix: every check passes.');
});
