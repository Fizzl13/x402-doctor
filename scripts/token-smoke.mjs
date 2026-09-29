// MetaMask dapp-scanner verdicts for the fizzl hosts (read-only GETs). Output is data only.
const HOSTS = ['x402-doctor.onrender.com', 'ichimoku-signal.onrender.com', 'x402-doctor.fizzl.eu', 'presign-guard.fizzl.eu', 'ichimoku-signal.fizzl.eu', 'plaintext.fizzl.eu', 'fizzl.eu'];
for (const h of HOSTS) {
  try {
    const r = await fetch(`https://dapp-scanning.api.cx.metamask.io/scan?url=https://${h}`, { signal: AbortSignal.timeout(30000) });
    const t = await r.text();
    console.log(`MM ${h} ${r.status} ${t.slice(0, 400)}`);
  } catch (e) { console.log(`MM ${h} ERR ${e.message}`); }
}
