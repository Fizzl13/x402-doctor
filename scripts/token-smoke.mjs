// After the resource fix: does each live 402 body carry the whole v2 challenge (resource included)?
// Retries up to ~15 minutes while Render redeploys (free services also wake up first).
const targets = [
  ['GET', 'https://x402-doctor.onrender.com/api/v1/preflight?url=https%3A%2F%2Fichimoku-signal.onrender.com%2Fsignal%2FBTC-USDT'],
  ['GET', 'https://x402-doctor.onrender.com/api/v1/diagnose?url=https%3A%2F%2Fichimoku-signal.onrender.com%2Fsignal%2FBTC-USDT'],
  ['POST', 'https://presign-guard.onrender.com/v1/check'],
  ['GET', 'https://presign-guard.onrender.com/v1/token'],
  ['GET', 'https://ichimoku-signal.onrender.com/signal/BTC-USDT'],
  ['POST', 'https://smartcontractexplainer.onrender.com/api/check-wallet'],
];
const done = new Map();
for (let round = 0; round < 30 && done.size < targets.length; round++) {
  for (const [method, url] of targets) {
    if (done.has(url)) continue;
    try {
      const res = await fetch(url, { method, headers: { accept: 'application/json', 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined, signal: AbortSignal.timeout(60000) });
      const body = await res.json().catch(() => null);
      const header = res.headers.get('payment-required');
      const h = header ? JSON.parse(Buffer.from(header, 'base64').toString('utf8')) : null;
      const ok = res.status === 402 && body?.resource?.url && JSON.stringify(body.resource) === JSON.stringify(h?.resource);
      console.log(`round ${round} ${method} ${url.slice(0, 70)} → ${res.status} body.resource=${body?.resource?.url ?? 'MISSING'} header.resource=${h?.resource?.url ?? '-'} ${ok ? 'OK' : ''}`);
      if (ok) done.set(url, true);
    } catch (e) { console.log(`round ${round} ${url.slice(0, 70)} → error ${e.message}`); }
  }
  if (done.size < targets.length) await new Promise((r) => setTimeout(r, 30000));
}
console.log(`\n${done.size}/${targets.length} bodies carry resource`);
