// One-off check: lab charts live (read-only). Output is data only.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 24; i++) {
  try {
    const res = await fetch('https://x402-doctor.fizzl.eu/api/stats?x=' + Date.now(), { headers: { origin: 'https://lab.fizzl.eu' } });
    const b = await res.json();
    if (b.charts) {
      console.log('stats', res.status, 'cors', res.headers.get('access-control-allow-origin'), 'hourly', b.charts.hourly.length, 'daily', JSON.stringify(b.charts.daily.map((d) => d.doctor + d.presign + d.ichimoku + d.plaintext)), 'outcomes', JSON.stringify(b.charts.outcomes_24h), 'keys', Object.keys(b).join(','));
      break;
    }
    console.log('no charts yet', res.status);
  } catch (e) { console.log('err', e.message); }
  await sleep(30000);
}
for (let i = 0; i < 12; i++) {
  const html = await (await fetch('https://lab.fizzl.eu/?x=' + Date.now())).text();
  const js = await fetch('https://lab.fizzl.eu/lab-charts.js?x=' + Date.now());
  if (html.includes('agents-live') && js.ok) { console.log('lab page live, lab-charts.js', js.status); break; }
  console.log('lab not yet'); await sleep(30000);
}
