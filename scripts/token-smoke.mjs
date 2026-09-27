// Live: wait until Doctor's paid route serves the new listing text (deploy of #74).
const url = 'https://x402-doctor.onrender.com/api/v1/diagnose?url=https://ichimoku-signal.onrender.com/signal/BTC-USDT';
for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(url);
    const pr = r.headers.get('payment-required');
    const d = pr ? JSON.parse(Buffer.from(pr, 'base64').toString('utf8')).resource?.description : null;
    console.log(new Date().toISOString(), r.status, (d || '').slice(0, 60));
    if (d && d.startsWith('Why is my x402 endpoint broken')) { console.log('NEW TEXT LIVE'); process.exit(0); }
  } catch (e) { console.log('error', e.message); }
  await new Promise((res) => setTimeout(res, 15000));
}
console.log('still old text after 10 min');
process.exit(1);
