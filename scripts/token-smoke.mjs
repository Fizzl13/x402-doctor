// One-off check: lab extension live (read-only). Output is data only.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(120000);
const c = await fetch('https://ichimoku-signal.fizzl.eu/api/chart/BTC-USDT').then(async (r) => [r.status, await r.json()]).catch((e) => [0, { error: e.message }]);
console.log('chart', c[0], c[1].error || '', c[1].candles ? `candles ${c[1].candles.length} last ${JSON.stringify(c[1].candles.at(-1))} span ${c[1].span_a.length} latest ${JSON.stringify(c[1].latest)}` : '');
for (let i = 0; i < 20; i++) {
  try {
    const b = await (await fetch('https://x402-doctor.fizzl.eu/api/stats?x=' + Date.now(), { headers: { origin: 'https://lab.fizzl.eu' } })).json();
    if (b.charts && b.charts.heat_168) {
      console.log('stats all_time', JSON.stringify(b.all_time), 'routes', JSON.stringify((b.charts.routes_7d || []).slice(0, 3)), 'btc_chart', b.btc_chart ? b.btc_chart.candles.length + ' candles, ' + b.btc_chart.latest.signal : 'null', 'heat', b.charts.heat_168.calls.length);
      if (b.btc_chart && b.all_time) break;
    } else console.log('stats not yet');
  } catch (e) { console.log('err', e.message); }
  await sleep(30000);
}
const html = await (await fetch('https://lab.fizzl.eu/?x=' + Date.now())).text();
console.log('lab has ichimoku card', html.includes('ac-ichicard'), 'heat', html.includes('data-chart="heat"'));
