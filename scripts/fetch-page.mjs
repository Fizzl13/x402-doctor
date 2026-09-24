// One-off: is /levels live at $0.05?
const url = 'https://ichimoku-signal.onrender.com/levels/BTC-USDT?interval=4h';
for (let i = 0; i < 12; i++) {
  const r = await fetch(url);
  const pr = r.headers.get('payment-required');
  const c = pr ? JSON.parse(Buffer.from(pr, 'base64').toString()) : null;
  const amounts = c ? c.accepts.map((a) => a.amount) : [];
  console.log(`try ${i}: HTTP ${r.status} amounts ${amounts.join(',')}`);
  if (amounts.length && amounts.every((a) => a === '50000')) break;
  await new Promise((res) => setTimeout(res, 60000));
}
const spec = await (await fetch('https://ichimoku-signal.onrender.com/openapi.json')).json();
console.log('openapi amounts:', ['/signal/{pair}', '/signals/{pair}', '/levels/{pair}'].map((p) => `${p}=${spec.paths[p]?.get['x-payment-info'].price.amount}`).join(' '));
const home = await (await fetch('https://ichimoku-signal.onrender.com/', { headers: { accept: 'text/html' } })).text();
console.log('homepage:', (home.match(/Price levels and targets: [^<]+/) || ['?'])[0]);
