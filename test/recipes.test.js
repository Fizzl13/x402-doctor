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
  // A plain Vercel function (x-matched-path is on every Vercel route) is not Next.js.
  assert.deepEqual([detectStack(r({ server: 'Vercel', 'x-vercel-id': 'x', 'x-matched-path': '/api/mcp' })).id, detectStack(r({ 'x-vercel-id': 'x', 'x-matched-path': '/api/mcp' })).detected_from], ['node', 'Vercel function (x-vercel-id)']);
  assert.equal(detectStack(r({ 'x-nextjs-cache': 'HIT' })).id, 'next');
  assert.equal(detectStack(r({})).id, 'generic');
  assert.equal(detectStack(r({ 'x-powered-by': 'Express' }), 'hono').id, 'hono');
});

test('no 402 but 200: the free-tier / middleware-order fix with this route', () => {
  const out = buildFixes(report({
    url: 'https://pg1.example/api/mcp', method: null, challenge: null,
    checks: [{ id: 'returns-402', status: 'fail', message: 'Endpoint did not return 402 Payment Required (POST 200).' }],
    probes: [{ method: 'POST', status: 200, headers: { 'x-vercel-id': 'x' } }],
  }));
  const f = fix(out, 'no-402');
  assert.match(f.title, /200 without asking for payment/);
  assert.match(code(f), /"POST \/api\/mcp"/);
  assert.match(code(f), /req\.headers\["x-free-tier"\]/);
  assert.match(f.steps[0], /"POST \/api\/mcp"/, 'the one method tried, not GET');
});

test('a description over the CDP limit gets a shorten-it fix', () => {
  const out = buildFixes(report({ checks: [{ id: 'resource-description-length', status: 'warn', message: 'resource.description is 612 characters; the CDP facilitator accepts at most 500.' }] }));
  const f = fix(out, 'description-length');
  assert.match(f.title, /500 characters/);
  assert.match(f.why, /612 characters/);
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
  const zero = buildFixes(report({ accepts: [{ network: BASE, amount: '10000', payTo: '0x0000000000000000000000000000000000000000' }], checks: [{ id: 'accepts[0]-payto', status: 'fail', message: 'payTo is the zero address.' }] }));
  assert.equal(fix(zero, 'payto').title, 'Set payTo to your own wallet');
  assert.match(code(fix(zero, 'payto')), /0x0\{40\}/);
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

test("EIP-712 domain: the token's own where it differs from Base's USDC (Celo, BNB Chain)", () => {
  const celo = buildFixes(report({
    accepts: [{ scheme: 'exact', network: 'eip155:42220', amount: '10000', asset: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C', payTo: PAY_TO, extra: { name: 'USD Coin', version: '2' } }],
    checks: [{ id: 'accepts[0]-extra', status: 'fail', message: 'EIP-712 domain "USD Coin" v2, but USDC on Celo signs as "USDC" v2' }],
  }));
  assert.match(code(fix(celo, 'eip712')), /"name":"USDC","version":"2"/);
  const bnb = buildFixes(report({
    accepts: [{ scheme: 'exact', network: 'eip155:56', amount: '10000000000000000', asset: '0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d', payTo: PAY_TO }],
    checks: [{ id: 'accepts[0]-extra', status: 'fail', message: "extra.name/extra.version (the token's EIP-712 domain) is missing" }],
  }));
  assert.match(code(fix(bnb, 'eip712')), /"name":"World Liberty Financial USD","version":"1"/);
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

test('openapi.json without any challenge still names a network', () => {
  const out = buildFixes(report({ challenge: null, probes: [{ method: 'GET', status: 200, headers: {} }], checks: [{ id: 'openapi-present', status: 'warn', message: 'No /openapi.json (HTTP 404).' }] }));
  const spec = JSON.parse(fix(out, 'openapi').code.find((c) => c.language === 'json').snippet);
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

test('domain move: /.well-known/x402 on another host and a Bazaar listing only under the old host', () => {
  const out = buildFixes(report({
    url: 'https://api.example.com/v1/thing',
    checks: [
      { id: 'well-known', status: 'warn', group: 'discovery', message: '/.well-known/x402 lists resources on https://old.onrender.com, not on https://api.example.com.' },
      { id: 'bazaar-listing', status: 'warn', group: 'discovery', message: 'The CDP Bazaar lists this route (same payTo) only under https://old.onrender.com.' },
    ],
  }));
  const wk = fix(out, 'well-known');
  assert.match(code(wk), /PUBLIC_URL \|\| "https:\/\/api\.example\.com"/);
  assert.match(code(wk), /\$\{PUBLIC_URL\}\/v1\/thing/);
  const listing = fix(out, 'bazaar-listing');
  assert.match(listing.steps[0], /https:\/\/api\.example\.com\/v1\/thing/);
  assert.equal(out.unfixed.length, 0);
});

test("cdp-validate: Coinbase's validator rejecting the route gets the steps and its own check to re-run", () => {
  const out = buildFixes(report({
    url: 'https://api.example.com/v1/thing',
    method: 'POST',
    checks: [{ id: 'cdp-validate', status: 'warn', group: 'discovery', message: "Coinbase's own validator (CDP) rejects this endpoint for the Bazaar: Endpoint uses x402 v1." }],
  }));
  const f = fix(out, 'cdp-validate');
  assert.equal(f.title, "Fix what Coinbase's validator rejects");
  assert.match(f.why, /x402 v1/);
  assert.match(f.steps[1], /"resource":"https:\/\/api\.example\.com\/v1\/thing","method":"POST"/);
  assert.equal(out.unfixed.length, 0);
});

test('merchant: a malformed x402-merchant extension gets the corrected extension', () => {
  const f = fix(buildFixes(report({ checks: [{ id: 'merchant', status: 'warn', message: 'x402-merchant extension: info.name is missing.' }] })), 'merchant');
  assert.match(f.title, /Fix the x402-merchant extension/);
  assert.match(f.why, /GoPlausible/);
  assert.match(code(f), /"x402-merchant"/);
});

test('builder code: a declaration the facilitator would drop gets declareBuilderCodeExtension', () => {
  const f = fix(buildFixes(report({ checks: [{ id: 'builder-code', status: 'warn', message: 'Base Builder Code: info.a (the app code) is missing.' }] })), 'builder-code');
  assert.equal(f.title, 'Fix the Base Builder Code declaration');
  assert.match(f.why, /info\.a \(the app code\) is missing/);
  assert.match(code(f), /declareBuilderCodeExtension\("bc_yourcode"\)/);
});

test('BNB Chain: amounts scale to the token\'s 18 decimals, and an unknown token gets a listed dollar token', () => {
  const USD1 = '0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d';
  const six = buildFixes(report({ accepts: [{ network: 'eip155:56', amount: '10000', asset: USD1, payTo: PAY_TO }], checks: [{ id: 'accepts[0]-amount', status: 'warn', message: 'looks written for 6-decimal USDC' }] }));
  assert.equal(fix(six, 'amount').title, 'Amount "10000" → "10000000000000000" ($0.01 of USD1)');
  const decimal = buildFixes(report({ accepts: [{ network: 'eip155:56', amount: '0.05', asset: USD1, payTo: PAY_TO }], checks: [{ id: 'accepts[0]-amount', status: 'warn', message: 'decimal' }] }));
  assert.match(code(fix(decimal, 'amount')), /"amount": "50000000000000000"/);
  const asset = buildFixes(report({ accepts: [{ network: 'eip155:56', amount: '10000000000000000', asset: '0x1111111111111111111111111111111111111111', payTo: PAY_TO }], checks: [{ id: 'accepts[0]-asset', status: 'warn', message: 'unknown token' }] }));
  assert.equal(fix(asset, 'asset').title, 'Use a dollar stablecoin on BNB Chain');
  assert.match(code(fix(asset, 'asset')), new RegExp(USD1.toLowerCase()));
});
