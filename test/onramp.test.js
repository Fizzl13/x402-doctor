'use strict';
// Offline: Coinbase Onramp's token API is a fake; nothing is bought.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { onrampRoute, sessionToken, onrampUrl } = require('../lib/onramp');

const ADDR = '0x6B0F4651eD42893ab58139938175E4a69f175F25';
const KEY = 'k'.repeat(40);
const env = { CDP_API_KEY_ID: 'kid', CDP_API_KEY_SECRET: 'secret', ONRAMP_KEY: KEY };
const auth = { authorization: `Bearer ${KEY}` };

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

test('GET /api/onramp: only with ONRAMP_KEY (the Agent Wallet); JSON with the checkout URL; bad input 400', async () => {
  let calls = 0;
  const ok = await serve(onrampRoute({ env, generateJwt: async () => 'jwt', fetch: async () => { calls++; return Response.json({ token: 'tok2' }); } }));
  try {
    const none = await fetch(`${ok.base}/api/onramp?address=${ADDR}`);
    assert.equal(none.status, 401);
    assert.match((await none.json()).error, /wallet\.fizzl\.eu/);
    assert.equal((await fetch(`${ok.base}/api/onramp?address=${ADDR}`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
    assert.equal(calls, 0, 'no Coinbase session without the key');

    const r = await fetch(`${ok.base}/api/onramp?address=${ADDR}&amount=20`, { headers: auth });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const j = await r.json();
    assert.equal(j.url, 'https://pay.coinbase.com/buy/select-asset?sessionToken=tok2&defaultNetwork=base&defaultAsset=USDC&presetFiatAmount=20');
    assert.deepEqual({ ...j, url: undefined }, { url: undefined, address: ADDR, network: 'base', asset: 'USDC', amount_usd: 20, expires_in_s: 300 });
    assert.equal((await fetch(`${ok.base}/api/onramp?address=0x123`, { headers: auth })).status, 400);
    assert.equal((await fetch(`${ok.base}/api/onramp?address=${ADDR}&amount=9999`, { headers: auth })).status, 400);
  } finally { ok.close(); }

  for (const partial of [{ ...env, ONRAMP_KEY: '' }, { ONRAMP_KEY: KEY }]) {
    const off = await serve(onrampRoute({ env: partial }));
    try { assert.equal((await fetch(`${off.base}/api/onramp?address=${ADDR}`, { headers: auth })).status, 503); } finally { off.close(); }
  }

  const fail = await serve(onrampRoute({ env, generateJwt: async () => 'jwt', fetch: async () => Response.json({ message: 'onramp not enabled' }, { status: 403 }) }));
  try {
    const r = await fetch(`${fail.base}/api/onramp?address=${ADDR}`, { headers: auth });
    assert.equal(r.status, 502);
    assert.match((await r.json()).error, /try again/);
  } finally { fail.close(); }
});

test('client_ip: the buyer IP the wallet server passes on goes to Coinbase as clientIp; a bad one is 400', async () => {
  const { cleanIp } = require('../lib/onramp');
  assert.equal(cleanIp('203.0.113.7'), '203.0.113.7');
  assert.equal(cleanIp('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(cleanIp('2001:db8::1'), '2001:db8::1');
  for (const bad of ['', 'localhost', '1.2.3', '203.0.113.7, 10.0.0.1']) assert.equal(cleanIp(bad), null, bad);

  const bodies = [];
  const s = await serve(onrampRoute({ env, generateJwt: async () => 'jwt', fetch: async (_u, init) => { bodies.push(JSON.parse(init.body)); return Response.json({ token: 'tok3' }); } }));
  try {
    assert.equal((await fetch(`${s.base}/api/onramp?address=${ADDR}&client_ip=203.0.113.7`, { headers: auth })).status, 200);
    assert.equal(bodies[0].clientIp, '203.0.113.7');
    assert.equal((await fetch(`${s.base}/api/onramp?address=${ADDR}&client_ip=2001:db8::1`, { headers: auth })).status, 200);
    assert.equal(bodies[1].clientIp, '2001:db8::1');
    const bad = await fetch(`${s.base}/api/onramp?address=${ADDR}&client_ip=evil`, { headers: auth });
    assert.equal(bad.status, 400);
    assert.equal(bodies.length, 2, 'no Coinbase session for a bad client_ip');
    // Without client_ip (an older wallet server): the token request as before, without clientIp.
    assert.equal((await fetch(`${s.base}/api/onramp?address=${ADDR}`, { headers: auth })).status, 200);
    assert.equal('clientIp' in bodies[2], false);
  } finally { s.close(); }
});

test('redirect_url: Coinbase sends the buyer back to a Fizzl page (the CDP allowlist); any other is 400', async () => {
  const { cleanReturnUrl } = require('../lib/onramp');
  assert.equal(cleanReturnUrl('https://wallet.fizzl.eu/?funded=1#/account'), 'https://wallet.fizzl.eu/?funded=1#/account');
  assert.equal(cleanReturnUrl('https://fizzl.eu/start/'), 'https://fizzl.eu/start/');
  for (const bad of ['http://wallet.fizzl.eu/', 'https://evil.example/', 'https://wallet.fizzl.eu.evil.example/', 'https://user@wallet.fizzl.eu/', 'https://wallet.fizzl.eu:8443/', 'javascript:alert(1)', '']) assert.equal(cleanReturnUrl(bad), null, bad);

  let calls = 0;
  const s = await serve(onrampRoute({ env, generateJwt: async () => 'jwt', fetch: async () => { calls++; return Response.json({ token: 'tok4' }); } }));
  try {
    const back = 'https://wallet.fizzl.eu/?funded=1#/account';
    const r = await fetch(`${s.base}/api/onramp?address=${ADDR}&redirect_url=${encodeURIComponent(back)}`, { headers: auth });
    assert.equal(r.status, 200);
    assert.equal(new URL((await r.json()).url).searchParams.get('redirectUrl'), back);
    const bad = await fetch(`${s.base}/api/onramp?address=${ADDR}&redirect_url=${encodeURIComponent('https://evil.example/')}`, { headers: auth });
    assert.equal(bad.status, 400);
    assert.equal(calls, 1, 'no Coinbase session for a bad redirect_url');
    const none = await fetch(`${s.base}/api/onramp?address=${ADDR}`, { headers: auth });
    assert.equal(new URL((await none.json()).url).searchParams.has('redirectUrl'), false);
  } finally { s.close(); }
});
