const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeSettlement, checkSettlement } = require('../lib/settlement');
const { createApp } = require('../server.js');

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAYER = '0x1111111111111111111111111111111111111111';
const SELLER = '0x2222222222222222222222222222222222222222';
const TX = `0x${'ab'.repeat(32)}`;
const SOL_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_PAYER = '9VaAPD1CzvKqvUwJk7c5bQ8X9Ctk3HBZLqFQ9hnkbGtD';
const SOL_SELLER = 'ATWJ82T8nRdQwZnaysB68N5EpaSvLRsQP4h6eWmaJBH9';
const SOL_SIG = '5'.repeat(88);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const pad = (a) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`;

// A fake RPC: answers eth_getTransactionReceipt and Solana getTransaction from a table.
function rpcStub(table) {
  const calls = [];
  const fetch = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    calls.push({ url, method, params });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: table[params[0]] ?? null }), { headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}
const evmReceipt = ({ status = '0x1', from = PAYER, amount = 10000 } = {}) => ({
  status, blockNumber: '0x10',
  logs: [{ address: USDC_BASE, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', pad(from), pad(SELLER)], data: `0x${amount.toString(16).padStart(64, '0')}` }],
});

test('decode: the bare value, a whole header line, raw JSON and x402 v1 network names', () => {
  const v = b64({ success: true, transaction: TX, network: 'base', payer: PAYER });
  assert.equal(decodeSettlement(v).network, 'eip155:8453');
  assert.equal(decodeSettlement(v).networkAsSent, 'base');
  assert.equal(decodeSettlement(`PAYMENT-RESPONSE: ${v}`).transaction, TX);
  assert.equal(decodeSettlement(`x-payment-response: ${v}`).payer, PAYER);
  assert.equal(decodeSettlement(JSON.stringify({ success: true, transaction: TX, network: 'eip155:8453' })).success, true);
  assert.throws(() => decodeSettlement(''), /Paste/);
  assert.throws(() => decodeSettlement('not-base64-json!!'), /base64-encoded JSON/);
  assert.throws(() => decodeSettlement(b64([1, 2])), /JSON object/);
});

test('Base: a settled payment checks out, with the USDC transfer and an explorer link', async () => {
  const rpc = rpcStub({ [TX]: evmReceipt() });
  const r = await checkSettlement(b64({ success: true, transaction: TX, network: 'eip155:8453', payer: PAYER }), { fetch: rpc.fetch });
  assert.equal(r.overall, 'pass');
  assert.equal(r.explorer, `https://basescan.org/tx/${TX}`);
  assert.deepEqual(r.onchain.transfers[0], { token: 'USDC', from: PAYER, to: SELLER, amount: 0.01 });
  assert.match(r.checks.find((c) => c.id === 'payer').message, /came from the payer/);
  assert.equal(rpc.calls[0].method, 'eth_getTransactionReceipt');
  assert.equal(rpc.calls[0].url, 'https://mainnet.base.org');
});

test('Base: reverted, not found, from someone else, or a broken header each say so', async () => {
  const rpc = rpcStub({ [TX]: evmReceipt({ status: '0x0' }) });
  const reverted = await checkSettlement(b64({ success: true, transaction: TX, network: 'eip155:8453', payer: PAYER }), { fetch: rpc.fetch });
  assert.equal(reverted.overall, 'fail');
  assert.match(reverted.checks.find((c) => c.id === 'onchain').message, /failed/);

  const missing = await checkSettlement(b64({ success: true, transaction: TX, network: 'eip155:8453' }), { fetch: rpcStub({}).fetch });
  assert.equal(missing.overall, 'fail');
  assert.match(missing.checks.find((c) => c.id === 'onchain').message, /No such transaction on Base.*Solana/);

  const relayed = await checkSettlement(b64({ success: true, transaction: TX, network: 'eip155:8453', payer: PAYER }), { fetch: rpcStub({ [TX]: evmReceipt({ from: SELLER }) }).fetch });
  assert.equal(relayed.overall, 'warn');

  const noTx = await checkSettlement(b64({ success: false, errorReason: 'insufficient_funds', network: 'eip155:8453' }), { fetch: rpcStub({}).fetch });
  assert.equal(noTx.overall, 'fail');
  assert.match(noTx.checks.find((c) => c.id === 'success').message, /insufficient_funds/);
  assert.ok(noTx.checks.some((c) => c.id === 'transaction' && c.status === 'fail'));

  const unknown = await checkSettlement(b64({ success: true, transaction: 'abc', network: 'eip155:999' }), { fetch: rpcStub({}).fetch });
  assert.equal(unknown.overall, 'warn');
  assert.equal(unknown.onchain, null);
});

test('Solana: USDC balance changes show who paid whom; an RPC outage is a warning, not a verdict', async () => {
  const tx = {
    slot: 123, blockTime: 1760000000, meta: {
      err: null,
      preTokenBalances: [{ mint: SOL_MINT, owner: SOL_PAYER, uiTokenAmount: { amount: '50000' } }, { mint: SOL_MINT, owner: SOL_SELLER, uiTokenAmount: { amount: '0' } }],
      postTokenBalances: [{ mint: SOL_MINT, owner: SOL_PAYER, uiTokenAmount: { amount: '30000' } }, { mint: SOL_MINT, owner: SOL_SELLER, uiTokenAmount: { amount: '20000' } }],
    },
  };
  const rpc = rpcStub({ [SOL_SIG]: tx });
  const r = await checkSettlement(b64({ success: true, transaction: SOL_SIG, network: 'solana', payer: SOL_PAYER }), { fetch: rpc.fetch, rpcUrls: { 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'https://rpc.example' } });
  assert.equal(r.overall, 'pass');
  assert.deepEqual(r.onchain.transfers, [{ token: 'USDC', from: SOL_PAYER, to: SOL_SELLER, amount: 0.02 }]);
  assert.equal(r.explorer, `https://solscan.io/tx/${SOL_SIG}`);
  assert.equal(rpc.calls[0].url, 'https://rpc.example');

  const down = await checkSettlement(b64({ success: true, transaction: SOL_SIG, network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' }), { fetch: async () => new Response('', { status: 503 }) });
  assert.equal(down.overall, 'warn');
  assert.match(down.checks.find((c) => c.id === 'onchain').message, /Couldn't reach Solana/);
});

test('POST /api/settlement and the /settlement page', async (t) => {
  const rpc = rpcStub({ [TX]: evmReceipt() });
  const app = createApp({ env: {}, settlementFetch: rpc.fetch });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(`${base}/api/settlement`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const ok = await post({ header: b64({ success: true, transaction: TX, network: 'eip155:8453', payer: PAYER }) });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).overall, 'pass');
  assert.equal((await post({})).status, 400);
  const bad = await post({ header: 'nonsense' });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /base64-encoded JSON/);
  const page = await fetch(`${base}/settlement`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /payment proof check/i);
});
