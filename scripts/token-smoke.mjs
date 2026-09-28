// Research: re-run the free x402 Doctor web check on chekka's sentiment endpoint
// (asked in the x402 Discord), and see the new domain-move checks live. Output is data only.
const target = 'https://crypto-sentiment-x402.onrender.com/sentiment/BTC';
await fetch('https://crypto-sentiment-x402.onrender.com/').catch(() => {}); // wake it
for (let attempt = 0; attempt < 2; attempt++) {
  const res = await fetch('https://x402-doctor.fizzl.eu/api/diagnose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: target }) });
  const r = await res.json();
  console.log(`HTTP ${res.status} overall ${r.overall} method ${r.method}`);
  for (const c of r.checks || []) console.log(`${c.status.padEnd(5)} ${c.group}/${c.id}: ${c.message}${c.hint ? `  [hint: ${c.hint}]` : ''}`);
  if (r.checks?.some((c) => c.id === 'bazaar-listing')) break;
  await new Promise((s) => setTimeout(s, 20000)); // Bazaar index may still be loading after the deploy
}
const oa = await fetch('https://crypto-sentiment-x402.onrender.com/openapi.json');
console.log('openapi', oa.status, (await oa.text()).slice(0, 800));
