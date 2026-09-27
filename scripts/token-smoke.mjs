// Live: what Doctor says about GBLIN's MCP endpoint (the non-pass checks and the MCP tool list).
const r = await fetch('https://x402-doctor.onrender.com/api/diagnose', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ url: 'https://gblin-mcp.gblin-mcp-worker.workers.dev/mcp' }),
  signal: AbortSignal.timeout(120000),
});
const d = await r.json();
console.log('HTTP', r.status, 'overall', d.overall);
for (const c of d.checks || []) if (c.status !== 'pass') console.log(c.status, c.id, '|', c.message, c.hint ? `| hint: ${c.hint}` : '');
if (d.mcp) console.log('mcp', JSON.stringify(d.mcp).slice(0, 3000));
