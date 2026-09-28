// Research: scvd.store menu, stats and a free preflight of one of our doors (read-only, data only).
const get = async (u) => { const r = await fetch(u, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 research' } }); return [r.status, await r.text()]; };
let [s, t] = await get('https://scvd.store/menu.json?view=compact');
console.log('MENU', s);
try {
  const j = JSON.parse(t);
  const rows = j.items || j.rows || j.menu || j.data || (Array.isArray(j) ? j : []);
  console.log('keys', Object.keys(j).join(','), 'rows', rows.length);
  for (const r of rows) console.log(`- ${r.price ?? r.price_usd ?? r.amount} | ${r.name || r.title || r.id} | ${String(r.summary || r.description || r.what || '').replace(/\s+/g, ' ').slice(0, 150)}`);
  if (!rows.length) console.log(t.slice(0, 4000));
} catch { console.log(t.slice(0, 4000)); }
[s, t] = await get('https://scvd.store/stats');
console.log('\nSTATS', s, t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 2500));
[s, t] = await get('https://scvd.store/api/preflight/v1?url=' + encodeURIComponent('https://x402-doctor.fizzl.eu/api/v1/diagnose?url=https://example.com'));
console.log('\nPREFLIGHT', s, t.slice(0, 3000));
