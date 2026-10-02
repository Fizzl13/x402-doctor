// One-off: MetaMask dapp scanner verdicts (read-only GETs).
for (const h of ["x402-doctor.onrender.com", "ichimoku-signal.onrender.com", "x402-doctor.fizzl.eu", "presign-guard.fizzl.eu", "ichimoku-signal.fizzl.eu", "plaintext.fizzl.eu", "fizzl.eu"]) {
  try {
    const r = await fetch(`https://dapp-scanning.api.cx.metamask.io/scan?url=https://${h}`, { signal: AbortSignal.timeout(30000) });
    const j = await r.json().catch(() => null);
    console.log("MM", h, r.status, j?.recommendedAction ?? "?", JSON.stringify(j?.riskFactors ?? []).slice(0, 200));
  } catch (e) { console.log("MM", h, "ERR", e.message); }
}
