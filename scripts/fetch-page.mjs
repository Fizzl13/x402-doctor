// One-off: exact fields of the token data sources (read-only).
const j = async (u) => { const r = await fetch(u, { headers: { accept: 'application/json', 'user-agent': 'fizzl-research' } }); return { status: r.status, body: await r.json().catch(() => null) }; };
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
// a fresh pump.fun token: newest Solana pairs from DexScreener's latest token profiles
const latest = await j('https://api.dexscreener.com/token-profiles/latest/v1');
const fresh = (latest.body || []).find((p) => p.chainId === 'solana')?.tokenAddress;
console.log('fresh solana token:', fresh);
for (const mint of [BONK, fresh].filter(Boolean)) {
  const g = await j(`https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${mint}`);
  const t = g.body?.result?.[mint] || {};
  const { dex, ...rest } = t;
  console.log(`\n=== GoPlus solana ${mint} (${g.status}) keys: ${Object.keys(t).join(', ')}`);
  console.log(JSON.stringify({ ...rest, holders: (rest.holders || []).slice(0, 3), lp_holders: (rest.lp_holders || []).slice(0, 2), dex_count: (dex || []).length }).slice(0, 2500));
  const rc = await j(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`);
  const b = rc.body || {};
  console.log(`\n=== RugCheck report (${rc.status}) keys: ${Object.keys(b).join(', ')}`);
  console.log(JSON.stringify({ mintAuthority: b.mintAuthority, freezeAuthority: b.freezeAuthority, risks: b.risks, score: b.score, score_normalised: b.score_normalised, rugged: b.rugged, totalHolders: b.totalHolders, totalMarketLiquidity: b.totalMarketLiquidity, topHolders: (b.topHolders || []).slice(0, 3), markets0: b.markets?.[0] && { lp: b.markets[0].lp && { lpLockedPct: b.markets[0].lp.lpLockedPct, lpLockedUSD: b.markets[0].lp.lpLockedUSD } }, detectedAt: b.detectedAt, creator: b.creator }).slice(0, 2500));
  const d = await j(`https://api.dexscreener.com/tokens/v1/solana/${mint}`);
  const p = (d.body || [])[0] || {};
  console.log(`\n=== DexScreener (${d.status}) pairs: ${(d.body || []).length}`, JSON.stringify({ liquidity: p.liquidity, fdv: p.fdv, marketCap: p.marketCap, pairCreatedAt: p.pairCreatedAt, volume: p.volume, socials: p.info?.socials?.length, websites: p.info?.websites?.length }));
}
// Base token: DEGEN
const DEGEN = '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed';
const g = await j(`https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${DEGEN}`);
const t = g.body?.result?.[DEGEN.toLowerCase()] || {};
console.log(`\n=== GoPlus base DEGEN keys: ${Object.keys(t).join(', ')}`);
console.log(JSON.stringify({ holder_count: t.holder_count, holders: (t.holders || []).slice(0, 3), lp_holders: (t.lp_holders || []).slice(0, 2), is_in_dex: t.is_in_dex, dex: (t.dex || []).slice(0, 2) }).slice(0, 1500));
const d = await j(`https://api.dexscreener.com/tokens/v1/base/${DEGEN}`);
console.log('\n=== DexScreener base pairs:', (d.body || []).length, JSON.stringify((d.body || [])[0]?.liquidity));
