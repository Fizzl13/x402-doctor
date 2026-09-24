// One-off: how many of the top-100 coins (CoinGecko market cap, no stablecoins) can each exchange chart
// as <COIN>-USDT or <COIN>-USD, with public klines and no API key? Run from a US GitHub runner, like Render.
const j = async (url) => { const r = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { 'user-agent': 'research' } }); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); };
const STABLE = new Set(['usdt','usdc','dai','usde','fdusd','tusd','usdd','pyusd','usds','usd1','usdtb','susde','bsc-usd','rlusd','usdf','usdx','gho','frax','lusd','buidl','usdy','usd0','eurc','xaut','paxg','susds','syrupusdc','bfusd','usdg']);
const cg = await j('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1');
const coins = cg.filter((c) => !STABLE.has(c.symbol.toLowerCase()) && !/usd|wrapped|staked|bridged/i.test(c.name) && !/^(w|st|we|cb|js|r|m)eth$|^wbtc$|^cbbtc$|^lbtc$|^solvbtc$|^weeth$|^wsteth$|^reth$|^steth$|^meth$|^ezeth$|^rseth$|^bnsol$|^jitosol$|^msol$/i.test(c.symbol)).slice(0, 100).map((c) => ({ sym: c.symbol.toUpperCase(), name: c.name, rank: c.market_cap_rank }));
console.log('top100 (no stables/wrapped):', coins.map((c) => c.sym).join(' '));
const ex = {};
async function load(name, fn) { try { ex[name] = await fn(); console.log(`${name}: ${ex[name].size} usable bases`); } catch (e) { console.log(`${name}: FAILED ${e.message}`); ex[name] = new Set(); } }
await load('binance.us', async () => new Set((await j('https://api.binance.us/api/v3/exchangeInfo')).symbols.filter((s) => s.status === 'TRADING' && ['USDT', 'USD', 'USDC'].includes(s.quoteAsset)).map((s) => s.baseAsset)));
await load('binance.com', async () => new Set((await j('https://api.binance.com/api/v3/exchangeInfo')).symbols.filter((s) => s.status === 'TRADING' && s.quoteAsset === 'USDT').map((s) => s.baseAsset)));
await load('okx', async () => new Set((await j('https://www.okx.com/api/v5/public/instruments?instType=SPOT')).data.filter((s) => s.state === 'live' && s.quoteCcy === 'USDT').map((s) => s.baseCcy)));
await load('bybit', async () => new Set((await j('https://api.bybit.com/v5/market/instruments-info?category=spot&limit=1000')).result.list.filter((s) => s.status === 'Trading' && s.quoteCoin === 'USDT').map((s) => s.baseCoin)));
await load('kraken', async () => { const r = await j('https://api.kraken.com/0/public/AssetPairs'); return new Set(Object.values(r.result).filter((p) => /USD$|USDT$/.test(p.wsname || '')).map((p) => (p.wsname || '').split('/')[0].replace(/^XBT$/, 'BTC').replace(/^XDG$/, 'DOGE'))); });
await load('coinbase', async () => new Set((await j('https://api.exchange.coinbase.com/products')).filter((p) => p.status === 'online' && ['USD', 'USDT', 'USDC'].includes(p.quote_currency) && !p.trading_disabled).map((p) => p.base_currency)));
await load('gate', async () => new Set((await j('https://api.gateio.ws/api/v4/spot/currency_pairs')).filter((p) => p.trade_status === 'tradable' && p.quote === 'USDT').map((p) => p.base)));
await load('mexc', async () => new Set((await j('https://api.mexc.com/api/v3/exchangeInfo')).symbols.filter((s) => s.quoteAsset === 'USDT' && (s.status === '1' || s.status === 'ENABLED' || s.isSpotTradingAllowed)).map((s) => s.baseAsset)));
// A klines probe per exchange (US runner reachability), for BTC.
const probes = {
  'binance.us': 'https://api.binance.us/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=2',
  'binance.com': 'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=2',
  okx: 'https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=1H&limit=2',
  bybit: 'https://api.bybit.com/v5/market/kline?category=spot&symbol=BTCUSDT&interval=60&limit=2',
  kraken: 'https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=60',
  coinbase: 'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600',
  gate: 'https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=BTC_USDT&interval=1h&limit=2',
  mexc: 'https://api.mexc.com/api/v3/klines?symbol=BTCUSDT&interval=60m&limit=2',
};
for (const [n, u] of Object.entries(probes)) { try { const r = await fetch(u, { signal: AbortSignal.timeout(20000) }); console.log(`klines ${n}: HTTP ${r.status}`); } catch (e) { console.log(`klines ${n}: ${e.message}`); } }
const has = (n, s) => ex[n].has(s);
for (const n of Object.keys(ex)) console.log(`coverage ${n}: ${coins.filter((c) => has(n, c.sym)).length}/100`);
const missUS = coins.filter((c) => !has('binance.us', c.sym));
console.log(`missing on binance.us (${missUS.length}):`, missUS.map((c) => `${c.rank}:${c.sym}`).join(' '));
for (const extra of ['okx', 'bybit', 'gate', 'mexc', 'kraken', 'coinbase']) {
  const cov = coins.filter((c) => has('binance.us', c.sym) || has(extra, c.sym)).length;
  console.log(`binance.us + ${extra}: ${cov}/100; still missing: ${coins.filter((c) => !has('binance.us', c.sym) && !has(extra, c.sym)).map((c) => c.sym).join(' ')}`);
}
