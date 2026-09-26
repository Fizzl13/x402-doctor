// Evening check (free, read-only): presign-guard wake time, x402 Trust grades, nohumans listings and ranking.
for (const h of ['presign-guard', 'x402-doctor', 'ichimoku-signal']) {
  const t0 = Date.now();
  const r = await fetch(`https://${h}.onrender.com/health`, { signal: AbortSignal.timeout(90000) }).catch((e) => ({ status: 0, e }));
  console.log(`${h} /health → ${r.status} in ${Date.now() - t0} ms`);
}
console.log('\n##### x402 Trust');
await import('./trust.mjs');
console.log('\n##### nohumans');
await import('./nohumans-status.mjs');
