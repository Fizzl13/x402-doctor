// One-off: x402 Doctor diagnosis of a public endpoint (free route).
const target = 'https://pay.edge-agents.ai/v1/services/usdc-supply-pulse';
const r = await fetch('https://x402-doctor.onrender.com/diagnose?url=' + encodeURIComponent(target), { headers: { accept: 'application/json' } });
console.log('HTTP', r.status);
console.log(JSON.stringify(await r.json(), null, 2));
const raw = await fetch(target);
console.log('\nRAW', raw.status, [...raw.headers].filter(([k]) => /payment|content-type/i.test(k)));
console.log((await raw.text()).slice(0, 1500));
