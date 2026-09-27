// Live: which facilitator Doctor's paid API uses, and its unpaid 402 for /api/v1/diagnose.
const h = await (await fetch('https://x402-doctor.onrender.com/api/health')).json();
console.log('health', JSON.stringify(h).slice(0, 1500));
const r = await fetch('https://x402-doctor.onrender.com/api/v1/diagnose?url=https://ichimoku-signal.onrender.com/signal/BTC-USDT');
console.log('402?', r.status);
const pr = r.headers.get('payment-required');
if (pr) console.log(Buffer.from(pr, 'base64').toString('utf8').slice(0, 2500));
