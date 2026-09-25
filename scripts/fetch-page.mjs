// One-off: demand fields in the CDP catalogue and the Agentic Market API (read-only)
const j = await (await fetch('https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?type=http&limit=2&offset=0')).json();
const it = j.items[0];
console.log('CDP top-level keys:', Object.keys(it), '| other fields:', JSON.stringify(Object.fromEntries(Object.entries(it).filter(([k]) => !['accepts', 'extensions'].includes(k)))).slice(0, 800));
const get = async (u) => { const r = await fetch(u); const t = await r.text(); console.log(`\n===== ${r.status} ${u}\n${t.slice(0, 2500)}`); try { return JSON.parse(t); } catch { return null; } };
const list = await get('https://api.agentic.market/v1/services');
await get('https://api.agentic.market/v1/services/ichimoku-signal-onrender-com');
await get('https://api.agentic.market/v1/services/search?q=trading%20signals');
