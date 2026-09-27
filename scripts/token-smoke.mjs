// Is x402-doctor.onrender.com on MetaMask's phishing lists? Read-only GETs.
const hosts = ["x402-doctor.onrender.com", "presign-guard.onrender.com", "ichimoku-signal.onrender.com", "onrender.com"];
const sources = [
  ["eth-phishing-detect config.json", "https://raw.githubusercontent.com/MetaMask/eth-phishing-detect/main/src/config.json"],
  ["MetaMask stalelist v1", "https://phishing-detection.api.cx.metamask.io/v1/stalelist"],
  ["MetaMask stalelist v2", "https://phishing-detection.api.cx.metamask.io/v2/stalelist"],
  ["MetaMask hotlist v1 (last 24h)", "https://phishing-detection.api.cx.metamask.io/v1/diffsSince/" + Math.floor(Date.now() / 1000 - 3 * 86400)],
];
for (const [name, url] of sources) {
  try {
    const r = await fetch(url);
    const text = await r.text();
    console.log(`\n== ${name}: HTTP ${r.status}, ${text.length} bytes`);
    for (const h of hosts) {
      const re = new RegExp(`"${h.replace(/\./g, "\\.")}"`, "g");
      const n = (text.match(re) || []).length;
      const idx = text.search(re);
      console.log(`  ${h}: ${n} exact match(es)${idx >= 0 ? ` | context: ${text.slice(Math.max(0, idx - 200), idx + 120).replace(/\s+/g, " ")}` : ""}`);
    }
    const loose = (text.match(/[a-z0-9.-]*x402-doctor[a-z0-9.-]*/g) || []);
    console.log(`  any "x402-doctor" string: ${[...new Set(loose)].join(", ") || "none"}`);
  } catch (e) { console.log(`\n== ${name}: ${e.message}`); }
}
// MetaMask's per-URL check (if available)
for (const u of ["https://phishing-detection.api.cx.metamask.io/v1/check?url=https://x402-doctor.onrender.com", "https://dapp-scanning.api.cx.metamask.io/scan?url=https://x402-doctor.onrender.com"]) {
  try { const r = await fetch(u); console.log(`\n== ${u}: HTTP ${r.status} ${(await r.text()).slice(0, 400)}`); } catch (e) { console.log(`\n== ${u}: ${e.message}`); }
}
