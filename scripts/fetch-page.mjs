// One-off: GoPlus token_security on Base for USDC and DEGEN (field names and values).
const tokens = { USDC: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', DEGEN: '0x4ed4e862860bed51a9570b96d89af5e1b0efefed' };
for (const [name, addr] of Object.entries(tokens)) {
  const r = await fetch(`https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${addr}`);
  const body = await r.json();
  console.log(`\n### ${name} HTTP ${r.status} code=${body.code} message=${body.message}`);
  const t = body.result && (body.result[addr] || body.result);
  if (!t) { console.log(JSON.stringify(body).slice(0, 500)); continue; }
  const skip = new Set(['holders', 'lp_holders', 'dex']);
  for (const [k, v] of Object.entries(t)) if (!skip.has(k)) console.log(`  ${k}: ${JSON.stringify(v).slice(0, 120)}`);
  console.log(`  holders[0]: ${JSON.stringify((t.holders || [])[0] || null).slice(0, 200)}`);
  console.log(`  dex[0]: ${JSON.stringify((t.dex || [])[0] || null).slice(0, 200)}`);
}
