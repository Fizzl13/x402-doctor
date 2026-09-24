// One-off: is Ichimoku in the CDP Bazaar? Look for its origin in the catalog.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (let round = 0; round < 6; round++) {
  const hits = [];
  let total = 0;
  for (let offset = 0; offset < 40000; offset += 500) {
    const res = await fetch(`https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?type=http&limit=500&offset=${offset}`);
    if (!res.ok) { console.log(`CDP HTTP ${res.status}`); break; }
    const items = (await res.json()).items || [];
    total += items.length;
    for (const it of items) if (/ichimoku-signal\.onrender\.com/.test(it.resource || '')) hits.push(`${it.resource} (updated ${it.lastUpdated || '?'})`);
    if (items.length < 500) break;
  }
  console.log(`round ${round + 1}: ${total} resources in the catalog, Ichimoku entries: ${hits.length}`);
  for (const h of hits) console.log('  ' + h);
  if (hits.length) process.exit(0);
  await wait(60000);
}
process.exit(1);
