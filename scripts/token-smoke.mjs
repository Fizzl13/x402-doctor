// Read-only: a public endpoint someone asked about on Discord. Free Doctor check + Bazaar lookup. Never pays.
const EP = 'https://filingdelta-328386696249.us-central1.run.app/v1/8k/events?ticker=AAPL';
const r = await fetch('https://x402-doctor.fizzl.eu/api/diagnose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: EP }), signal: AbortSignal.timeout(40000) });
const d = await r.json();
console.log('DOC overall', d.overall || d.status);
for (const c of d.checks || []) if (c.status !== 'pass') console.log('DOC', c.status, c.id, '|', (c.message || c.detail || '').slice(0, 300));
const raw = await fetch(EP, { signal: AbortSignal.timeout(20000) });
const pr = raw.headers.get('payment-required');
console.log('RAW', raw.status);
if (pr) { const j = JSON.parse(Buffer.from(pr, 'base64').toString()); console.log('PR resource', JSON.stringify(j.resource)); console.log('PR accepts', JSON.stringify(j.accepts).slice(0, 600)); console.log('PR ext', JSON.stringify(j.extensions || {}).slice(0, 900)); }
const U = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources';
let hits = 0;
for (let p = 0; p < 60; p++) {
  const x = await fetch(`${U}?type=http&limit=100&offset=${p * 100}`, { signal: AbortSignal.timeout(20000) });
  if (!x.ok) { console.log('BZ HTTP', x.status); break; }
  const items = (await x.json()).items || [];
  for (const it of items) if (/filingdelta/i.test(it.resource) || JSON.stringify(it.accepts || []).toLowerCase().includes('0x126ff41c8c7866a017c1c3e0865f702828fb5c63')) { hits++; console.log('BZ', it.resource, it.lastUpdated); }
  if (items.length < 100) { console.log('BZ pages', p + 1, 'hits', hits); break; }
}
