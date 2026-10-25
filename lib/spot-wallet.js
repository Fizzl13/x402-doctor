// The spot-buy wallet (the key in SPOT_BUY_KEY): an x402 client that pays only x402 "exact" on Base, at most capUsd a
// payment, and the wallet's USDC balance on Base read from the chain. Used by scripts/spot-buy.js and
// scripts/index-payment.js.

const { NETWORKS } = require('./networks');

const BASE = 'eip155:8453';

async function usdcBalance(address, rpc) {
  const data = `0x70a08231${address.slice(2).toLowerCase().padStart(64, '0')}`;
  const res = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: NETWORKS[BASE].usdc, data }, 'latest'] }), signal: AbortSignal.timeout(15000) });
  const j = await res.json();
  if (!j.result) throw new Error(j.error?.message || 'no result');
  return Number(BigInt(j.result));
}

// A fetch that remembers the payment header of the last request that carried one, so a replay test can send the
// same payment once more ("Five Attacks on x402", arXiv 2605.11781, attack II). last() is a new object per payment.
function recordPayments(baseFetch = fetch) {
  let last = null;
  const recording = (input, init) => {
    const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
    const name = headers.has('payment-signature') ? 'payment-signature' : headers.has('x-payment') ? 'x-payment' : null;
    if (name) last = { name, value: headers.get(name) };
    return baseFetch(input, init);
  };
  return { fetch: recording, last: () => last };
}

function createSpotWallet({ key, capUsd, rpc = NETWORKS[BASE].rpc }) {
  const { wrapFetchWithPayment, x402Client } = require('@x402/fetch');
  const { ExactEvmScheme } = require('@x402/evm/exact/client');
  const { ExactEvmSchemeV1 } = require('@x402/evm/exact/v1/client');
  const { privateKeyToAccount } = require('viem/accounts');
  const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`);
  // x402 v1 sellers name the network "base" and the price maxAmountRequired; the spend cap applies to both versions.
  // Without the v1 scheme such a seller's payment failed on our side (cnvrt.ing, 25 Oct 2026: "No client registered
  // for x402 version: 1"), which counted against a seller real agents can pay.
  const client = new x402Client((_version, accepts) => accepts.find((a) => (a.network === BASE || a.network === 'base') && a.scheme === 'exact'))
    .setSpendControls({ maxAmountPerPayment: `$${capUsd}` });
  client.register(BASE, new ExactEvmScheme(account));
  client.registerV1('base', new ExactEvmSchemeV1(account));
  const payments = recordPayments();
  return { address: account.address, payFetch: wrapFetchWithPayment(payments.fetch, client), lastPayment: payments.last, balance: () => usdcBalance(account.address, rpc) };
}

module.exports = { createSpotWallet, recordPayments, usdcBalance };
