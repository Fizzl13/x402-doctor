// Full live header check: every public route type on the three sites (free, nothing paid).
const WANT = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  "strict-transport-security": "max-age=31536000",
  "referrer-policy": "strict-origin-when-cross-origin",
};
const routes = {
  presign: ["/", "/health", "/openapi.json", "/.well-known/x402", "/.well-known/x402-trust.txt", "/v1/token", "/v1/approvals", ["POST", "/v1/check"], ["POST", "/mcp"]],
  ichimoku: ["/", "/openapi.json", "/.well-known/x402", "/.well-known/x402-trust.txt", "/api/trend/BTC-USDT", "/signal/BTC-USDT", "/media/explainer.jpg", ["POST", "/mcp"], ["POST", "/solana-rpc"]],
  doctor: ["/", "/openapi.json", "/.well-known/x402", "/.well-known/x402-trust.txt", "/api/v1/preflight", "/admin/usage", ["POST", "/mcp"]],
};
const hosts = { presign: "presign-guard", ichimoku: "ichimoku-signal", doctor: "x402-doctor" };
const mcpInit = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "header-check", version: "1" } } });
let problems = 0;
for (const [name, list] of Object.entries(routes)) {
  console.log(`\n== ${name}`);
  for (const r of list) {
    const [method, path] = Array.isArray(r) ? r : ["GET", r];
    const body = path === "/mcp" ? mcpInit : path === "/solana-rpc" ? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestBlockhash" }) : method === "POST" ? "{}" : undefined;
    const res = await fetch(`https://${hosts[name]}.onrender.com${path}`, { method, body, headers: { "content-type": "application/json", accept: path === "/mcp" ? "application/json, text/event-stream" : "*/*" } });
    const bad = Object.entries(WANT).filter(([k, v]) => res.headers.get(k) !== v).map(([k]) => `${k}=${res.headers.get(k)}`);
    if (res.headers.get("x-powered-by")) bad.push(`x-powered-by=${res.headers.get("x-powered-by")}`);
    const acao = res.headers.get("access-control-allow-origin");
    problems += bad.length ? 1 : 0;
    console.log(`  ${bad.length ? "MISS" : "ok  "} ${method} ${path} → ${res.status}${acao ? ` (CORS ${acao})` : ""}${bad.length ? ` | ${bad.join(", ")}` : ""}`);
    await res.body?.cancel();
  }
}
console.log(`\nroutes missing a header: ${problems}`);
