// Which fizzl resources the CDP Bazaar lists (read-only). Output is data only.
const URL0 = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources';
const hits = [];
for (let page = 0; page < 60; page++) {
  const r = await fetch(`${URL0}?type=http&limit=100&offset=${page * 100}`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) { console.log('HTTP', r.status, 'page', page); break; }
  const items = (await r.json()).items || [];
  for (const it of items) if (/fizzl\.eu|fizzl|x402-doctor|presign-guard|ichimoku-signal|smartcontractexplainer/i.test(it.resource)) hits.push(`${it.resource} | updated ${it.lastUpdated || it.updatedAt || '-'}`);
  if (items.length < 100) { console.log('pages', page + 1); break; }
}
for (const h of hits.sort()) console.log('BAZAAR', h);
