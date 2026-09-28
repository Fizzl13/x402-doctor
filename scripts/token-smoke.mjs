// Existing Smithery / Glama listings for our servers?
for (const q of ['frits-zwager', 'fizzl', 'x402-doctor', 'presign-guard', 'ichimoku', 'plaintext fizzl']) {
  const r = await fetch(`https://registry.smithery.ai/servers?q=${encodeURIComponent(q)}&pageSize=10`, { headers: { accept: 'application/json' } });
  const t = await r.text();
  let rows = t.slice(0, 300);
  try { rows = JSON.parse(t).servers.map((s) => `${s.qualifiedName} | ${s.displayName} | remote:${s.remote}`).join('\n'); } catch {}
  console.log('== smithery', q, r.status); console.log(rows);
}
for (const q of ['fizzl13', 'x402-doctor', 'presign-guard', 'ichimoku-signal', 'SmartContractExplainer']) {
  const r = await fetch(`https://glama.ai/api/mcp/v1/servers?query=${encodeURIComponent(q)}&first=10`, { headers: { accept: 'application/json' } });
  const t = await r.text();
  let rows = t.slice(0, 300);
  try { rows = JSON.parse(t).servers.map((s) => `${s.namespace}/${s.slug} | ${s.name} | ${s.url} | ${s.repository?.url || ''}`).join('\n'); } catch {}
  console.log('== glama', q, r.status); console.log(rows);
}
