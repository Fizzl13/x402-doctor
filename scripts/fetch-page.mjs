// One-off: which x402-doctor routes are in the CDP Bazaar?
const hits = [];
let total = 0;
for (let offset = 0; offset < 40000; offset += 500) {
  const res = await fetch(`https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?type=http&limit=500&offset=${offset}`);
  if (!res.ok) { console.log(`CDP HTTP ${res.status}`); break; }
  const items = (await res.json()).items || [];
  total += items.length;
  for (const it of items) if (String(it.resource || '').includes('x402-doctor.onrender.com')) hits.push(`${it.resource}  lastUpdated=${it.lastUpdated}`);
  if (items.length < 500) break;
}
console.log(`catalog ${total}, doctor entries: ${hits.length}`);
for (const h of hits) console.log('  ' + h);
