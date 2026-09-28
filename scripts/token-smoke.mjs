// Daily MetaMask site-scanner check (read-only GETs): old onrender hosts, PG1, and the new fizzl.eu hosts.
const hosts = ['x402-doctor.onrender.com', 'ichimoku-signal.onrender.com', 'pg1-ai-agent.vercel.app', 'presign-guard.onrender.com', 'x402-doctor.fizzl.eu', 'presign-guard.fizzl.eu', 'ichimoku-signal.fizzl.eu', 'plaintext.fizzl.eu', 'fizzl.eu'];
for (const h of hosts) {
  try {
    const r = await fetch(`https://dapp-scanning.api.cx.metamask.io/scan?url=${encodeURIComponent(`https://${h}`)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    console.log(`${h}: ${r.status} ${j.recommendedAction} ${JSON.stringify((j.riskFactors || []).map((f) => f.type))}`);
  } catch (e) { console.log(`${h}: error ${e.message}`); }
}
