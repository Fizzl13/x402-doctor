// One-off: is the scan video on the Ichimoku homepage?
const O = 'https://ichimoku-signal.onrender.com';
const html = await (await fetch(O, { headers: { accept: 'text/html' } })).text();
console.log('homepage section:', /the market scan in 48 seconds/.test(html) ? 'yes' : 'no');
for (const f of ['scan.mp4', 'scan.jpg']) {
  const r = await fetch(`${O}/media/${f}`, { method: 'HEAD' });
  console.log(`${f}: HTTP ${r.status}, ${r.headers.get('content-type')}, ${r.headers.get('content-length')} bytes`);
}
