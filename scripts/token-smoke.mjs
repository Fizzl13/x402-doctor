// Read-only: the four agent registration documents after deploy.
for (const h of ['x402-doctor', 'presign-guard', 'ichimoku-signal', 'plaintext']) {
  const u = `https://${h}.fizzl.eu/.well-known/agent-registration.json`;
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
    const j = r.ok ? await r.json() : null;
    const img = j?.image ? (await fetch(j.image, { method: 'HEAD' })).status : '-';
    console.log('REG', h, r.status, j?.name, JSON.stringify(j?.services?.map((s) => s.endpoint)), 'image', img);
  } catch (e) { console.log('REG', h, 'ERR', e.message); }
}
