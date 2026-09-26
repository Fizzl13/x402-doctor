// presign-guard GET /v1/approvals after deploy: 402 challenge, 400, OpenAPI, CDP validator. Nothing paid.
const B = 'https://presign-guard.onrender.com';
const R = `${B}/v1/approvals`;
let ch = null;
for (let i = 0; i < 30; i++) {
  const r = await fetch(R, { headers: { accept: 'application/json' } }).catch((e) => ({ status: 0, e }));
  if (r.status === 402) {
    const h = r.headers.get('payment-required');
    ch = JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
    const body = await r.json();
    console.log(`round ${i}: 402`);
    console.log('accepts:', JSON.stringify(ch.accepts.map((a) => [a.network, a.amount, a.payTo])));
    console.log('resource:', JSON.stringify(ch.resource));
    console.log('body has resource:', JSON.stringify(body.resource) === JSON.stringify(ch.resource));
    console.log('bazaar input:', JSON.stringify(ch.extensions?.bazaar?.info?.input));
    break;
  }
  console.log(`round ${i}: HTTP ${r.status} (not deployed yet)`);
  await new Promise((r2) => setTimeout(r2, 30000));
}
if (!ch) process.exit(1);
const bad = await fetch(`${R}?chain=solana&address=x`);
console.log('invalid →', bad.status, JSON.stringify(await bad.json()));
const spec = await (await fetch(`${B}/openapi.json`)).json();
console.log('openapi', spec.info.version, Object.keys(spec.paths).join(' '));
const wk = await (await fetch(`${B}/.well-known/x402`)).json();
console.log('well-known resources:', wk.resources.join(' '));
const v = await fetch('https://api.cdp.coinbase.com/platform/v2/x402/validate', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ resource: `${R}?chain=ethereum&address=0x28c6c06298d514db089934071355e5743bf21d60`, method: 'GET' }),
});
const vj = await v.json().catch(() => null);
console.log('CDP validate HTTP', v.status, 'valid:', vj?.valid, 'simulation:', vj?.simulation?.outcome);
console.log(JSON.stringify(vj).slice(0, 1500));
const v2 = await fetch('https://api.cdp.coinbase.com/platform/v2/x402/validate', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resource: R, method: 'GET' }),
});
const v2j = await v2.json().catch(() => null);
console.log('CDP validate (bare) valid:', v2j?.valid, 'simulation:', v2j?.simulation?.outcome);
// Free GoPlus sample through the same source, to see a real audit shape (no payment).
const g = await (await fetch('https://api.gopluslabs.io/api/v2/token_approval_security/8453?addresses=0x28c6c06298d514db089934071355e5743bf21d60')).json();
console.log('goplus base sample items:', Array.isArray(g.result) ? g.result.length : g.result);
