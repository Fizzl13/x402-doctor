// One-off: the real mppx client pays our Tempo (push) acceptance on the Moderato testnet.
// Throwaway keys made here, faucet tokens only (no value). Prints what happens.
import { createRequire } from 'node:module';
import http from 'node:http';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createClient, http as viemHttp, publicActions } from 'viem';
import { tempoModerato } from 'viem/chains';
import { Actions } from 'viem/tempo';
import { Mppx, tempo } from 'mppx/client';
const require = createRequire(import.meta.url);
const express = require('express');
const { createMppPay, unlessMppPaid } = require('./mpp-pay.cjs');

const payer = privateKeyToAccount(generatePrivateKey());
const shop = privateKeyToAccount(generatePrivateKey()).address;
const PATHUSD = '0x20c0000000000000000000000000000000000000';
console.log('payer', payer.address, 'recipient', shop);
const client = createClient({ chain: tempoModerato, transport: viemHttp() }).extend(publicActions);
const balance = async (who) => (await Actions.token.getBalance(client, { account: who, token: PATHUSD })).toString();

if (!process.env.SKIP_NET) {
  await Actions.faucet.fundSync(client, { account: payer.address });
  console.log('funded; payer pathUSD', await balance(payer.address));
}

const logs = [];
const mpp = createMppPay({
  secret: 'e2e-' + Math.random(), realm: 'tempo-e2e.test', recipient: shop, routes: { 'GET /paid': '$0.01' },
  facilitator: { async verify() { return { isValid: false, invalidReason: 'evm off in this test' }; }, async settle() { return { success: false }; } },
  tempo: { recipient: shop, chainId: 42431 },
  log: { warn: (m) => logs.push(m) },
});
const app = express();
app.use(mpp.middleware);
app.use(unlessMppPaid((req, res, next) => (req.path === '/paid' ? res.status(402).json({ x402Version: 2, accepts: [] }) : next())));
app.get('/paid', (req, res) => { res.on('finish', () => console.log('served; locals', JSON.stringify(res.locals.mppPayment))); res.json({ ok: true }); });
const server = await new Promise((r) => { const s = http.createServer(app).listen(0, () => r(s)); });
const url = `http://127.0.0.1:${server.address().port}/paid`;

const first = await fetch(url);
console.log('402?', first.status, '\n', first.headers.get('www-authenticate'));
if (process.env.SKIP_NET) { server.close(); process.exit(0); }

let lastAuth = null;
const mppx = Mppx.create({
  methods: [tempo({ account: payer })],
  polyfill: false,
  fetch: (input, init = {}) => { const h = new Headers(init.headers); if (h.get('authorization')) lastAuth = h.get('authorization'); return fetch(input, init); },
});
try {
  const res = await mppx.fetch(url);
  console.log('paid fetch:', res.status, await res.text());
  const rc = res.headers.get('payment-receipt');
  console.log('receipt:', rc && Buffer.from(rc, 'base64url').toString());
  console.log('recipient pathUSD', await balance(shop), 'payer pathUSD', await balance(payer.address));
  if (lastAuth) {
    const cred = JSON.parse(Buffer.from(lastAuth.replace(/^Payment\s+/, ''), 'base64url').toString());
    console.log('credential payload', JSON.stringify(cred.payload), 'source', cred.source, 'method', cred.challenge && cred.challenge.method);
    const replay = await fetch(url, { headers: { authorization: lastAuth } });
    console.log('replay:', replay.status, (await replay.text()).slice(0, 200));
  }
} catch (err) {
  console.log('PAY FAILED:', err && (err.stack || err.message));
}
console.log('server warnings', JSON.stringify(logs));
server.close();
