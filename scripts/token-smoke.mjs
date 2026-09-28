// Research: fizzl.eu services in AgentBIT (discover and route). Output is data only.
const urls = [
  'https://agentbit.app/api/discover?q=fizzl.eu',
  'https://agentbit.app/api/discover?q=x402-doctor',
  'https://agentbit.app/api/discover?q=onrender.com%20fizzl',
  `https://agentbit.app/api/route?q=${encodeURIComponent('diagnose why my x402 endpoint payment flow is broken')}`,
];
for (const u of urls) {
  try {
    const res = await fetch(u, { headers: { accept: 'application/json' } });
    const t = await res.text();
    console.log(`\n## ${u} -> ${res.status}`);
    let j; try { j = JSON.parse(t); } catch { console.log(t.slice(0, 800)); continue; }
    const list = j.results || j.resources || j.items || j.services || j.candidates || j.routes || (Array.isArray(j) ? j : null);
    if (list) {
      console.log(`count ${list.length}${j.total !== undefined ? ` total ${j.total}` : ''}`);
      for (const r of list.slice(0, 15)) console.log(`- ${r.url || r.resource || r.endpoint || r.name} | ${r.name || r.title || ''} | ${r.score ?? r.rank ?? ''} | ${(r.description || '').slice(0, 80)}`);
    } else console.log(t.slice(0, 1500));
  } catch (e) { console.log(`${u}: ${e.message}`); }
}
