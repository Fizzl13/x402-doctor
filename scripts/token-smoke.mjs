// CDP's own validator on every paid route (curation requirement "Verified").
const U = "https://ichimoku-signal.onrender.com/signal/BTC-USDT";
const routes = [
  ["https://presign-guard.onrender.com/v1/check", "POST"],
  ["https://presign-guard.onrender.com/v1/check/explain", "POST"],
  ["https://presign-guard.onrender.com/v1/token?chain=solana&address=DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", "GET"],
  [`https://x402-doctor.onrender.com/api/v1/diagnose?url=${encodeURIComponent(U)}`, "GET"],
  [`https://x402-doctor.onrender.com/api/v1/preflight?url=${encodeURIComponent(U)}`, "GET"],
  [`https://x402-doctor.onrender.com/api/v1/fix?url=${encodeURIComponent(U)}`, "GET"],
  ["https://ichimoku-signal.onrender.com/signal/BTC-USDT", "GET"],
  ["https://ichimoku-signal.onrender.com/signals/BTC-USDT", "GET"],
  ["https://ichimoku-signal.onrender.com/levels/BTC-USDT", "GET"],
  ["https://ichimoku-signal.onrender.com/scan", "GET"],
];
// Wake the three services first (Render cold starts).
for (const h of ["presign-guard", "x402-doctor", "ichimoku-signal"]) {
  const t = Date.now(); const r = await fetch(`https://${h}.onrender.com/health`).catch(() => null);
  console.log(`wake ${h}: ${r?.status} in ${Date.now() - t} ms`);
}
for (const [resource, method] of routes) {
  const r = await fetch("https://api.cdp.coinbase.com/platform/v2/x402/validate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resource, method }) });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { console.log(`\n## ${method} ${resource}\nHTTP ${r.status} ${text.slice(0, 400)}`); continue; }
  console.log(`\n## ${method} ${resource.replace(/\?.*/, "")}\nHTTP ${r.status} valid=${j.valid} outcome=${j.simulation?.outcome}`);
  const pre = j.preflight;
  if (pre) console.log("preflight:", JSON.stringify(pre).slice(0, 1500));
  if (j.errors || j.error) console.log("errors:", JSON.stringify(j.errors || j.error).slice(0, 600));
  if (!pre && !j.errors) console.log("keys:", Object.keys(j).join(","), JSON.stringify(j).slice(0, 800));
}
