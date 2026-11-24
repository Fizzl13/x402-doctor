'use strict';
// Can a Concordium payTo receive the token its 402 asks for? lib/diagnose.js checkConcordiumPayout asks Fizzl's
// Concordium facilitator (GET /payto, allow and deny lists read from the chain) once per payTo and network.
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkConcordiumPayout } = require('../lib/diagnose');

const MAINNET = 'ccd:9dd9ca4d19e9393877d2c44b70f89acb';
const PAY_TO = '45R4vB9JnXDUkYVNBrQE8yyg6o2qH32g7fX5N7i9yWxHxnFP7J';
const LIVE = { network: MAINNET, payTo: PAY_TO, ccd: { can_receive: true }, tokens: [
  { asset: 'USDR', can_receive: true }, { asset: 'eUSD', can_receive: false, why: 'the token has an allow list and payTo is not on it (the issuer adds accounts)' },
] }; // as the mainnet facilitator answered for 45R4 on 24 Nov 2026
const answer = (status, body) => { const calls = []; const f = async (url) => { calls.push(url); return { status, text: JSON.stringify(body) }; }; f.calls = calls; return f; };
const opt = (asset, over = {}) => ({ network: MAINNET, asset, amount: '10000', payTo: PAY_TO, extra: { feePayer: '4HxS' }, ...over });

test('a token payTo can receive passes; one on an allow list it is not on fails, with the way out', async () => {
  const checks = [];
  const f = answer(200, LIVE);
  await checkConcordiumPayout([opt('USDR'), opt('eUSD'), opt('CCD')], checks, { fetchPayTo: f });
  assert.deepEqual(checks.map((c) => [c.id, c.status, c.option]), [['concordium-payout-token', 'pass', 0], ['concordium-payout-token', 'fail', 1]]);
  assert.match(checks[1].message, /can't receive eUSD on Concordium: the token has an allow list.*Every payment in it fails/);
  assert.match(checks[1].hint, /issuer to put this account on the allow list/);
  assert.equal(f.calls.length, 1, 'one read per payTo');
  assert.match(f.calls[0], /^https:\/\/concordium-preview-mainnet-production\.up\.railway\.app\/payto\?payTo=45R4/);
});

test('an unknown token or account fails; an unreadable facilitator says nothing', async () => {
  const unknown = [];
  await checkConcordiumPayout([opt('NOPE')], unknown, { fetchPayTo: answer(200, LIVE) });
  assert.match(unknown[0].message, /NOPE is not a token on Concordium/);
  const noAccount = [];
  await checkConcordiumPayout([opt('USDR')], noAccount, { fetchPayTo: answer(404, { error: 'no such account on this network' }) });
  assert.match(noAccount[0].message, /is not an account on/);
  const down = [];
  await checkConcordiumPayout([opt('USDR')], down, { fetchPayTo: answer(503, { error: 'the chain could not be read just now' }) });
  await checkConcordiumPayout([opt('USDR')], down, { fetchPayTo: async () => { throw new Error('ECONNRESET'); } });
  await checkConcordiumPayout([opt('USDR')], down, { fetchPayTo: answer(404, 'Not found') });
  assert.deepEqual(down, []);
  const other = [];
  await checkConcordiumPayout([{ network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0x' + '11'.repeat(20) }], other, { fetchPayTo: answer(200, LIVE) });
  assert.deepEqual(other, [], 'only Concordium token options');
});

test('under node --test without an injected reader, nothing is fetched', async () => {
  const checks = [];
  let fetched = false;
  await checkConcordiumPayout([opt('USDR')], checks, { safeFetch: async () => { fetched = true; return { status: 200, text: JSON.stringify(LIVE) }; } });
  assert.equal(fetched, false);
});

test('the fix recipe names the way out', async () => {
  const { RECIPES } = require('../lib/recipes');
  const checks = [];
  await checkConcordiumPayout([opt('eUSD')], checks, { fetchPayTo: answer(200, LIVE) });
  const r = RECIPES.find((x) => x.match(checks[0]));
  assert.equal(r.key, 'concordium-payout-token');
  const fix = r.fix(checks[0], { accepts: [opt('eUSD')] });
  assert.match(fix.title, /allow list, or ask for another token/);
  assert.ok(fix.steps.some((s) => /USDR, EURR, t-USDC and CCD/.test(s)));
});
