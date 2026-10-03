// Free payment-proof check: paste the PAYMENT-RESPONSE header (X-PAYMENT-RESPONSE in x402 v1)
// that a seller returned after a paid request, and see which on-chain transaction it points to,
// whether that transaction exists and succeeded, and which USDC moved from whom to whom.
//
// The header is base64 JSON from the facilitator's /settle answer:
//   { success, transaction, network, payer, errorReason? }
// Nothing is signed or sent here; the chains are only read (one public RPC call per check).

const { NETWORKS, V1_NAMES, isEvmAddress, isSolanaAddress } = require('./networks');

const EXPLORERS = {
  'eip155:8453': 'https://basescan.org/tx/',
  'eip155:84532': 'https://sepolia.basescan.org/tx/',
  'eip155:137': 'https://polygonscan.com/tx/',
  'eip155:42161': 'https://arbiscan.io/tx/',
  'eip155:10': 'https://optimistic.etherscan.io/tx/',
  'eip155:43114': 'https://snowtrace.io/tx/',
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'https://solscan.io/tx/',
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': 'https://solscan.io/tx/{tx}?cluster=devnet',
};
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const EVM_TX_RE = /^0x[0-9a-fA-F]{64}$/;
const SOL_SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

// Accepts the bare header value, a "PAYMENT-RESPONSE: …" line, or the decoded JSON itself.
function decodeSettlement(input) {
  // A transaction looked up directly (e.g. a link from a wallet receipt): { transaction, network, payer? }.
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const rawNetwork = typeof input.network === 'string' ? input.network.slice(0, 64) : '';
    return { direct: true, success: undefined, transaction: typeof input.transaction === 'string' ? input.transaction.trim().slice(0, 120) : '', network: V1_NAMES[rawNetwork] || rawNetwork, networkAsSent: rawNetwork, payer: typeof input.payer === 'string' ? input.payer.trim().slice(0, 80) : '', extra: {} };
  }
  let text = String(input || '').trim();
  if (!text) throw fail('Paste the PAYMENT-RESPONSE header value.');
  if (text.length > 20_000) throw fail('That is too long for a PAYMENT-RESPONSE header.');
  text = text.replace(/^(x-)?payment-response\s*:\s*/i, '').replace(/^["']|["']$/g, '').trim();
  let obj = null;
  if (text.startsWith('{')) {
    try { obj = JSON.parse(text); } catch { throw fail('That looks like JSON but does not parse.'); }
  } else {
    let json;
    try { json = Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch { json = ''; }
    try { obj = JSON.parse(json); } catch { throw fail('This is not a PAYMENT-RESPONSE header: it should be base64-encoded JSON.'); }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw fail('The header decodes, but not to a JSON object.');
  if (obj.success === undefined && obj.errorReason === undefined && typeof obj.transaction === 'string' && typeof obj.network === 'string') return decodeSettlement({ transaction: obj.transaction, network: obj.network, payer: obj.payer });
  const rawNetwork = typeof obj.network === 'string' ? obj.network : '';
  const network = V1_NAMES[rawNetwork] || rawNetwork;
  return {
    success: obj.success,
    transaction: typeof obj.transaction === 'string' ? obj.transaction : (typeof obj.txHash === 'string' ? obj.txHash : ''),
    network,
    networkAsSent: rawNetwork,
    payer: typeof obj.payer === 'string' ? obj.payer : '',
    errorReason: typeof obj.errorReason === 'string' ? obj.errorReason : undefined,
    extra: Object.fromEntries(Object.entries(obj).filter(([k]) => !['success', 'transaction', 'txHash', 'network', 'payer', 'errorReason'].includes(k)).slice(0, 10)),
  };
}

async function rpc(url, method, params, fetchImpl) {
  const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`RPC: ${body.error.message || 'error'}`);
  return body.result;
}

const units = (raw, decimals = 6) => Number(BigInt(raw)) / 10 ** decimals;
const topicAddress = (t) => `0x${String(t).slice(-40)}`;

async function evmLookup(tx, network, { fetch: fetchImpl, rpcUrls }) {
  const url = rpcUrls[network] || NETWORKS[network].rpc;
  if (!url) return { found: null, note: `No public RPC configured for ${NETWORKS[network].name}.` };
  const receipt = await rpc(url, 'eth_getTransactionReceipt', [tx], fetchImpl);
  if (!receipt) return { found: false };
  const usdc = (NETWORKS[network].usdc || '').toLowerCase();
  const transfers = (receipt.logs || [])
    .filter((l) => l.topics && l.topics[0] === TRANSFER_TOPIC && l.topics.length === 3)
    .map((l) => ({ token: l.address.toLowerCase() === usdc ? 'USDC' : l.address, from: topicAddress(l.topics[1]), to: topicAddress(l.topics[2]), amount: l.address.toLowerCase() === usdc ? units(l.data) : undefined }));
  return { found: true, ok: receipt.status === '0x1', block: Number(receipt.blockNumber), transfers };
}

async function solanaLookup(sig, network, { fetch: fetchImpl, rpcUrls }) {
  const url = rpcUrls[network] || (network.endsWith('EtWTRABZaYq6iMfeYKouRu166VU2xqa1') ? 'https://api.devnet.solana.com' : 'https://api.mainnet-beta.solana.com');
  const tx = await rpc(url, 'getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }], fetchImpl);
  if (!tx) return { found: false };
  const mint = NETWORKS[network].usdc;
  const bal = (list) => new Map((list || []).filter((b) => b.mint === mint).map((b) => [b.owner, Number(b.uiTokenAmount && b.uiTokenAmount.amount || 0)]));
  const pre = bal(tx.meta && tx.meta.preTokenBalances), post = bal(tx.meta && tx.meta.postTokenBalances);
  const owners = new Set([...pre.keys(), ...post.keys()]);
  const deltas = [...owners].map((o) => ({ owner: o, delta: ((post.get(o) || 0) - (pre.get(o) || 0)) / 1e6 })).filter((d) => d.delta !== 0);
  const senders = deltas.filter((d) => d.delta < 0), receivers = deltas.filter((d) => d.delta > 0);
  const transfers = receivers.map((r) => ({ token: 'USDC', from: senders.length === 1 ? senders[0].owner : senders.map((s) => s.owner).join(', '), to: r.owner, amount: r.delta }));
  return { found: true, ok: !(tx.meta && tx.meta.err), slot: tx.slot, time: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : undefined, transfers };
}

// The whole check: decode, look the transaction up, and say plainly what matches and what doesn't.
async function checkSettlement(input, { fetch: fetchImpl = globalThis.fetch, rpcUrls = {} } = {}) {
  const s = decodeSettlement(input);
  const checks = [];
  const add = (id, status, message) => checks.push({ id, status, message });
  const net = NETWORKS[s.network];

  if (s.direct) { /* no header: nothing the seller said to check */ }
  else if (s.success === true) add('success', 'pass', 'The seller says the payment settled (success: true).');
  else if (s.success === false) add('success', 'fail', `The seller says the payment did not settle${s.errorReason ? ` (${s.errorReason})` : ''}.`);
  else add('success', 'warn', 'The header has no success field.');

  if (!s.network) add('network', 'fail', 'The header names no network.');
  else if (!net) add('network', 'warn', `Unknown network "${s.network}"; the transaction can't be looked up here.`);
  else add('network', 'pass', `Network: ${net.name}${s.networkAsSent !== s.network ? ` (sent as "${s.networkAsSent}", the x402 v1 name)` : ''}${net.testnet ? ', a testnet' : ''}.`);

  const family = net && net.family;
  const txOk = family === 'evm' ? EVM_TX_RE.test(s.transaction) : family === 'solana' ? SOL_SIG_RE.test(s.transaction) : Boolean(s.transaction);
  if (!s.transaction) add('transaction', 'fail', 'The header has no transaction hash.');
  else if (!txOk) add('transaction', 'fail', `"${s.transaction.slice(0, 80)}" is not a ${family === 'solana' ? 'Solana signature' : 'transaction hash'} for ${net ? net.name : 'this network'}.`);

  if (s.payer) {
    const payerOk = family === 'evm' ? isEvmAddress(s.payer) : family === 'solana' ? isSolanaAddress(s.payer) : true;
    if (!payerOk) add('payer', 'warn', `The payer "${s.payer.slice(0, 60)}" is not a ${net.name} address.`);
  }

  let chain = null;
  if (net && txOk && (family === 'evm' || family === 'solana')) {
    try {
      chain = family === 'evm' ? await evmLookup(s.transaction, s.network, { fetch: fetchImpl, rpcUrls }) : await solanaLookup(s.transaction, s.network, { fetch: fetchImpl, rpcUrls });
    } catch (err) {
      add('onchain', 'warn', `Couldn't reach ${net.name} to look the transaction up (${err.message}). Try again in a minute.`);
    }
    if (chain && chain.found === false) {
      add('onchain', 'fail', `No such transaction on ${net.name}. Check that it isn't on another network: an x402 payment session for Base won't see a transfer made on Solana, and the other way round.`);
    } else if (chain && chain.found) {
      add('onchain', chain.ok ? 'pass' : 'fail', chain.ok ? `The transaction is on ${net.name} and succeeded.` : `The transaction is on ${net.name} but failed (reverted), so nothing was paid.`);
      const usdc = (chain.transfers || []).filter((t) => t.token === 'USDC');
      if (chain.ok && !usdc.length) add('usdc', 'warn', 'No USDC moved in this transaction.');
      if (usdc.length) {
        add('usdc', 'pass', usdc.map((t) => `${t.amount} USDC from ${t.from} to ${t.to}`).join('; '));
        if (s.payer) {
          const fromPayer = usdc.some((t) => String(t.from).toLowerCase().split(', ').includes(s.payer.toLowerCase()));
          add('payer', fromPayer ? 'pass' : 'warn', fromPayer ? 'The USDC came from the payer named in the header.' : 'The USDC did not come from the payer named in the header (a relayer or smart wallet can explain this).');
        }
      }
    }
  }

  const explorer = net && s.transaction && txOk && EXPLORERS[s.network];
  const statuses = checks.map((c) => c.status);
  return {
    overall: statuses.includes('fail') ? 'fail' : statuses.includes('warn') ? 'warn' : 'pass',
    decoded: { success: s.success, transaction: s.transaction, network: s.network, payer: s.payer, ...(s.errorReason ? { errorReason: s.errorReason } : {}), ...(Object.keys(s.extra).length ? { extra: s.extra } : {}) },
    explorer: explorer ? (explorer.includes('{tx}') ? explorer.replace('{tx}', s.transaction) : explorer + s.transaction) : null,
    onchain: chain,
    checks,
  };
}

module.exports = { decodeSettlement, checkSettlement };
