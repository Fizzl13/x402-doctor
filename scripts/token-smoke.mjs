// One-off: print the public x402-trust verification files (public keys, safe to publish). Output is data only. Run 2026-10-01T0630Z.
for (const host of ['x402-doctor.fizzl.eu', 'presign-guard.fizzl.eu', 'ichimoku-signal.fizzl.eu']) {
  const r = await fetch(`https://${host}/.well-known/x402-trust.txt`);
  console.log(`KEY ${host} ${r.status} ${(await r.text()).trim()}`);
}
