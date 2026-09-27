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
await show("GET", "/api/x402/ping/ping");
await show("POST", "/api/x402/ping/ping");
await show("POST", "/api/x402/ping/ping", { headers: { "X-PAYMENT": Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network: "eip155:8453", payload: { txHash: "0x" + "00".repeat(32) } })).toString("base64") } });
// What a standard v2 client sends: a signed EIP-3009 authorization, not a txHash (fake signature).
await show("POST", "/api/x402/ping/ping", { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453" }, payload: { signature: "0x" + "11".repeat(65), authorization: { from: "0x" + "22".repeat(20), to: "0xAd3dB8e2b1A311701E6233f17F6d648e4A52287c", value: "10000", validAfter: "0", validBefore: "9999999999", nonce: "0x" + "33".repeat(32) } } })).toString("base64") } });
