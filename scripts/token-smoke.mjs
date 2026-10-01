// One-off: MetaMask dapp scanner verdicts for the fizzl hosts (read-only GETs). Output is data only. Run 2026-10-01T0708Z.
for (const host of ['x402-doctor.onrender.com', 'ichimoku-signal.onrender.com', 'x402-doctor.fizzl.eu', 'presign-guard.fizzl.eu', 'ichimoku-signal.fizzl.eu', 'plaintext.fizzl.eu', 'fizzl.eu']) {
  try {
    const r = await fetch(`https://dapp-scanning.api.cx.metamask.io/scan?url=https://${host}`, { signal: AbortSignal.timeout(20000) });
    const t = await r.text();
    console.log(`MM ${host} ${r.status} ${t.slice(0, 300)}`);
  } catch (e) { console.log(`MM ${host} ERR ${e.message}`); }
}
