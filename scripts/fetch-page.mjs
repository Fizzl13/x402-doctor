// One-off: is the $0.10 confluence price live?
const url = 'https://ichimoku-signal.onrender.com/signals/BTC-USDT?interval=4h';
for (let i = 0; i < 12; i++) {
  const r = await fetch(url);
  const pr = r.headers.get('payment-required');
  const c = pr ? JSON.parse(Buffer.from(pr, 'base64').toString()) : null;
  const amounts = c ? c.accepts.map((a) => a.amount) : [];
  console.log(`try ${i}: HTTP ${r.status} amounts ${amounts.join(',')}`);
  if (amounts.length && amounts.every((a) => a === '100000')) break;
  await new Promise((res) => setTimeout(res, 60000));
}
const spec = await (await fetch('https://ichimoku-signal.onrender.com/openapi.json')).json();
console.log('openapi amount:', spec.paths['/signals/{pair}'].get['x-payment-info'].price.amount);
const home = await (await fetch('https://ichimoku-signal.onrender.com/', { headers: { accept: 'text/html' } })).text();
console.log('homepage:', (home.match(/one call: [^<]+/) || ['?'])[0]);
