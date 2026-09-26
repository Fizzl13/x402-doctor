// Live check: security headers on the three sites, the pay page still served, and the RPC relay limit.
const sites = {
  presign: ["https://presign-guard.onrender.com/", "https://presign-guard.onrender.com/v1/token"],
  ichimoku: ["https://ichimoku-signal.onrender.com/", "https://ichimoku-signal.onrender.com/signal/BTC-USDT"],
  doctor: ["https://x402-doctor.onrender.com/", "https://x402-doctor.onrender.com/api/v1/preflight"],
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const [name, urls] of Object.entries(sites)) {
  let ok = false;
  for (let i = 0; i < 30 && !ok; i++) {
    const res = await fetch(urls[0], { headers: { accept: "text/html" } }).catch(() => null);
    ok = res?.headers.get("x-frame-options") === "DENY";
    if (!ok) await sleep(20000);
  }
  console.log(`${ok ? "OK  " : "FAIL"} ${name}: new headers ${ok ? "live" : "not seen after 10 min"}`);
  for (const u of urls) {
    const r = await fetch(u, { headers: { accept: "text/html" } });
    const h = (k) => r.headers.get(k);
    console.log(`     ${u} → ${r.status} | nosniff=${h("x-content-type-options")} xfo=${h("x-frame-options")} csp=${h("content-security-policy")} hsts=${h("strict-transport-security")} powered=${h("x-powered-by")}`);
  }
}
// The pay page (browser request for a paid route) still renders.
const pay = await fetch("https://ichimoku-signal.onrender.com/signal/BTC-USDT", { headers: { accept: "text/html", "user-agent": "Mozilla/5.0" } });
const html = await pay.text();
console.log(`pay page: ${pay.status}, paywall html ${/x402/i.test(html) && html.length > 5000}, rpc rewrite ${html.includes("/solana-rpc")}`);
// The relay answers an allowed read; refused methods still 400.
const rpc = (method) => fetch("https://ichimoku-signal.onrender.com/solana-rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }) });
console.log(`solana-rpc getLatestBlockhash → ${(await rpc("getLatestBlockhash")).status}, sendTransaction → ${(await rpc("sendTransaction")).status}`);
// Admin without credentials: still the login prompt (401), not a lockout.
console.log(`doctor /admin/usage without credentials → ${(await fetch("https://x402-doctor.onrender.com/admin/usage")).status}`);
