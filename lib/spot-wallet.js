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

function createSpotWallet({ key, capUsd, rpc = NETWORKS[BASE].rpc }) {
  const { wrapFetchWithPayment, x402Client } = require('@x402/fetch');
  const { ExactEvmScheme } = require('@x402/evm/exact/client');
  const { privateKeyToAccount } = require('viem/accounts');
  const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`);
  const client = new x402Client((_version, accepts) => accepts.find((a) => a.network === BASE && a.scheme === 'exact'))
    .setSpendControls({ maxAmountPerPayment: `$${capUsd}` });
  client.register(BASE, new ExactEvmScheme(account));
  return { address: account.address, payFetch: wrapFetchWithPayment(fetch, client), balance: () => usdcBalance(account.address, rpc) };
}

module.exports = { createSpotWallet, usdcBalance };
