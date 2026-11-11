'use strict';
// Offline: Coinbase Onramp's token API is a fake; nothing is bought.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { onrampRoute, sessionToken, onrampUrl } = require('../lib/onramp');

const ADDR = '0x6B0F4651eD42893ab58139938175E4a69f175F25';
const env = { CDP_API_KEY_ID: 'kid', CDP_API_KEY_SECRET: 'secret' };

async function serve(route) {
  const app = express();
  app.get('/api/onramp', route);
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => server.close() };
}

test('sessionToken: a JWT for POST /onramp/v1/token, USDC on Base to the one address', async () => {
  const seen = {};
  const token = await sessionToken({
    address: ADDR, env,
    generateJwt: async (a) => { seen.jwt = a; return 'jwt1'; },
    fetch: async (url, init) => { seen.url = url; seen.init = init; return Response.json({ token: 'tok1', channel_id: '' }); },
  });
  assert.equal(token, 'tok1');
  assert.deepEqual(seen.jwt, { apiKeyId: 'kid', apiKeySecret: 'secret', requestMethod: 'POST', requestHost: 'api.developer.coinbase.com', requestPath: '/onramp/v1/token', expiresIn: 120 });
  assert.equal(seen.url, 'https://api.developer.coinbase.com/onramp/v1/token');
  assert.equal(seen.init.headers.authorization, 'Bearer jwt1');
  assert.deepEqual(JSON.parse(seen.init.body), { addresses: [{ address: ADDR, blockchains: ['base'] }], assets: ['USDC'] });
});

test('onrampUrl: Coinbase checkout with the token, Base, USDC and the amount', () => {
  const u = new URL(onrampUrl('tok1', { amount: 25 }));
  assert.equal(u.origin + u.pathname, 'https://pay.coinbase.com/buy/select-asset');
  assert.deepEqual(Object.fromEntries(u.searchParams), { sessionToken: 'tok1', defaultNetwork: 'base', defaultAsset: 'USDC', presetFiatAmount: '25' });
});

test('GET /api/onramp: redirects to the checkout; json on request; bad input 400; no keys 503; Coinbase error 502', async () => {
  const ok = await serve(onrampRoute({ env, generateJwt: async () => 'jwt', fetch: async () => Response.json({ token: 'tok2' }) }));
  try {
    const r = await fetch(`${ok.base}/api/onramp?address=${ADDR}`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.match(r.headers.get('location'), /^https:\/\/pay\.coinbase\.com\/buy\/select-asset\?sessionToken=tok2&defaultNetwork=base&defaultAsset=USDC&presetFiatAmount=5$/);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const j = await (await fetch(`${ok.base}/api/onramp?address=${ADDR}&amount=20&format=json`)).json();
    assert.equal(j.network, 'base');
    assert.match(j.url, /presetFiatAmount=20/);
    assert.equal((await fetch(`${ok.base}/api/onramp?address=0x123`)).status, 400);
    assert.equal((await fetch(`${ok.base}/api/onramp?address=${ADDR}&amount=9999`)).status, 400);
  } finally { ok.close(); }

  const nokey = await serve(onrampRoute({ env: {} }));
  try { assert.equal((await fetch(`${nokey.base}/api/onramp?address=${ADDR}`)).status, 503); } finally { nokey.close(); }

  const fail = await serve(onrampRoute({ env, generateJwt: async () => 'jwt', fetch: async () => Response.json({ message: 'onramp not enabled' }, { status: 403 }) }));
  try {
    const r = await fetch(`${fail.base}/api/onramp?address=${ADDR}`, { redirect: 'manual' });
    assert.equal(r.status, 502);
    assert.match((await r.json()).error, /try again/);
  } finally { fail.close(); }
});
