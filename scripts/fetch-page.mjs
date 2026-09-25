// One-off: the top-200 coins that have a dollar spot pair on Binance.US, Kraken, Gate or MEXC.
const j = async (u) => { try { const r = await fetch(u); return r.ok ? r.json() : {}; } catch { return {}; } };
const top = [];
for (const page of [1, 2]) {
  const rows = await j(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=${page}&price_change_percentage=30d`);
  top.push(...rows.map((r) => ({ rank: r.market_cap_rank, sym: r.symbol.toUpperCase(), name: r.name, price: r.current_price, lo: r.low_24h, hi: r.high_24h, ch30: r.price_change_percentage_30d_in_currency })));
  await new Promise((r) => setTimeout(r, 3000));
}
const DOLLAR = ['USDT', 'USD', 'USDC'];
const sets = {};
const bus = await j('https://api.binance.us/api/v3/exchangeInfo');
sets['binance.us'] = new Set((bus.symbols || []).filter((s) => s.status === 'TRADING').map((s) => `${s.baseAsset}-${s.quoteAsset}`));
const kr = await j('https://api.kraken.com/0/public/AssetPairs');
const al = { XBT: 'BTC', XDG: 'DOGE' };
sets.kraken = new Set(Object.values(kr.result || {}).filter((p) => p.wsname && (!p.status || p.status === 'online')).map((p) => { const [b, q] = p.wsname.split('/'); return `${al[b] || b}-${al[q] || q}`; }));
const gt = await j('https://api.gateio.ws/api/v4/spot/currency_pairs');
sets.gate = new Set((Array.isArray(gt) ? gt : []).filter((p) => p.trade_status === 'tradable').map((p) => `${p.base}-${p.quote}`));
const mx = await j('https://api.mexc.com/api/v3/exchangeInfo');
sets.mexc = new Set((mx.symbols || []).filter((s) => String(s.status) === '1' && s.isSpotTradingAllowed !== false).map((s) => `${s.baseAsset}-${s.quoteAsset}`));
const out = [];
for (const c of top) {
  const src = Object.keys(sets).find((s) => DOLLAR.some((q) => sets[s].has(`${c.sym}-${q}`)));
  if (!src || !/^[A-Z0-9]{2,12}$/.test(c.sym)) continue;
  const stable = c.price > 0.9 && c.price < 1.1 && Math.abs(c.ch30 ?? 0) < 3;
  out.push(`${c.rank}|${c.sym}|${c.name}|${src}|${c.price}|${stable ? 'STABLE?' : ''}`);
}
console.log(`COUNT ${out.length}`);
console.log(out.join('\n'));
