// One-off: is /signals live on Ichimoku, and what does the Doctor say about it?
import { createRequire } from 'module';
const require = createRequire(import.meta.url + '/../../doctor/');
const { diagnose } = require('./lib/diagnose');
const { createSafeFetch } = require('./lib/safe-fetch');
const url = 'https://ichimoku-signal.onrender.com/signals/BTC-USDT?interval=4h';
for (let i = 0; i < 12; i++) {
  const r = await fetch(url);
  const pr = r.headers.get('payment-required');
  const c = pr ? JSON.parse(Buffer.from(pr, 'base64').toString()) : null;
  console.log(`try ${i}: HTTP ${r.status}`, c ? c.accepts.map((a) => `${a.network}=${a.amount}`).join(' ') : '');
  if (r.status === 402 && c) break;
  await new Promise((res) => setTimeout(res, 60000));
}
const report = await diagnose(url, { safeFetch: createSafeFetch() });
console.log('doctor overall:', report.overall);
for (const c of report.checks.filter((c) => c.status !== 'pass')) console.log(` ${c.status} ${c.id}: ${c.message}`);
