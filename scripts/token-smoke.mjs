// Does Ichimoku advertise https in its discovery file and 402 challenge (after today's trust-proxy change)?
const base = 'https://ichimoku-signal.onrender.com';
const wk = await (await fetch(`${base}/.well-known/x402`)).text();
console.log('WELL-KNOWN', wk.slice(0, 1200));
console.log('http:// occurrences', (wk.match(/http:\/\//g) || []).length, 'https:// occurrences', (wk.match(/https:\/\//g) || []).length);
const r = await fetch(`${base}/signal/BTC-USDT`);
const pr = r.headers.get('payment-required');
const ch = pr ? JSON.parse(Buffer.from(pr, 'base64').toString('utf8')) : null;
console.log('402', r.status, 'resource.url =', ch?.resource?.url);
const d = await (await fetch('https://x402-doctor.onrender.com/api/diagnose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: `${base}/signal/BTC-USDT` }) })).json();
console.log('DOCTOR', d.overall, (d.checks || []).filter((c) => c.status !== 'pass' && c.status !== 'info').map((c) => `${c.status} ${c.id}: ${c.message}`).join('\n'));
