// One-off: make a few free calls to the services so the usage log gets test entries.
const calls = [
  ['Doctor dashboard (expect 401)', 'https://x402-doctor.onrender.com/admin/usage', {}],
  ['Ichimoku free trend', 'https://ichimoku-signal.onrender.com/api/trend/BTC-USDT', {}],
  ['Doctor free diagnose', 'https://x402-doctor.onrender.com/api/diagnose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://presign-guard.onrender.com/v1/check', method: 'POST' }) }],
  ['PlainText demo explain', 'https://smartcontractexplainer.onrender.com/api/demo-explain', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: { function: 'permit2', token: 'ETH (wrapped)', spender: 'Uniswap Universal Router', spender_verified: true, approved_amount: '0.5 ETH', duration: 'expires in 30 minutes' } }) }],
  ['presign-guard health', 'https://presign-guard.onrender.com/health', {}],
];
for (const [label, url, init] of calls) {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(90000) });
    console.log(`${label}: ${r.status} ${(await r.text()).slice(0, 160).replace(/\s+/g, ' ')}`);
  } catch (e) { console.log(`${label}: ${e.message}`); }
}
