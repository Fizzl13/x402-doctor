// AgentBIT: are the fizzl.eu resources in, is Doctor found for the diagnose task, are the onrender.com entries still there?
const get = async (u) => (await fetch(u, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30000) })).json();
for (const q of ['fizzl.eu', 'x402-doctor', 'presign-guard', 'ichimoku', 'plaintext']) {
  const d = await get(`https://agentbit.app/api/discover?q=${encodeURIComponent(q)}`);
  const ours = (d.items || []).filter((i) => /fizzl\.eu|onrender\.com/.test(i.resource || '') && /x402-doctor|presign-guard|ichimoku-signal|plaintext|smartcontractexplainer/.test(i.resource || ''));
  console.log(`\n== discover "${q}" (total ${d.total})`);
  for (const i of ours) console.log(`  [${i.source}] ${i.resource}`);
}
for (const q of ['diagnose why my x402 endpoint payment flow is broken', 'is this x402 endpoint safe to pay', 'is this transaction safe to sign before my agent signs it']) {
  const r = await get(`https://agentbit.app/api/route?q=${encodeURIComponent(q)}`);
  const all = [r.best, ...(r.alternatives || [])].filter(Boolean);
  console.log(`\n== route "${q}"`);
  all.forEach((x, n) => console.log(`  ${n + 1}. ${x.score} ${x.resource}`));
}
