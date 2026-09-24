// One-off: MEXC spot format (symbol status values, kline rows, limits).
const info = await (await fetch('https://api.mexc.com/api/v3/exchangeInfo')).json();
const st = {};
for (const s of info.symbols) { const k = `status=${s.status} spot=${s.isSpotTradingAllowed}`; st[k] = (st[k] || 0) + 1; }
console.log(st);
console.log(JSON.stringify(info.symbols.find((s) => s.symbol === 'KCSUSDT')));
console.log(JSON.stringify(info.symbols.find((s) => s.symbol === 'BPUSDT')));
for (const iv of ['60m', '4h', '1d', '1W', '1h', '8h']) {
  const r = await fetch(`https://api.mexc.com/api/v3/klines?symbol=KCSUSDT&interval=${iv}&limit=1000`);
  const t = await r.text();
  let rows; try { rows = JSON.parse(t); } catch { rows = t; }
  console.log(iv, r.status, Array.isArray(rows) ? `${rows.length} rows, first ${JSON.stringify(rows[0])} last ${JSON.stringify(rows[rows.length - 1])}` : String(t).slice(0, 200));
}
