// nohumans: live category list, and the full records of our 4 existing listings. Read-only.
const API = "https://api.nohumans.directory";
const cats = await (await fetch(`${API}/v1/categories`)).json();
console.log("categories:", JSON.stringify(cats).slice(0, 2500));
for (const u of ["https://presign-guard.onrender.com/v1/check", "https://ichimoku-signal.onrender.com/signal/:pair", "https://x402-doctor.onrender.com/api/v1/preflight", "https://smartcontractexplainer.onrender.com/api/check-wallet"]) {
  const d = await (await fetch(`${API}/v1/resolve?url=${encodeURIComponent(u)}`)).json();
  console.log(`\n-- ${u}\n${JSON.stringify(d).slice(0, 1400)}`);
}
// Ichimoku's free trend as a sample_query candidate: must be GET, 200, JSON.
const t = await fetch("https://ichimoku-signal.onrender.com/api/trend/BTC-USDT");
console.log(`\nsample candidate /api/trend/BTC-USDT → ${t.status} ${t.headers.get("content-type")} ${(await t.text()).slice(0, 200)}`);
