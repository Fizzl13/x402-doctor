// One-off: Ichimoku on CDP for Base? 402 still fine? Doctor shows the EOA note?
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = false;
for (let i = 0; i < 14; i++) {
  try {
    const s = await (await fetch('https://ichimoku-signal.onrender.com/', { headers: { accept: 'application/json' } })).json();
    console.log(`attempt ${i + 1}: facilitators ${JSON.stringify(s.payment && s.payment.facilitators)}`);
    if (s.payment && s.payment.facilitators && s.payment.facilitators['eip155:8453'] === 'cdp') { ok = true; break; }
  } catch (e) { console.log(`attempt ${i + 1}: ${e.message}`); }
  await wait(30000);
}
const r = await fetch('https://ichimoku-signal.onrender.com/signal/BTC-USDT?interval=4h', { headers: { accept: 'application/json' } });
const ch = r.headers.get('payment-required');
console.log('402:', r.status, ch ? JSON.stringify(JSON.parse(Buffer.from(ch, 'base64').toString()).accepts.map((a) => ({ network: a.network, amount: a.amount, payTo: a.payTo, feePayer: a.extra && a.extra.feePayer }))) : 'no header');
const d = await (await fetch('https://x402-doctor.onrender.com/api/diagnose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://ichimoku-signal.onrender.com/signal/BTC-USDT' }) })).json();
console.log('doctor overall:', d.overall);
for (const c of d.checks) if (c.status !== 'pass') console.log(`  ${c.status} ${c.id}: ${c.message}`);
process.exit(ok && r.status === 402 ? 0 : 1);
