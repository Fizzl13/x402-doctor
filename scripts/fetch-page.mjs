// One-off: are "Who can pay" (x402 Doctor) and the Ichimoku homepage + video live?
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
for (let i = 0; i < 12; i++) {
  try {
    const r = await fetch('https://x402-doctor.onrender.com/api/diagnose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://ichimoku-signal.onrender.com/signal/BTC-USDT' }) });
    const d = await r.json();
    if (Array.isArray(d.wallets)) {
      console.log('DOCTOR who-can-pay LIVE:', (d.checks.find((c) => c.id === 'wallets') || {}).message);
      break;
    }
    console.log(`doctor attempt ${i + 1}: old version`);
  } catch (e) { console.log(`doctor attempt ${i + 1}: ${e.message}`); }
  await wait(30000);
}
for (let i = 0; i < 12; i++) {
  const html = await (await fetch('https://ichimoku-signal.onrender.com/', { headers: { accept: 'text/html' } })).text();
  if (html.includes('/media/explainer.mp4')) {
    console.log('ICHIMOKU homepage + video section LIVE');
    const v = await fetch('https://ichimoku-signal.onrender.com/media/explainer.mp4', { headers: { range: 'bytes=0-1023' } });
    console.log('video:', v.status, v.headers.get('content-type'));
    const t = await fetch('https://ichimoku-signal.onrender.com/api/trend/BTC-USDT');
    console.log('trend:', t.status, JSON.stringify(await t.json()));
    const j = await (await fetch('https://ichimoku-signal.onrender.com/', { headers: { accept: '*/*' } })).json();
    console.log('status JSON for agents:', j.status, j.trend);
    if (v.status !== 206 || t.status !== 200) ok = false;
    break;
  }
  console.log(`ichimoku attempt ${i + 1}: ${html.startsWith('{') ? 'JSON only (old)' : 'homepage without video yet'}`);
  await wait(30000);
}
process.exit(ok ? 0 : 1);
