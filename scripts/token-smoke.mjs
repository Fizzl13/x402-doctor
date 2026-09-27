// MetaMask's site scanner (Blockaid) verdict per domain. Read-only GETs.
for (const host of ["x402-doctor.onrender.com", "presign-guard.onrender.com", "ichimoku-signal.onrender.com", "pg1-ai-agent.vercel.app", "smartcontractexplainer.onrender.com"]) {
  const r = await fetch(`https://dapp-scanning.api.cx.metamask.io/scan?url=https://${host}`);
  console.log(host, r.status, await r.text());
}
