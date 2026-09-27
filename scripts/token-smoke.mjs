// Free, read-only probe of rider-x402.fly.dev (posted in the x402 Discord): which methods answer,
// what the 402 envelope looks like (version, scheme, fields), and the discovery docs. No payment.
const B = "https://rider-x402.fly.dev";
const show = async (method, path, extra = {}) => {
  try {
    const r = await fetch(B + path, { method, redirect: "manual", signal: AbortSignal.timeout(20000), ...extra });
    const body = await r.text();
    const h = Object.fromEntries([...r.headers].filter(([k]) => /payment|x402|content-type|allow|www-auth|location/i.test(k)));
    console.log(`\n== ${method} ${path} -> ${r.status}`, JSON.stringify(h).slice(0, 400));
    for (const [k, v] of Object.entries(h)) if (/payment-required/i.test(k)) { try { console.log("   decoded", k, Buffer.from(v, "base64").toString().slice(0, 2500)); } catch {} }
    console.log("   body:", body.slice(0, 2500));
  } catch (e) { console.log(`\n== ${method} ${path} -> error ${e.message}`); }
};
for (const p of ["/", "/health", "/api/x402/prices", "/.well-known/x402"]) await show("GET", p);
await show("GET", "/openapi.json");
await show("GET", "/api/ping/ping");
await show("HEAD", "/api/ping/ping");
await show("POST", "/api/ping/ping");
await show("POST", "/api/ping/ping", { headers: { "content-type": "application/json" }, body: "{}" });
// A fake v2 PAYMENT-SIGNATURE and a fake X-PAYMENT: how does it reject a malformed proof?
await show("POST", "/api/ping/ping", { headers: { "X-PAYMENT": Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network: "eip155:8453", payload: { txHash: "0x" + "00".repeat(32) } })).toString("base64") } });
