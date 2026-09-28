// Poll until presign-guard, ichimoku-signal and plaintext on fizzl.eu serve a valid certificate (max 10 min), then show what answers.
const hosts = { 'x402-doctor.fizzl.eu': '/api/health', 'presign-guard.fizzl.eu': '/health', 'ichimoku-signal.fizzl.eu': '/.well-known/x402', 'plaintext.fizzl.eu': '/api/health' };
const ok = new Map();
for (let i = 0; i < 20 && ok.size < 4; i++) {
  for (const [h, p] of Object.entries(hosts)) {
    if (ok.has(h)) continue;
    try { const r = await fetch(`https://${h}${p}`, { signal: AbortSignal.timeout(15000) }); ok.set(h, `${r.status} ${(await r.text()).slice(0, 180).replace(/\s+/g, ' ')}`); console.log(new Date().toISOString(), 'OK', h); } catch (e) { if (i % 4 === 0) console.log(new Date().toISOString(), 'waiting', h, e.cause?.code || e.message); }
  }
  if (ok.size < 4) await new Promise((r) => setTimeout(r, 30000));
}
for (const h of Object.keys(hosts)) console.log(`\n== ${h}: ${ok.get(h) || 'NO CERTIFICATE YET'}`);
process.exit(ok.size === 4 ? 0 : 1);
