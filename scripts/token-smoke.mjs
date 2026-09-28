// Live check after the feedback merge: GET /feedback on all four services (no POST, no junk reports),
// polling until each answers 200 with the schema (Render deploys take a few minutes).
const HOSTS = ['ichimoku-signal', 'x402-doctor', 'presign-guard', 'plaintext'].map((h) => `https://${h}.fizzl.eu`);
const done = {};
for (let round = 0; round < 30 && Object.keys(done).length < HOSTS.length; round++) {
  for (const h of HOSTS) {
    if (done[h]) continue;
    try {
      const r = await fetch(`${h}/feedback`, { headers: { accept: 'application/json' } });
      const b = r.headers.get('content-type')?.includes('json') ? await r.json() : null;
      if (r.status === 200 && b && b.schema) { done[h] = `${b.service} ok, required ${JSON.stringify(b.schema.required)}`; console.log(new Date().toISOString(), h, done[h]); }
      else if (round % 5 === 0) console.log(new Date().toISOString(), h, 'not yet', r.status);
    } catch (e) { console.log(h, 'ERR', e.message); }
  }
  if (Object.keys(done).length < HOSTS.length) await new Promise((s) => setTimeout(s, 20000));
}
for (const h of HOSTS) {
  const r = await fetch(`${h}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) }).catch((e) => ({ status: 'ERR ' + e.message, text: async () => '' }));
  const t = await r.text();
  console.log(h, 'tools/list', r.status, /"name":"feedback"/.test(t) ? 'has feedback tool' : 'NO feedback tool');
}
console.log('summary', JSON.stringify(done));
