'use strict';
// "Buy USDC with a card": a link that opens Coinbase Onramp with USDC on Base, delivered to one wallet address.
// GET /api/onramp?address=0x…[&amount=10] asks Coinbase for a single-use session token (POST /onramp/v1/token,
// signed with the CDP key Doctor already has for the facilitator) and redirects to Coinbase's own checkout. The buyer
// pays Coinbase and Coinbase sends the USDC; Fizzl never holds the money. Without CDP keys it answers 503.

const API_HOST = 'api.developer.coinbase.com';
const TOKEN_PATH = '/onramp/v1/token';
const PAY_URL = 'https://pay.coinbase.com/buy/select-asset';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function defaultJwt(args) {
  return require('@coinbase/cdp-sdk/auth').generateJwt(args);
}

// A single-use session token (5 minutes) for USDC on Base to `address`.
async function sessionToken({ address, env, fetch = globalThis.fetch, generateJwt = defaultJwt }) {
  const jwt = await generateJwt({
    apiKeyId: env.CDP_API_KEY_ID,
    apiKeySecret: env.CDP_API_KEY_SECRET,
    requestMethod: 'POST',
    requestHost: API_HOST,
    requestPath: TOKEN_PATH,
    expiresIn: 120,
  });
  const res = await fetch(`https://${API_HOST}${TOKEN_PATH}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
    body: JSON.stringify({ addresses: [{ address, blockchains: ['base'] }], assets: ['USDC'] }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || typeof body?.token !== 'string') {
    const why = body?.message || body?.error || `HTTP ${res.status}`;
    throw Object.assign(new Error(`Coinbase Onramp: ${why}`), { status: 502 });
  }
  return body.token;
}

function onrampUrl(token, { amount = 10 } = {}) {
  const q = new URLSearchParams({ sessionToken: token, defaultNetwork: 'base', defaultAsset: 'USDC', presetFiatAmount: String(amount) });
  return `${PAY_URL}?${q}`;
}

function onrampRoute({ env = process.env, fetch = globalThis.fetch, generateJwt = defaultJwt } = {}) {
  return async (req, res) => {
    res.set('cache-control', 'no-store');
    const address = String(req.query.address ?? '');
    if (!ADDRESS.test(address)) return res.status(400).json({ error: 'address must be a wallet address on Base (0x… , 40 hex characters)' });
    const amount = Math.round(Number(req.query.amount ?? 5)); // $5: Coinbase's limit per purchase until Onramp has full access
    if (!(amount >= 1 && amount <= 500)) return res.status(400).json({ error: 'amount must be between 1 and 500' });
    if (!env.CDP_API_KEY_ID || !env.CDP_API_KEY_SECRET) return res.status(503).json({ error: 'Card purchases are not available right now.' });
    try {
      const url = onrampUrl(await sessionToken({ address, env, fetch, generateJwt }), { amount });
      if (req.query.format === 'json') return res.json({ url, address, network: 'base', asset: 'USDC', expires_in_s: 300 });
      return res.redirect(302, url);
    } catch (err) {
      console.warn(`[onramp] ${err.message}`);
      return res.status(err.status || 502).json({ error: 'Coinbase could not start a purchase right now; try again in a minute.' });
    }
  };
}

module.exports = { sessionToken, onrampUrl, onrampRoute, PAY_URL };
