// A seller priced in XRP on the XRP Ledger: priced_in_xrp (the network's own coin, on purpose), not unknown_asset.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { preflight } = require('../lib/preflight');
const { createSafeFetch } = require('../lib/safe-fetch');

function xrpSeller(asset = 'XRP') {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      res.setHeader('content-type', 'application/json');
      if (req.url === '/openapi.json') { res.statusCode = 404; return res.end('{}'); }
      const challenge = { x402Version: 2, resource: { url: `${origin}/paid`, mimeType: 'application/json', description: 'x' }, accepts: [{ scheme: 'exact', network: 'xrpl:0', amount: '1000', asset, payTo: 'rMnHeutYALco8RYFVcmuU4BCgSzBpPEh32', maxTimeoutSeconds: 60 }] };
      res.statusCode = 402;
      res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(challenge)).toString('base64'));
      res.end(JSON.stringify(challenge));
    }).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/paid`));
    server.unref();
  });
}

test('preflight: XRP on the XRP Ledger is priced_in_xrp, not an unknown token', async () => {
  const r = await preflight(await xrpSeller(), { safeFetch: createSafeFetch({ allowPrivate: true }), xrplFetch: async () => { throw new Error('offline'); } });
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes('priced_in_xrp'), JSON.stringify(r.reasons));
  assert.ok(!codes.includes('unknown_asset'));
  assert.match(r.reasons.find((x) => x.code === 'priced_in_xrp').message, /0\.001 XRP/);
});
