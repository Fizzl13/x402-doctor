// Read-only: two public endpoints someone shared on Discord. Free Doctor check only. Never pays.
const B = 'https://x402-extract-wg5z.onrender.com';
for (const p of ['/extract', '/extract-fields']) {
  try {
    const r = await fetch('https://x402-doctor.fizzl.eu/api/diagnose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: B + p, method: 'POST' }), signal: AbortSignal.timeout(60000) });
    const d = await r.json();
    console.log('DOC', p, 'overall', d.overall || d.status, d.error || '');
    for (const c of d.checks || []) if (c.status !== 'pass') console.log('DOC', p, c.status, c.id, '|', (c.message || c.detail || '').slice(0, 280));
  } catch (e) { console.log('DOC', p, 'ERR', e.message); }
}
