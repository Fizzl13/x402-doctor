// Base contract addresses of well-known tokens from CoinGecko (read-only GETs). Output is data only.
const IDS = ['usd-coin', 'weth', 'coinbase-wrapped-btc', 'coinbase-wrapped-staked-eth', 'aerodrome-finance', 'degen-base', 'virtual-protocol', 'brett', 'toshi', 'euro-coin', 'moonwell-artemis', 'morpho', 'zora', 'wrapped-steth', 'dai'];
for (const id of IDS) {
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/coins/${id}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false`, { headers: { accept: 'application/json' } });
    const j = await r.json();
    console.log(`CG ${id} ${r.status} ${j.symbol || ''} base=${(j.platforms || {}).base || '-'} mcap=${j.market_data?.market_cap?.usd ?? '-'}`);
  } catch (e) { console.log(`CG ${id} ERR ${e.message}`); }
  await new Promise((s) => setTimeout(s, 2500));
}
