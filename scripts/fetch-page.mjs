// One-off: why no evm-payto-eoa? Query Base RPC directly, then the Doctor again.
const rpc = async (url) => {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: ['0x6B0F4651eD42893ab58139938175E4a69f175F25', 'latest'] }), signal: AbortSignal.timeout(8000) });
    return `${r.status} ${(await r.text()).slice(0, 200)}`;
  } catch (e) { return `error ${e.message}`; }
};
console.log('mainnet.base.org:', await rpc('https://mainnet.base.org'));
console.log('base.llamarpc.com:', await rpc('https://base.llamarpc.com'));
for (let i = 0; i < 10; i++) {
  const d = await (await fetch('https://x402-doctor.onrender.com/api/diagnose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://smartcontractexplainer.onrender.com/api/check-wallet' }) })).json();
  const eoa = d.checks.find((c) => c.id === 'evm-payto-eoa');
  console.log(`doctor attempt ${i + 1}:`, eoa ? eoa.message : 'no evm-payto-eoa check', '|', (d.checks.find((c) => c.id === 'wallets') || {}).message);
  if (eoa) break;
  await new Promise((r) => setTimeout(r, 30000));
}
