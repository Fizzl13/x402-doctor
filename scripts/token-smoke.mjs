// Can we get global 24h volume from CoinGecko without a key, and do the 148 top-200 symbols map cleanly?
// Top 500 by market cap (2 calls); first match per symbol = highest market cap. Free, read-only.
const COINS = ["BTC","ETH","BNB","XRP","SOL","TRX","ZEC","HYPE","DOGE","XMR","LINK","WBT","ADA","RAIN","LEO","XLM","BCH","NEAR","UNI","LTC","CC","AVAX","SUI","HBAR","GRAM","SHIB","TAO","CRO","XAUT","ONDO","OKB","BTW","AAVE","ENA","MNT","MORPHO","DOT","ASTER","PEPE","PAXG","PUMP","WLFI","ICP","SKY","WLD","HTX","ETC","VVV","ARB","BGB","QNT","LIT","POL","GT","KAS","ALGO","JUP","KCS","PI","RENDER","ATOM","JST","CAKE","AKE","NEXO","FIL","INJ","DASH","VET","AERO","APT","STABLE","ETHFI","FLR","BDX","PENGU","XDC","TRUMP","STX","RAY","CRV","PYTH","FET","XPL","ZRO","VIRTUAL","TIA","PENDLE","PIEVERSE","DRV","FF","PONS","BSV","SEI","SPX","NIGHT","BTT","UB","LDO","XTZ","SUN","BONK","DCR","OP","GRASS","GNO","BP","LUNC","KITE","MON","AR","ENS","STRK","GRT","CFX","USELESS","BR","FLOKI","STONK","TIBBIR","JTO","APEPE","SYRUP","NFT","TWT","KAG","COMP","WIF","IOTA","ZAMA","THETA","JASMY","EIGEN","KAIA","AI","RUNE","ZBCN","KMNO","AKT","AXS","EDGE","XCN","CVX","2Z","MINA","MET","NEO","FARTCOIN"];
const rows = [];
for (const page of [1, 2]) {
  const r = await fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}`, { headers: { accept: "application/json" } });
  console.log("page", page, "HTTP", r.status, "rate headers:", r.headers.get("x-ratelimit-remaining"), r.headers.get("retry-after"));
  if (!r.ok) { console.log(await r.text().then((t) => t.slice(0, 200))); break; }
  rows.push(...(await r.json()));
}
const bySym = new Map();
for (const c of rows) { const s = c.symbol.toUpperCase(); if (!bySym.has(s)) bySym.set(s, []); bySym.get(s).push(c); }
const missing = COINS.filter((s) => !bySym.has(s));
const dup = COINS.filter((s) => (bySym.get(s) || []).length > 1).map((s) => `${s}: ${bySym.get(s).map((c) => `${c.id}(#${c.market_cap_rank}, vol ${Math.round(c.total_volume / 1e6)}M)`).join(" / ")}`);
console.log("rows", rows.length, "mapped", COINS.length - missing.length, "/", COINS.length);
console.log("missing:", missing.join(", "));
console.log("duplicate symbols:\n  " + dup.join("\n  "));
const ranked = COINS.filter((s) => bySym.has(s)).map((s) => [s, bySym.get(s)[0].total_volume]).sort((a, b) => b[1] - a[1]);
console.log("top 30 by global 24h volume:", ranked.slice(0, 30).map(([s, v]) => `${s} ${Math.round(v / 1e6)}M`).join(", "));
console.log("bottom 10:", ranked.slice(-10).map(([s, v]) => `${s} ${(v / 1e6).toFixed(1)}M`).join(", "));
