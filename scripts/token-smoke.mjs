// Wait until the four services allow fizzl.eu, then run each demo call once, as the page would.
const O = { origin: 'https://fizzl.eu' };
const calls = {
  ichimoku_trend: () => fetch('https://ichimoku-signal.fizzl.eu/api/trend/BTC-USDT', { headers: O }),
  ichimoku_preview: () => fetch('https://ichimoku-signal.fizzl.eu/setups/preview', { headers: O }),
  doctor: () => fetch('https://x402-doctor.fizzl.eu/api/diagnose', { method: 'POST', headers: { ...O, 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://ichimoku-signal.fizzl.eu/signal/BTC-USDT' }) }),
  presign: () => fetch('https://presign-guard.fizzl.eu/v1/token/quick?chain=base&address=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', { headers: O }),
  plaintext: () => fetch('https://plaintext.fizzl.eu/api/demo-explain', { method: 'POST', headers: { ...O, 'content-type': 'application/json' }, body: JSON.stringify({ data: { function: 'permit2', token: 'ETH (wrapped)', spender: 'Uniswap Universal Router', spender_verified: true, approved_amount: '0.5 ETH', duration: 'expires in 30 minutes' } }) }),
};
const done = {};
for (let i = 0; i < 40 && Object.keys(done).length < 5; i++) {
  for (const [k, f] of Object.entries(calls)) {
    if (done[k]) continue;
    // cheap header probe first (the Doctor and PlainText calls do real work)
    const probeUrl = { ichimoku_trend: 'https://ichimoku-signal.fizzl.eu/api/trend/BTC-USDT', ichimoku_preview: 'https://ichimoku-signal.fizzl.eu/setups/preview', doctor: 'https://x402-doctor.fizzl.eu/api/diagnose', presign: 'https://presign-guard.fizzl.eu/v1/token/quick', plaintext: 'https://plaintext.fizzl.eu/api/demo-explain' }[k];
    const pre = await fetch(probeUrl, { method: 'OPTIONS', headers: { ...O, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } }).catch(() => null);
    if (!pre || pre.headers.get('access-control-allow-origin') !== 'https://fizzl.eu') continue;
    const r = await f();
    const body = await r.text();
    done[k] = true;
    console.log(`LIVE ${k} after ${i * 20}s: ${r.status} ACAO=${r.headers.get('access-control-allow-origin')} ${body.slice(0, 220).replace(/\s+/g, ' ')}`);
  }
  if (Object.keys(done).length < 5) await new Promise((r) => setTimeout(r, 20000));
}
console.log('not live:', Object.keys(calls).filter((k) => !done[k]).join(', ') || 'none');
