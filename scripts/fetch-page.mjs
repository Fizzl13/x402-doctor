// One-off: which of the top-200 coins (CoinGecko, by market cap) have a spot pair
// on Binance.US, Kraken or Gate, and which extra sources would cover the rest.
const j = async (u) => { try { const r = await fetch(u, { headers: { 'user-agent': 'coverage-check' } }); return r.ok ? r.json() : { __status: r.status }; } catch (e) { return { __err: e.message }; } };
const top = [];
for (const page of [1, 2, 3]) {
  const rows = await j(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=${page}`);
  if (!Array.isArray(rows)) { console.log('coingecko', JSON.stringify(rows)); break; }
  top.push(...rows.map((r) => ({ rank: r.market_cap_rank, sym: r.symbol.toUpperCase(), id: r.id })));
  await new Promise((r) => setTimeout(r, 2500));
}
const DOLLAR = ['USDT', 'USD', 'USDC'];
const sets = {};
const bus = await j('https://api.binance.us/api/v3/exchangeInfo');
sets.binanceus = new Set((bus.symbols || []).filter((s) => s.status === 'TRADING').map((s) => `${s.baseAsset}-${s.quoteAsset}`));
const kr = await j('https://api.kraken.com/0/public/AssetPairs');
const al = { XBT: 'BTC', XDG: 'DOGE' };
sets.kraken = new Set(Object.values(kr.result || {}).filter((p) => p.wsname).map((p) => { const [b, q] = p.wsname.split('/'); return `${al[b] || b}-${al[q] || q}`; }));
const gt = await j('https://api.gateio.ws/api/v4/spot/currency_pairs');
sets.gate = new Set((Array.isArray(gt) ? gt : []).filter((p) => p.trade_status === 'tradable').map((p) => `${p.base}-${p.quote}`));
const kc = await j('https://api.kucoin.com/api/v2/symbols');
sets.kucoin = new Set((kc.data || []).filter((s) => s.enableTrading).map((s) => `${s.baseCurrency}-${s.quoteCurrency}`));
const mx = await j('https://api.mexc.com/api/v3/exchangeInfo');
sets.mexc = new Set((mx.symbols || []).map((s) => `${s.baseAsset}-${s.quoteAsset}`));
const bg = await j('https://api.bitget.com/api/v2/spot/public/symbols');
sets.bitget = new Set((bg.data || []).filter((s) => s.status === 'online').map((s) => `${s.baseCoin}-${s.quoteCoin}`));
const okx = await j('https://www.okx.com/api/v5/public/instruments?instType=SPOT');
sets.okx = new Set((okx.data || []).filter((s) => s.state === 'live').map((s) => `${s.baseCcy}-${s.quoteCcy}`));
const cb = await j('https://api.exchange.coinbase.com/products');
sets.coinbase = new Set((Array.isArray(cb) ? cb : []).filter((s) => s.status === 'online').map((s) => `${s.base_currency}-${s.quote_currency}`));
for (const [k, s] of Object.entries(sets)) console.log(`${k}: ${s.size} pairs`);
const has = (src, sym) => DOLLAR.some((q) => sets[src].has(`${sym}-${q}`));
const current = ['binanceus', 'kraken', 'gate'];
const STABLE = /^(USDT|USDC|DAI|USDE|FDUSD|USDS|PYUSD|TUSD|USD1|RLUSD|USDD|USDTB|USDF|USDG|BUIDL|USYC|USDX|GHO|FRAX|USDO|SUSDE|SUSDS|USD0|EURC|XAUT|PAXG)$/;
for (const n of [100, 200]) {
  const slice = top.slice(0, n);
  const miss = slice.filter((c) => !current.some((s) => has(s, c.sym)));
  console.log(`\nTop ${n}: ${n - miss.length} covered by Binance.US/Kraken/Gate, ${miss.length} missing`);
  for (const c of miss) {
    const extra = ['kucoin', 'mexc', 'bitget', 'okx', 'coinbase'].filter((s) => has(s, c.sym));
    console.log(`  #${c.rank} ${c.sym} (${c.id})${STABLE.test(c.sym) ? ' [stable/fund]' : ''} -> ${extra.join(', ') || 'none'}`);
  }
}
for (const u of ['https://api.kucoin.com/api/v1/market/candles?type=1hour&symbol=BTC-USDT', 'https://api.mexc.com/api/v3/klines?symbol=BTCUSDT&interval=60m&limit=5', 'https://api.bitget.com/api/v2/spot/market/candles?symbol=BTCUSDT&granularity=1h&limit=5', 'https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=1H&limit=5']) {
  const r = await fetch(u).catch((e) => ({ status: e.message }));
  console.log(`candles ${new URL(u).host}: ${r.status}`);
}
