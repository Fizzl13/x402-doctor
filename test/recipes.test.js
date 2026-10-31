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

test('get-probe: a POST route whose GET answers 404 gets the GET/HEAD 402 middleware for its own path', () => {
  const out = buildFixes(report({
    url: 'https://api.example.com/v1/check', method: 'POST',
    checks: [{ id: 'get-probe', status: 'warn', message: 'An unpaid GET answers 404, while POST gets the 402.', get_status: 404 }],
    probes: [{ method: 'GET', status: 404, headers: { 'x-powered-by': 'Express' } }, { method: 'POST', status: 402, headers: { 'x-powered-by': 'Express' } }],
  }));
  const f = fix(out, 'get-probe');
  assert.match(f.title, /same 402 as POST/);
  assert.match(f.why, /GET on \/v1\/check answers 404/);
  assert.match(code(f), /new Set\(\["\/v1\/check"\]\)/);
  assert.match(code(f), /res\.set\("Allow", "POST"\)/);
  assert.match(code(f), /if \(paying\) return refuse\(\)/);
  assert.match(code(f), /Allow: POST\n/);
  assert.match(code(f), /405 Method Not Allowed/);
  assert.deepEqual(out.unfixed, []);
});


test('mpp-bad-credential: 400 gets the fresh-402 middleware; 2xx is the free-resource variant; 500 the crash one', () => {
  const run = (message, status = 'warn') => fix(buildFixes(report({ url: 'https://api.example.com/v1/data', checks: [{ id: 'mpp-bad-credential', status, message }] })), 'mpp-bad-credential');
  const f = run('A malformed Payment credential gets HTTP 400; clients expect 402 with a fresh challenge.');
  assert.match(f.title, /402 and a fresh challenge/);
  assert.match(code(f), /app\.use\("\/v1\/data"/);
  assert.match(code(f), /res\.status\(402\)\.set\("WWW-Authenticate", challengeFor\(req\)\)/);
  assert.match(code(f), /realm="api\.example\.com"/);
  assert.match(run('A made-up Payment credential got HTTP 200: the resource is served without a valid payment.', 'fail').title, /verify before serving/);
  assert.match(run('A malformed Payment credential crashes the endpoint (HTTP 500).', 'fail').title, /crashes/);
});

test('mpp-realm and mpp-stripe: the host as realm, and the missing Stripe details', () => {
  const out = buildFixes(report({ url: 'https://api.neynar.com/v2/x', checks: [
    { id: 'mpp-realm', status: 'warn', message: 'realm="neynar api" isn\'t this host (api.neynar.com).' },
    { id: 'mpp-stripe', status: 'fail', message: '[stripe] methodDetails.networkId is missing (your Stripe profile id).' },
  ] }));
  assert.match(fix(out, 'mpp-realm').title, /api\.neynar\.com/);
  assert.match(code(fix(out, 'mpp-realm')), /realm="api\.neynar\.com"/);
  assert.match(code(fix(out, 'mpp-stripe')), /"networkId"/);
});

test('agent-identity: a template for a wrong file, register for an unknown id, setAgentURI for one that points elsewhere', () => {
  const run = (message) => fix(buildFixes(report({ url: 'https://agent.example.com/v1/x', checks: [{ id: 'agent-identity', status: 'warn', message }] })), 'agent-identity');
  const file = run('/.well-known/agent-registration.json is not an ERC-8004 registration file (it needs "type": "https://eips.ethereum.org/EIPS/eip-8004#registration-v1" and a name).');
  assert.match(code(file), /eip-8004#registration-v1/);
  assert.match(code(file), /"endpoint": "https:\/\/agent\.example\.com\/"/);
  assert.match(code(run('The registration file says agent #123 in the ERC-8004 Identity Registry on Base, but that agent id doesn\'t exist there.')), /"register\(string\)" "https:\/\/agent\.example\.com\/\.well-known\/agent-registration\.json"/);
  const back = run('Agent #97522 in the ERC-8004 Identity Registry on Base points to https://old.example/x.json, not to agent.example.com. Anyone can claim a registration in their file; only one whose tokenURI points back here proves it.');
  assert.match(back.title, /#97522/);
  assert.match(code(back), /"setAgentURI\(uint256,string\)" 97522 "https:\/\/agent\.example\.com\/\.well-known\/agent-registration\.json"/);
});

test('payee-identity: setAgentWallet for an EVM payTo, a signed delegation for the others, and the page that does both', () => {
  const message = 'Not every payTo is bound to this agent (ERC-8004 payee verification): an agent that verifies payees may refuse the unbound ones: agent #97522 at block 1, agent wallet 0x2c7c…128b. Base 0x6B0F…5F25: mismatch; Solana ATWJ82…JBH9: mismatch.';
  const hint = 'Make 0x6B0F4651eD42893ab58139938175E4a69f175F25 the agent wallet (setAgentWallet in the Identity Registry 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432, the agent\'s owner sends it with an EIP-712 signature from that address), or have the agent wallet sign an EIP-712 payee delegation.';
  const payees = [
    { network: 'eip155:8453', payTo: '0x6B0F4651eD42893ab58139938175E4a69f175F25', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', outcome: 'mismatch' },
    { network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', payTo: 'ATWJ82yHqQ3wXrQ3ZVf1Bd7wXLp2Pyc4e2JPxwh6JBH9', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', outcome: 'mismatch' },
  ];
  const f = fix(buildFixes(report({ url: 'https://agent.example.com/v1/x', checks: [{ id: 'payee-identity', status: 'warn', message, hint, payees }] })), 'payee-identity');
  assert.match(f.title, /#97522/);
  assert.match(f.steps[0], /agent-wallet\.html\?agents=97522&wallet=0x6B0F4651eD42893ab58139938175E4a69f175F25&route=https%3A%2F%2Fagent\.example\.com%2Fv1%2Fx/);
  assert.match(code(f), /"setAgentWallet\(uint256,address,uint256,bytes\)" 97522 0x6B0F4651eD42893ab58139938175E4a69f175F25 \$DEADLINE \$SIGNATURE_FROM_PAYTO/);
  assert.match(code(f), /"network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"/);
  assert.match(code(f), /"origin": "https:\/\/agent\.example\.com"/);
  assert.equal(buildFixes(report({ checks: [{ id: 'payee-identity', status: 'pass', message: 'Every payTo is bound to this agent.' }] })).fixes?.length ?? 0, 0, 'a pass needs no fix');
});

test('payto-stable: one fixed payout address per network', () => {
  const f = fix(buildFixes(report({ checks: [{ id: 'payto-stable', status: 'warn', message: 'The payout address changes from one 402 to the next.' }] })), 'payto-stable');
  assert.match(code(f), /process\.env\.PAY_TO/);
});

test('improvements: info checks get their own list after the fixes, with code; warnings stay fixes', () => {
  const out = buildFixes(report({ url: 'https://api.example.com/v1/data', checks: [
    { id: 'agent-identity', status: 'info', message: 'No ERC-8004 registration file (/.well-known/agent-registration.json). Optional: it gives your service an on-chain identity.' },
    { id: 'builder-code', status: 'info', message: 'No Base Builder Code: Base cannot attribute payments on this route to your app.' },
    { id: 'openapi-ownership', status: 'info', message: 'No ownership proof in openapi.json.' },
    { id: 'well-known', status: 'info', message: 'No /.well-known/x402 (HTTP 404). Optional: crawlers such as x402scan read it.' },
    { id: 'well-known-names', status: 'info', message: '2 of 2 resource(s) in /.well-known/x402 have no name and description.' },
    { id: 'bazaar-output', status: 'info', message: 'Output example declared without an output schema.' },
    { id: 'paywall', status: 'info', message: 'No browser paywall: people opening the URL in a browser see the raw 402.' },
    { id: 'openapi-contact', status: 'info', message: 'No info.contact.email in openapi.json.' },
    { id: 'agent-instructions', status: 'info', message: 'No /skill.md or /llms.txt. Optional: a short Markdown file.' },
    { id: 'openapi-free-routes', status: 'info', message: 'Operations with neither x-payment-info nor "security": []: POST /verify.' },
    { id: 'wallets', status: 'info', message: 'Who can pay: MetaMask ✓ Base' },
  ] }));
  assert.deepEqual(out.fixes, []);
  assert.deepEqual(out.improvements.map((f) => f.recipe), ['agent-identity', 'builder-code', 'openapi-ownership', 'well-known', 'well-known-names', 'bazaar-output', 'paywall', 'openapi-contact', 'agent-instructions', 'openapi-free-routes']);
  assert.ok(out.improvements.every((f) => f.severity === 'info' && f.title && f.steps.length && f.code.length));
  const byKey = Object.fromEntries(out.improvements.map((f) => [f.recipe, f]));
  assert.match(code(byKey['agent-identity']), /eip-8004#registration-v1[\s\S]*"register\(string\)" "https:\/\/api\.example\.com\/\.well-known\/agent-registration\.json"/);
  assert.equal(byKey['builder-code'].title, 'Add a Base Builder Code');
  assert.match(code(byKey['agent-instructions']), /# api\.example\.com/);
  assert.match(code(byKey.paywall), /testnet: false/);
  assert.match(out.summary, /10 improvements/);
  assert.deepEqual(out.unfixed, [], 'info checks never land in unfixed');
});

test('mpp-challenge and stellar-option: a complete MPP challenge, and the USDC contract with sponsored fees', () => {
  const out = buildFixes(report({ url: 'https://pay.example.com/x', checks: [
    { id: 'mpp-id', status: 'fail', message: 'An MPP challenge has no id; clients send it back with the credential so the server can match the payment.' },
    { id: 'mpp-expires', status: 'warn', message: 'An MPP challenge has no expires; without it an old challenge can be paid again later (replay).' },
  ] }));
  const m = fix(out, 'mpp-challenge');
  assert.deepEqual(m.checks, ['mpp-id', 'mpp-expires'], 'one fix for both');
  assert.match(code(m), /realm="pay\.example\.com"/);
  assert.match(code(m), /"chainId": 8453/);
  const st = buildFixes(report({ url: 'https://pay.example.com/x', accepts: [{ scheme: 'exact', network: 'stellar:pubnet', amount: '100000', asset: 'USDC', payTo: 'GABC' }], checks: [
    { id: 'accepts[0]-asset', status: 'fail', message: 'accepts[0]: asset "USDC" is not a Soroban token contract (C…); x402 Stellar clients refuse it ("Invalid Stellar asset address").' },
  ] }));
  assert.match(code(fix(st, 'stellar-option')), /CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75/);
  assert.match(code(fix(st, 'stellar-option')), /"areFeesSponsored": true/);
});

test('payment-identifier: the missing extension is an improvement with code; required: true and a bad shape are fixes', () => {
  const { checkPaymentIdentifier } = require('../lib/diagnose');
  const { declarePaymentIdentifierExtension } = require('@x402/extensions/payment-identifier');
  const run = (extensions, x402Version = 2) => { const checks = []; checkPaymentIdentifier({ x402Version, accepts: [], ...(extensions ? { extensions } : {}) }, checks); return checks[0]; };
  assert.equal(run(undefined).status, 'info');
  assert.match(run(undefined).message, /^No payment-identifier extension/);
  assert.equal(run(undefined, 1), undefined, 'x402 v1 has no extensions');
  assert.equal(run({ 'payment-identifier': declarePaymentIdentifierExtension() }).status, 'pass');
  assert.equal(run({ 'payment-identifier': declarePaymentIdentifierExtension(true) }).status, 'warn');
  assert.match(run({ 'payment-identifier': declarePaymentIdentifierExtension(true) }).message, /gets 400/);
  assert.equal(run({ 'payment-identifier': { required: false } }).status, 'warn', 'required at the top, not under info');

  const missing = buildFixes(report({ checks: [run(undefined)] }));
  const imp = missing.improvements.find((f) => f.recipe === 'payment-identifier');
  assert.equal(imp.title, 'Let buyers retry a purchase without paying twice');
  assert.match(code(imp), /declarePaymentIdentifierExtension\(\)/);
  assert.match(code(imp), /extractPaymentIdentifier\(payment\)/);
  assert.match(code(imp), /app\.use\(paymentMiddleware/);
  const strict = buildFixes(report({ checks: [run({ 'payment-identifier': declarePaymentIdentifierExtension(true) })] }));
  assert.equal(fix(strict, 'payment-identifier').title, 'Make the payment id optional');
  const shape = buildFixes(report({ checks: [run({ 'payment-identifier': { required: false } })] }));
  assert.equal(fix(shape, 'payment-identifier').title, 'Fix the payment-identifier declaration');
});

// ---- The recipes for the remaining option checks (31 Oct 2026).
const one = (checks, opts = {}) => buildFixes(report({ checks, ...opts }));
const optionOf = (f) => JSON.parse(f.code.find((c) => c.label === 'The option, fixed').snippet);

test('gateway-option: Circle\'s domain version and Gateway Wallet', () => {
  const accepts = [{ scheme: 'exact', network: BASE, amount: '10000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: PAY_TO, extra: { name: 'GatewayWalletBatched', version: '2' } }];
  const f = fix(one([{ id: 'accepts[0]-extra', status: 'fail', message: 'accepts[0]: Circle Gateway option with extra.version "2"; …' }], { accepts }), 'gateway-option');
  assert.deepEqual(optionOf(f).extra, { name: 'GatewayWalletBatched', version: '1', verifyingContract: '0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE' });
});

test('accepts-order: standard options first, Gateway after', () => {
  const gw = { scheme: 'exact', network: BASE, amount: '10000', asset: 'x', payTo: PAY_TO, extra: { name: 'GatewayWalletBatched', version: '1', verifyingContract: '0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE' } };
  const std = { scheme: 'exact', network: BASE, amount: '10000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: PAY_TO, extra: { name: 'USD Coin', version: '2' } };
  const f = fix(one([{ id: 'accepts-order', status: 'warn', message: 'accepts[0] (Circle Gateway) comes before accepts[1] …' }], { accepts: [gw, std] }), 'accepts-order');
  assert.deepEqual(JSON.parse(f.code[0].snippet).map((a) => a.extra.name), ['USD Coin', 'GatewayWalletBatched']);
});

test('batch-settlement: receiverAuthorizer, withdrawDelay and the EIP-712 domain filled in', () => {
  const accepts = [{ scheme: 'batch-settlement', network: BASE, amount: '1000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: PAY_TO, extra: {} }];
  const f = fix(one([{ id: 'accepts[0]-extra', status: 'fail', message: 'accepts[0]: "batch-settlement" needs extra.receiverAuthorizer …', hint: 'Give the server scheme a receiverAuthorizerSigner.' }, { id: 'accepts[0]-batch-delay', status: 'warn', message: 'accepts[0]: no extra.withdrawDelay …' }], { accepts }), 'batch-settlement');
  const extra = optionOf(f).extra;
  assert.equal(extra.withdrawDelay, 86400);
  assert.match(extra.receiverAuthorizer, /signs your claims/);
  assert.deepEqual([extra.name, extra.version], ['USD Coin', '2']);
  assert.ok(f.steps.includes('Give the server scheme a receiverAuthorizerSigner.'));
});

test('auth-capture: operator, escrow, fees, flow and per-402 deadlines', () => {
  const accepts = [{ scheme: 'auth-capture', network: BASE, amount: '10000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: PAY_TO, extra: { authCaptureEscrow: '0x1234567890123456789012345678901234567890', minFeeBps: 50, maxFeeBps: 10, paymentFlow: 'charge', operatorType: 'policy' } }];
  const f = fix(one([{ id: 'accepts[0]-auth-escrow', status: 'fail', message: 'accepts[0]: extra.authCaptureEscrow … is not a commerce-payments escrow' }], { accepts }), 'auth-capture');
  const extra = optionOf(f).extra;
  assert.equal(extra.authCaptureEscrow, '0xf96815976523E00e65Be8f34cA5e64b4f41EB19c');
  assert.deepEqual([extra.minFeeBps, extra.maxFeeBps, extra.paymentFlow, extra.operatorType], [0, 0, 'escrow', 'delegated']);
  assert.match(extra.captureAuthorizer, /operator/);
  assert.match(code(f), /captureDeadline: now \+ 24 \* 3600/);
});

test('upto-extra, transfer-method and upto-proxy', () => {
  const upto = [{ scheme: 'upto', network: BASE, amount: '10000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: PAY_TO, extra: {} }];
  assert.equal(optionOf(fix(one([{ id: 'accepts[0]-extra', status: 'fail', message: 'accepts[0]: "upto" needs extra.facilitatorAddress …' }], { accepts: upto }), 'upto-extra')).extra.assetTransferMethod, 'permit2');
  assert.equal(optionOf(fix(one([{ id: 'accepts[0]-extra', status: 'fail', message: 'accepts[0]: USDT on Base has no transferWithAuthorization (EIP-3009), so this EIP-3009 option can\'t be settled.' }], { accepts: upto }), 'transfer-method')).extra.assetTransferMethod, 'permit2');
  const proxied = optionOf(fix(one([{ id: 'upto-proxy', status: 'fail', option: 0, message: 'The x402 upto proxy (0x4020…) is not deployed on Base …' }], { accepts: upto }), 'upto-proxy'));
  assert.deepEqual([proxied.scheme, proxied.extra], ['exact', { name: 'USD Coin', version: '2' }]);
});

test('cloudflare-option and cloudflare-registration', () => {
  const accepts = [{ scheme: 'exact', network: 'cloudflare:402', asset: 'USD', amount: '1', payTo: '0xabc', extra: { version: '1.0.0', other: 1 } }];
  const fixed = optionOf(fix(one([{ id: 'accepts[0]-payto', status: 'warn', message: 'accepts[0]: payTo "0xabc"; on Cloudflare\'s network it is "merchant" …' }], { accepts }), 'cloudflare-option'));
  assert.deepEqual([fixed.scheme, fixed.payTo, fixed.extra], ['batch-settlement', 'merchant', { version: '1.0.0', other: 1 }]);
  assert.match(code(fix(one([{ id: 'cloudflare-registration', status: 'warn', message: 'Cloudflare option without the http-message-signatures extension …' }], { accepts }), 'cloudflare-registration')), /registrationUrl/);
});

test('nevermined-plan, timeout and amount-zero', () => {
  const nvm = [{ scheme: 'nvm:erc4337', network: 'eip155:8453', planId: '123', payTo: PAY_TO }];
  assert.equal(optionOf(fix(one([{ id: 'accepts[0]-plan', status: 'warn', message: 'accepts[0]: plan 123… without an extra.agentId …' }], { accepts: nvm }), 'nevermined-plan')).planId, '123');
  assert.equal(optionOf(fix(one([{ id: 'accepts[0]-timeout', status: 'warn', message: 'accepts[0]: maxTimeoutSeconds 0 is outside 1..3600.' }]), 'timeout')).maxTimeoutSeconds, 300);
  const zero = fix(one([{ id: 'accepts[0]-amount-zero', status: 'warn', message: 'accepts[0]: amount "0": this request is quoted $0 …', hint: 'Answer 400 with what is missing.' }]), 'amount-zero');
  assert.ok(zero.steps[0].startsWith('Answer 400'));
  assert.match(code(zero), /status\(400\)/);
});

test('xrpl-invoice, xrpl-account and xrpl-trustline', () => {
  const xrpl = [{ scheme: 'exact', network: 'xrpl:0', amount: '0.01', asset: '524C555344000000000000000000000000000000', payTo: 'rExampleAccount', extra: { issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' } }];
  const inv = optionOf(fix(one([{ id: 'accepts[0]-invoice', status: 'warn', message: 'accepts[0]: no extra.invoiceId. …' }], { accepts: xrpl }), 'xrpl-invoice'));
  assert.deepEqual([inv.extra.invoiceId, inv.extra.sourceTag, inv.extra.issuer], ['api.example.com /paid', 804681468, 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De']);
  assert.match(code(fix(one([{ id: 'xrpl-payout-account', status: 'fail', option: 0, message: 'payTo rExampleAccount has Deposit Authorization on: …' }], { accepts: xrpl }), 'xrpl-account')), /"ClearFlag": 9/);
  assert.match(code(fix(one([{ id: 'xrpl-payout-account', status: 'fail', option: 0, message: 'payTo rExampleAccount requires a destination tag, but …' }], { accepts: xrpl }), 'xrpl-account')), /"ClearFlag": 1/);
  assert.match(code(fix(one([{ id: 'xrpl-payout-trustline', status: 'fail', option: 0, message: 'payTo rExampleAccount has no trust line for RLUSD …' }], { accepts: xrpl }), 'xrpl-trustline')), /"TransactionType": "TrustSet"[\s\S]*rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De/);
  assert.deepEqual(fix(one([{ id: 'xrpl-payout-trustline', status: 'fail', option: 0, message: 'The RLUSD trust line of payTo rExampleAccount is frozen, …' }], { accepts: xrpl }), 'xrpl-trustline').code, []);
});

test('algorand-feepayer, algorand-optin and stellar-trustline', () => {
  const algo = [{ scheme: 'exact', network: 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k', amount: '10000', asset: '31566704', payTo: 'ALGOPAYTO', extra: { feePayer: 'nope' } }];
  assert.match(code(fix(one([{ id: 'accepts[0]-feepayer', status: 'fail', message: 'accepts[0]: extra.feePayer "nope" is not a valid Algorand address …' }], { accepts: algo }), 'algorand-feepayer')), /\/supported/);
  assert.match(code(fix(one([{ id: 'algorand-payout-optin', status: 'fail', option: 0, message: 'payTo ALGOPAYTO has not opted in to ASA 31566704 …' }], { accepts: algo }), 'algorand-optin')), /goal asset optin --assetid 31566704 --account ALGOPAYTO/);
  const xlm = [{ scheme: 'exact', network: 'stellar:pubnet', amount: '100000', asset: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75', payTo: 'GPAYTO', extra: {} }];
  const missing = fix(one([{ id: 'stellar-payout-trustline', status: 'fail', option: 0, message: 'payTo GPAYTO does not exist on Stellar (never funded with XLM), …' }], { accepts: xlm }), 'stellar-trustline');
  assert.match(missing.title, /Fund/);
  assert.match(code(missing), /change-trust --source-account GPAYTO --line USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN/);
});

test('x401, l402, lightning and the MCP recipes', () => {
  assert.match(code(fix(one([{ id: 'x401', status: 'warn', message: 'x401: the PROOF-REQUEST header is not base64url-encoded JSON …', hint: 'PROOF-REQUEST: one unpadded base64url JSON object …' }]), 'x401')), /base64url/);
  assert.match(code(fix(one([{ id: 'l402-bad-credential', status: 'fail', message: 'A made-up preimage got HTTP 200: …', hint: 'Check that sha256(preimage) …' }]), 'l402')), /status\(401\)/);
  assert.match(code(fix(one([{ id: 'l402-expiry', status: 'fail', message: 'The invoice expired at …', hint: 'Make a fresh invoice for every 402.' }]), 'l402')), /WWW-Authenticate: L402/);
  assert.ok(fix(one([{ id: 'lightning-request-hash', status: 'fail', message: 'accepts[0]: extra.requestHash is not the http:1 hash …', hint: 'Hash JCS(…)' }]), 'lightning-option'));
  assert.match(code(fix(one([{ id: 'mcp-payment-text', status: 'fail', message: 'my_tool: the payment requirement is only in structuredContent; …', hint: 'Add the text content.' }]), 'mcp-payment')), /createPaymentWrapper/);
  assert.ok(fix(one([{ id: 'mcp-paid-tools', status: 'warn', message: 'No tool description says it is paid …', hint: 'Say so in the description.' }]), 'mcp-describe'));
});

test('every failed or warning check Doctor can report has a recipe, except a free trial', () => {
  // A free trial is not something the seller got wrong; every other check gets a fix.
  const out = one([{ id: 'returns-402', status: 'warn', message: 'No 402 yet: the endpoint answered for free during a trial (x-free-trial), …' }, { id: 'solana-payout-account', status: 'warn', option: 0, message: 'payTo X has no token account for USDC on Solana. …' }], { accepts: [{ scheme: 'exact', network: SOLANA, amount: '10000', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', payTo: 'So11111111111111111111111111111111111111112' }] });
  assert.deepEqual(out.unfixed.map((u) => u.id), ['returns-402']);
  assert.ok(fix(out, 'solana-account'));
});
