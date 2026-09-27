// Live: Doctor's report on Rider x402 after the custom-scheme fix.
const r = await fetch('https://x402-doctor.onrender.com/api/diagnose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://rider-x402.fly.dev/api/x402/cuni/check', method: 'POST' }), signal: AbortSignal.timeout(120000) });
const d = await r.json();
console.log('HTTP', r.status, 'overall', d.overall);
for (const c of d.checks || []) if (c.status !== 'pass') console.log(c.status, c.id, '|', c.message);
