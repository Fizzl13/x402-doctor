// Research: what agents pay for most (x402scan seller stats). Output is data only.
async function trpc(path, input) {
  const url = `https://www.x402scan.com/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 research' } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text).result.data.json;
}
for (const timeframe of [30, 7]) {
  for (const sortId of ['total_amount', 'unique_buyers', 'tx_count']) {
    try {
      const data = await trpc('public.sellers.bazaar.list', { pagination: { page: 0, page_size: 40 }, timeframe, sorting: { id: sortId, desc: true } });
      console.log(`\n## ${timeframe}d by ${sortId} (total sellers ${data.total_count ?? '?'})`);
      if (timeframe === 30 && sortId === 'total_amount') console.log('RAW', JSON.stringify(data.items?.[0]).slice(0, 700));
      for (const [i, it] of (data.items || []).entries()) {
        const o = it.origins?.[0] || {};
        const amt = Number(it.total_amount);
        const usd = amt > 1e5 ? amt / 1e6 : amt;
        console.log(`${i + 1}. ${o.origin || it.recipients?.[0]} | tx ${it.tx_count} | $${usd.toFixed(2)} | buyers ${it.unique_buyers} | avg $${(usd / Math.max(1, it.tx_count)).toFixed(4)} | ${String(o.title || '').slice(0, 50)} | ${String(o.description || '').replace(/\s+/g, ' ').slice(0, 110)}`);
      }
    } catch (e) { console.log(`${timeframe} ${sortId}: ${e.message}`); }
  }
}
try { console.log('\nSTATS30', JSON.stringify(await trpc('public.stats.overall', { timeframe: 30 })).slice(0, 800)); } catch (e) { console.log('stats', e.message); }
try { console.log('STATS7', JSON.stringify(await trpc('public.stats.overall', { timeframe: 7 })).slice(0, 800)); } catch (e) { console.log('stats', e.message); }
