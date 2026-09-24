// One-off: Ichimoku in the CDP Bazaar? (one round) + the Doctor's EOA note live.
const hits = [];
let total = 0;
for (let offset = 0; offset < 40000; offset += 500) {
  const res = await fetch(`https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?type=http&limit=500&offset=${offset}`);
  if (!res.ok) { console.log(`CDP HTTP ${res.status}`); break; }
  const items = (await res.json()).items || [];
  total += items.length;
  for (const it of items) if (/ichimoku/i.test(JSON.stringify(it).slice(0, 4000))) hits.push(JSON.stringify(it).slice(0, 700));
  if (items.length < 500) break;
}
console.log(`catalog: ${total} resources, Ichimoku entries: ${hits.length}`);
for (const h of hits) console.log('  ' + h);
const d = await (await fetch('https://x402-doctor.onrender.com/api/diagnose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://ichimoku-signal.onrender.com/signal/BTC-USDT' }) })).json();
const eoa = d.checks.find((c) => c.id === 'evm-payto-eoa');
console.log('doctor EOA note:', eoa ? eoa.message : 'none');
console.log('who can pay:', (d.checks.find((c) => c.id === 'wallets') || {}).message);
