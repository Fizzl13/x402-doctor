// When the preflight's only objection is that the agent's network isn't offered (network_not_offered) and the
// endpoint takes USDC on Base within Fizzl Pay's cap, the answer says how to pay it anyway: Fizzl Pay (buy.fizzl.eu
// /v1/pay, ours) takes the agent's own chain and pays the endpoint on Base. Frits, 26 Nov 2026: "Verder".
'use strict';

const BASE = 'eip155:8453';
const PAY_URL = 'https://buy.fizzl.eu/v1/pay';
const CAP_USD = 1;
const FEE_SHARE = 0.02;
const FEE_MIN_USD = 0.002;

// The networks Fizzl Pay's 402 offers (buy-server.js payRoute); test/fizzl-pay-hint.test.js keeps the two in step.
const NETWORKS = {
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'Solana',
  'xrpl:0': 'the XRP Ledger (RLUSD or XRP)',
  'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k': 'Algorand',
  'stellar:pubnet': 'Stellar',
  'eip155:143': 'Monad',
  'eip155:137': 'Polygon',
  'eip155:42161': 'Arbitrum',
  'eip155:43114': 'Avalanche',
};

const up6 = (x) => Math.ceil(x * 1e6 - 1e-6) / 1e6;

// { url, method, network, offered: the payable options before the network filter, reasons: the preflight's reasons }
function fizzlPayHint({ url, method, network, offered = [], reasons = [] }) {
  if (!NETWORKS[network]) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.host === 'buy.fizzl.eu') return null;
  const m = String(method || 'GET').toUpperCase();
  if (m !== 'GET' && m !== 'POST') return null;
  const blocking = reasons.filter((r) => r.level === 'no_go').map((r) => r.code);
  if (blocking.length !== 1 || blocking[0] !== 'network_not_offered') return null;
  const base = offered.filter((o) => o.network === BASE && o.usd > 0 && o.usd <= CAP_USD).sort((a, b) => a.usd - b.usd)[0];
  if (!base) return null;
  const fee = up6(Math.max(FEE_MIN_USD, base.usd * FEE_SHARE));
  const total = up6(base.usd + fee);
  const pay = `${PAY_URL}?url=${encodeURIComponent(u.toString())}${m === 'POST' ? '&method=POST' : ''}`;
  return {
    service: 'Fizzl Pay',
    by: 'Fizzl, who also run x402 Doctor',
    how: `POST ${pay}`,
    url: pay,
    network,
    seller_usd: base.usd,
    fee_usd: fee,
    total_usd: total,
    note: `The endpoint takes only USDC on Base. Fizzl Pay checks it again, pays it on Base and returns its answer; its 402 asks $${total} ($${base.usd} plus the fee) on ${NETWORKS[network]}, and nothing is charged when the endpoint doesn't deliver. Guide: https://fizzl.eu/guides/pay-base-x402-other-chain/`,
  };
}

module.exports = { fizzlPayHint, FIZZL_PAY_NETWORKS: NETWORKS };
