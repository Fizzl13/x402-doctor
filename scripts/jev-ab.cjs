// Boots x402 Doctor from the current directory and, per paid route, prints what its 402 tells Jev (output length),
// and with TYPESAFE_API_KEY also Jev's bait scores for the live route and the local one.
const path = require('node:path');
const http = require('node:http');
const root = process.cwd();
const { createApp } = require(path.join(root, 'server.js'));
const { claimsOf, createLure } = require(path.join(root, 'lib/jev-lure.js'));
const ROUTES = ['diagnose', 'preflight/batch', 'fix', 'preflight', 'preflight/deep'];
const claimsAt = async (u) => { const r = await fetch(u, { headers: { accept: 'application/json' } }); return { bytes: (r.headers.get('payment-required') || '').length, c: claimsOf(JSON.parse(Buffer.from(r.headers.get('payment-required'), 'base64').toString())) }; };
(async () => {
  const fac = await new Promise((r) => { const s = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }, { x402Version: 2, scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', extra: { feePayer: '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4' } }], extensions: [], signers: {} })); }).listen(0, '127.0.0.1', () => r(s)); });
  const env = { AGENT_PAYOUT_WALLET: '0x6B0F4651eD42893ab58139938175E4a69f175F25', AGENT_PAYOUT_WALLET_SOLANA: 'ATWJ82T8nRdQwZnaysB68N5EpaSvLRsQP4h6eWmaJBH9', FACILITATOR_URL: `http://127.0.0.1:${fac.address().port}`, RECEIPT_SIGNER_SECRET: 'x'.repeat(48), MPP_SECRET: 'y'.repeat(32), DOCTOR_WARM_BAZAAR_INDEX: '0' };
  const app = createApp({ allowPrivate: true, env, bazaarIndex: { lookup: async () => ({ resource: false, origin: false }) }, trustIndex: { lookup: async () => null, seller: async () => null, refresh: () => Promise.resolve(), summary: () => null } });
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const local = `http://127.0.0.1:${srv.address().port}/api/v1/`;
  for (const route of ROUTES) {
    const q = '?url=https://example.com';
    const now = await claimsAt(local + route + q);
    let line = `route ${route} header ${now.bytes} out ${now.c.output.length}`;
    if (process.env.TYPESAFE_API_KEY) {
      const before = await claimsAt('https://x402-doctor.fizzl.eu/api/v1/' + route + q);
      const s = async (c) => (await createLure({ timeoutMs: 20000 }).judge('x402-doctor.fizzl.eu', c))?.mismatch;
      line += ` | mismatch live ${await s(before.c)} ${await s(before.c)} -> new ${await s(now.c)} ${await s(now.c)}`;
    }
    console.log(line);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
