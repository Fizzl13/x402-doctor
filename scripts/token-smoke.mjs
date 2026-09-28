// Research: fresh Doctor report on chekka's endpoint after his paywall fix (data only).
const target = 'https://crypto-sentiment-x402.onrender.com/sentiment/BTC';
await fetch('https://crypto-sentiment-x402.onrender.com/').catch(() => {});
const r = await (await fetch('https://x402-doctor.fizzl.eu/api/diagnose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: target }) })).json();
console.log(`overall ${r.overall} method ${r.method}`);
for (const c of r.checks || []) console.log(`${c.status.padEnd(5)} ${c.group}/${c.id}: ${c.message}`);
