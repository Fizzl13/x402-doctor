// One-off: MetaMask dapp scanner verdicts (read-only GETs). Run 2026-10-02T12:45Z.
const hosts = ["x402-doctor.onrender.com", "ichimoku-signal.onrender.com", "x402-doctor.fizzl.eu", "presign-guard.fizzl.eu", "ichimoku-signal.fizzl.eu", "plaintext.fizzl.eu", "fizzl.eu", "wallet.fizzl.eu"];
for (const h of hosts) {
  try {
    const r = await fetch(`https://dapp-scanning.api.cx.metamask.io/scan?url=https://${h}`, { signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => null);
    console.log("MM", h, r.status, JSON.stringify({ recommendedAction: j?.recommendedAction, riskFactors: j?.riskFactors?.map?.((f) => f.type ?? f) ?? null }));
  } catch (e) { console.log("MM", h, "error", e.message); }
}
