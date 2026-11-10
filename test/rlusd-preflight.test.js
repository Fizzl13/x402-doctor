// RLUSD on the XRP Ledger in the preflight: priced in decimal dollars ("0.01" is one cent), so an RLUSD-only seller
// is priced and judged like a USDC one, not unknown_asset (EveBrief, oracle.evebrief.org, pointed it out on 10 Nov
// 2026). Only Ripple's issuer counts; a look-alike issuer stays an unknown token.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { preflight } = require('../lib/preflight');
const { createSafeFetch } = require('../lib/safe-fetch');

const PAY_TO = 'rMnHeutYALco8RYFVcmuU4BCgSzBpPEh32';
const RLUSD = '524C555344000000000000000000000000000000';
const ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
const rlusd = (over = {}) => ({ scheme: 'exact', network: 'xrpl:0', asset: RLUSD, amount: '0.01', payTo: PAY_TO, maxTimeoutSeconds: 300,
  extra: { issuer: ISSUER, invoiceId: 'example.com POST /v1/check', sourceTag: 804681468 }, ...over });

function seller(accept) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      res.setHeader('content-type', 'application/json');
      if (req.url === '/openapi.json') { res.statusCode = 404; return res.end('{}'); }
      const challenge = { x402Version: 2, resource: { url: `${origin}/paid`, mimeType: 'application/json', description: 'x' }, accepts: [accept] };
      res.statusCode = 402;
      res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(challenge)).toString('base64'));
      res.end(JSON.stringify(challenge));
    }).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/paid`));
    server.unref();
  });
}
const safeFetch = createSafeFetch({ allowPrivate: true });
// The payout account on the ledger: activated, with an RLUSD trust line.
const xrplFetch = async (url, init) => {
  const { method } = JSON.parse(init.body);
  const result = method === 'account_info'
    ? { account_data: { Account: PAY_TO, Flags: 0, Balance: '4562015' } }
    : { lines: [{ account: ISSUER, currency: RLUSD, balance: '1', limit: '1000000000', freeze: false }] };
  return new Response(JSON.stringify({ result }), { status: 200 });
};
const codes = (r) => r.reasons.map((x) => x.code);

test('preflight: RLUSD on xrpl:0 from Ripple\'s issuer is priced in dollars, not unknown_asset', async () => {
  const r = await preflight(await seller(rlusd()), { safeFetch, xrplFetch });
  assert.ok(!codes(r).includes('unknown_asset'), JSON.stringify(r.reasons));
  assert.deepEqual([r.options[0].asset_symbol, r.options[0].usd, r.options[0].payable], ['RLUSD', 0.01, true]);
  assert.notEqual(r.verdict, 'no_go', JSON.stringify(r.reasons));
});

test('preflight: an RLUSD option above max_usd is over_budget, below it is not', async () => {
  const url = await seller(rlusd({ amount: '0.25' }));
  const over = await preflight(url, { safeFetch, xrplFetch, maxUsd: 0.1 });
  assert.ok(codes(over).includes('over_budget'), JSON.stringify(over.reasons));
  assert.equal(over.verdict, 'no_go');
  const under = await preflight(url, { safeFetch, xrplFetch, maxUsd: 0.5 });
  assert.ok(!codes(under).includes('over_budget'), JSON.stringify(under.reasons));
});

test('preflight: "RLUSD" from another issuer stays an unknown token', async () => {
  const fake = rlusd({ extra: { issuer: PAY_TO, invoiceId: 'example.com POST /v1/check', sourceTag: 1 } });
  const r = await preflight(await seller(fake), { safeFetch, xrplFetch });
  assert.equal(r.options[0].usd, null);
  assert.equal(r.options[0].asset_symbol, null);
});
