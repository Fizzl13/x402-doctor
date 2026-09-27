// Live: Doctor on three Rider x402 endpoints, plus one raw 402 (headers + body).
const base = 'https://rider-x402.fly.dev';
const raw = await fetch(`${base}/api/x402/cuni/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
console.log('RAW', raw.status, JSON.stringify(Object.fromEntries(raw.headers)).slice(0, 1500));
console.log((await raw.text()).slice(0, 2500));
const pr = raw.headers.get('payment-required');
if (pr) { try { console.log('PAYMENT-REQUIRED decoded', Buffer.from(pr, 'base64').toString('utf8').slice(0, 2000)); } catch {} }
for (const p of ['/api/x402/ping/ping', '/api/x402/cuni/check', '/api/x402/pcc/compress']) {
  for (const method of ['POST', undefined]) {
    const r = await fetch('https://x402-doctor.onrender.com/api/diagnose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: base + p, ...(method ? { method } : {}) }), signal: AbortSignal.timeout(120000) });
    const d = await r.json().catch(() => ({}));
    console.log(`\n## Doctor ${p} ${method || 'auto'}: HTTP ${r.status} overall ${d.overall}`);
    for (const c of d.checks || []) console.log(c.status, c.id, '|', c.message);
    await new Promise((res) => setTimeout(res, 1500));
    if (p !== '/api/x402/cuni/check') break;
  }
}
