// Live: what AgentBIT has stored for presign-guard /v1/check, and the full ranking for "safe to sign".
const d = await (await fetch('https://agentbit.app/api/discover?q=' + encodeURIComponent('presign-guard'))).json();
for (const i of d.items || []) console.log('STORED', i.resource, '::', i.description);
for (const q of ['is this transaction safe to sign before my agent signs it', 'is this transaction safe to sign', 'check a transaction before signing']) {
  const r = await (await fetch('https://agentbit.app/api/route?q=' + encodeURIComponent(q))).json();
  const all = [r.best, ...(r.alternatives || [])].filter(Boolean);
  console.log(`\n== ${q} (considered ${r.total_considered})`);
  all.forEach((x, n) => console.log(`${n + 1}. ${x.score} ${x.resource} (${x.why})`));
}
