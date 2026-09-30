// One-off check: paper-trade card and homepage block live (read-only). Output is data only.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(150000);
for (let i = 0; i < 16; i++) {
  try {
    const b = await (await fetch('https://x402-doctor.fizzl.eu/api/stats?x=' + Date.now(), { headers: { origin: 'https://lab.fizzl.eu' } })).json();
    if (b.paper_trade) { console.log('stats paper', JSON.stringify(b.paper_trade.standings), 'trades', b.paper_trade.trades.length); break; }
    console.log('paper not yet');
  } catch (e) { console.log('err', e.message); }
  await sleep(30000);
}
const home = await (await fetch('https://ichimoku-signal.fizzl.eu/?x=' + Date.now(), { headers: { accept: 'text/html' } })).text();
console.log('ichimoku home has track block', home.includes('track-equity'));
const lab = await (await fetch('https://lab.fizzl.eu/?x=' + Date.now())).text();
console.log('lab has paper card', lab.includes('ac-papercard'));
