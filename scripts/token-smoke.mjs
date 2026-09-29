// Read-only: why does the Doctor's agent registration return 404? Compare hosts and a cache-buster.
for (const u of ['https://x402-doctor.fizzl.eu/.well-known/agent-registration.json', 'https://x402-doctor.fizzl.eu/.well-known/agent-registration.json?v=2', 'https://x402-doctor.onrender.com/.well-known/agent-registration.json', 'https://x402-doctor.fizzl.eu/.well-known/x402', 'https://x402-doctor.fizzl.eu/']) {
  const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
  const t = await r.text();
  console.log('DBG', r.status, u, 'age', r.headers.get('age'), 'cache', r.headers.get('cf-cache-status') || r.headers.get('x-cache') || '-', 'server', r.headers.get('server'), 'rndr', r.headers.get('rndr-id'), '|', t.slice(0, 90).replace(/\s+/g, ' '));
}
