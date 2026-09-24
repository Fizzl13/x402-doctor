// One-off: presign-guard in the CDP Bazaar after the first mainnet payment? Retries for ~10 minutes.
for (let round = 0; round < 10; round++) {
  const hits = [];
  let total = 0;
  for (let offset = 0; offset < 40000; offset += 500) {
    const res = await fetch(`https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?type=http&limit=500&offset=${offset}`);
    if (!res.ok) { console.log(`CDP HTTP ${res.status}`); break; }
    const items = (await res.json()).items || [];
    total += items.length;
    for (const it of items) if (/presign-guard/i.test(JSON.stringify(it).slice(0, 4000))) hits.push(JSON.stringify(it).slice(0, 700));
    if (items.length < 500) break;
  }
  console.log(`round ${round}: catalog ${total} resources, presign-guard entries: ${hits.length}`);
  for (const h of hits) console.log('  ' + h);
  if (hits.length) break;
  await new Promise((r) => setTimeout(r, 60000));
}
