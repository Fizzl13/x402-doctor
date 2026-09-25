// Live check of the deployed token verdict on presign-guard.onrender.com.
const BASE = "https://presign-guard.onrender.com";
await fetch(BASE + "/health").catch(() => {});
for (let i = 0; i < 6; i++) { const r = await fetch(BASE + "/health").catch(() => null); if (r?.ok) break; await new Promise((s) => setTimeout(s, 10000)); }
const r = await fetch(`${BASE}/v1/token?chain=solana&address=DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263`, { headers: { accept: "application/json" } });
console.log("402 status", r.status);
const hdr = r.headers.get("payment-required");
const ch = hdr ? JSON.parse(Buffer.from(hdr, "base64").toString()) : await r.json();
console.log("accepts", JSON.stringify(ch.accepts?.map((a) => [a.network, a.amount, a.payTo, a.asset])));
console.log("bazaar input", JSON.stringify(ch.extensions?.bazaar?.info?.input));
const bad = await fetch(`${BASE}/v1/token?chain=solana&address=nope`);
console.log("invalid", bad.status, await bad.text());
const mcp = await fetch(BASE + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
console.log("mcp tools", (await mcp.json()).result?.tools?.map((t) => t.name).join(", "));
const free = await fetch(BASE + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "token_quick_verdict", arguments: { chain: "base", address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631" } } }) });
console.log("free AERO", JSON.stringify((await free.json()).result?.content?.[0]?.text));
const oa = await (await fetch(BASE + "/openapi.json")).json();
console.log("openapi token networks", JSON.stringify(oa.paths["/v1/token"]?.get?.["x-payment-info"]?.networks));
// recheck 1790364646
