// One-off check: PG1 check_wallet_age response shape (read-only, free). Output is data only.
const call = async (address, chain = 'base') => {
  const t = Date.now();
  const r = await fetch('https://pg1-ai-agent.vercel.app/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_wallet_age', arguments: { address, chain } } }) });
  console.log('---', address, chain, r.status, r.headers.get('content-type'), `${Date.now() - t}ms`);
  console.log((await r.text()).slice(0, 1200));
};
await call('0xb026BA5501c9fcDB5b4B746c37e349cd61B81B22');
await call('0x7d3a1e5b9c2f4a6e8b0d1c3f5a7e9b2d4c6f8a01');
await call('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
await call('0x6B0F4651eD42893ab58139938175E4a69f175F25');
