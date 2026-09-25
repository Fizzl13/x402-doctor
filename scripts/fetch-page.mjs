// One-off research: ax1.vc's token verdict (free 402 + Bazaar example), and Solana token data sources. Read-only, pays nothing.
const cut = (v, n = 2500) => (typeof v === 'string' ? v : JSON.stringify(v, null, 1)).slice(0, n);
const show = (l, v, n) => console.log(`\n===== ${l}\n${cut(v, n)}`);
// 1. ax1.vc: the 402 and its Bazaar metadata
const cat = await (await fetch('https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?type=http&limit=500&offset=0')).json();
let item;
for (let p = 0; p < 40 && !item; p++) {
  const j = p === 0 ? cat : await (await fetch(`https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?type=http&limit=500&offset=${p * 500}`)).json();
  item = (j.items || []).find((i) => i.resource.includes('ax1.vc/api/dashboard/q-verdict'));
  if ((j.items || []).length < 500) break;
}
show('ax1 catalogue entry (description, accepts, bazaar)', { description: item?.description, accepts: item?.accepts, quality: item?.quality, bazaar: item?.extensions?.bazaar }, 6000);
const r = await fetch('https://www.ax1.vc/api/dashboard/q-verdict/resource', { method: 'GET' });
show(`ax1 GET status ${r.status}`, (await r.text()), 1500);
// 2. Solana token data sources, BONK
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const tryJson = async (label, url) => { try { const x = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'fizzl-research' } }); show(`${label} ${x.status}`, await x.text(), 1800); } catch (e) { show(label, e.message); } };
await tryJson('GoPlus solana token_security', `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${BONK}`);
await tryJson('RugCheck summary', `https://api.rugcheck.xyz/v1/tokens/${BONK}/report/summary`);
await tryJson('DexScreener tokens', `https://api.dexscreener.com/tokens/v1/solana/${BONK}`);
