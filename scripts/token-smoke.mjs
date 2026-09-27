// Live: does AgentBIT's free FIND (https://agentbit.app/api/route) pick our services?
const OURS = /x402-doctor|presign-guard|ichimoku-signal|plaintext|smartcontract/i;
const tasks = [
  'diagnose why my x402 endpoint payment flow is broken',
  'check an x402 payment endpoint for problems',
  'is this transaction safe to sign before my agent signs it',
  'check a token approval or EIP-712 signature for scams',
  'is this token safe to buy, token risk verdict',
  'crypto trade setups with entry stop and target',
  'ichimoku signal for BTC',
  'explain a smart contract transaction in plain language',
];
const show = (t) => t.replace(/\s+/g, ' ').slice(0, 1200);
async function call(task) {
  const tries = [
    () => fetch(`https://agentbit.app/api/route?task=${encodeURIComponent(task)}`, { headers: { accept: 'application/json' } }),
    () => fetch('https://agentbit.app/api/route', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ task }) }),
  ];
  for (const [i, t] of tries.entries()) {
    try {
      const r = await t();
      const text = await r.text();
      if (r.ok) return { how: i ? 'POST' : 'GET', status: r.status, text };
      console.log(`  ${i ? 'POST' : 'GET'} HTTP ${r.status}: ${show(text).slice(0, 300)}`);
    } catch (e) { console.log(`  error ${e.message}`); }
  }
  return null;
}
for (const task of tasks) {
  console.log(`\n== ${task}`);
  const r = await call(task);
  if (!r) continue;
  const hit = r.text.match(new RegExp(`[^"]*(${OURS.source})[^"]*`, 'gi'));
  console.log(`  ${r.how} ${r.status} ours: ${hit ? [...new Set(hit)].slice(0, 5).join(' | ') : 'NO'}`);
  console.log(`  ${show(r.text)}`);
  await new Promise((res) => setTimeout(res, 1000));
}
for (const u of ['https://agentbit.app/llms-full.txt']) {
  try { const t = await (await fetch(u)).text(); console.log(`\n== ${u} (${t.length} chars) mentions ours: ${OURS.test(t)}\n${t.slice(0, 2500)}`); } catch (e) { console.log(u, e.message); }
}
