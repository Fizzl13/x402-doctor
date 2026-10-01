// One-off: presign-guard credit packs live check (after #76). Never pays. Waits for the Render deploy first.
await new Promise((r) => setTimeout(r, 240000));
const B = 'https://presign-guard.fizzl.eu';
const UA = { 'user-agent': 'fizzl-monitor/1.0', accept: 'application/json' };
const root = await (await fetch(B + '/', { headers: UA })).json();
console.log('ROOT credits', JSON.stringify(root.credits));
const info = await fetch(B + '/v1/credits', { headers: UA });
console.log('INFO', info.status, (await info.text()).slice(0, 300));
for (const size of ['100', '1000']) {
  const r = await fetch(`${B}/v1/credits/${size}`, { headers: UA });
  let acc = [];
  try { acc = JSON.parse(Buffer.from(r.headers.get('payment-required'), 'base64').toString()).accepts || []; } catch {}
  console.log('PACK', size, r.status, acc.map((a) => `${String(a.network).split(':')[0]} ${a.amount}`).join(', '));
}
const fake = 'pgc_' + 'A'.repeat(43);
const t = await fetch(`${B}/v1/token?chain=base&address=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, { headers: { ...UA, 'x-credit-key': fake } });
console.log('UNKNOWN KEY', t.status, 'x-credit-status=' + t.headers.get('x-credit-status'));
const bal = await fetch(B + '/v1/credits', { headers: { ...UA, 'x-credit-key': fake } });
console.log('BALANCE unknown', bal.status);
