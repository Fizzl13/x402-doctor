// XRP-USDT candles on Binance.US around 29 Sep 12:00-14:00 UTC (read-only). Output is data only.
for (const [iv, limit] of [['4h', 3], ['15m', 12]]) {
  const r = await fetch(`https://api.binance.us/api/v3/klines?symbol=XRPUSDT&interval=${iv}&limit=${limit}`);
  const rows = await r.json();
  for (const k of rows) console.log(`K ${iv} ${new Date(k[0]).toISOString()} o=${k[1]} h=${k[2]} l=${k[3]} c=${k[4]}`);
}
const t = await fetch('https://ichimoku-signal.fizzl.eu/track-record.json');
const j = await t.json();
console.log('TR', t.status, JSON.stringify({ trades: j.trades.length, hidden: j.standings.hidden, days: j.days.map((d) => ({ date: d.date, revealed: d.revealed, salt: d.salt ?? null, picks: d.picks ?? null, commitment: d.commitment })) }));
const p = await fetch('https://ichimoku-signal.fizzl.eu/track-record');
console.log('PAGE', p.status, (await p.text()).length);
