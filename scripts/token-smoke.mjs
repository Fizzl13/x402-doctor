// Research: what chekka's /.well-known/x402 and paywall HTML look like (data only).
const base = 'https://crypto-sentiment-x402.onrender.com';
const wk = await fetch(`${base}/.well-known/x402`);
console.log('WELL-KNOWN', wk.status, wk.headers.get('content-type'));
console.log((await wk.text()).slice(0, 1200));
const pw = await fetch(`${base}/sentiment/BTC`, { headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (x402-doctor)' } });
const html = await pw.text();
const i = html.indexOf('window.x402');
console.log('PAYWALL', pw.status, html.length, JSON.stringify(html.slice(i, i + 700)));
console.log('testnet mentions', JSON.stringify([...html.matchAll(/.{30}testnet.{30}/g)].slice(0, 5).map((m) => m[0])));
