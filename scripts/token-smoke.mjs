// One-off: is the wallet server up? Read-only, no login, no keys.
const base = "https://fizzl-wallet-server.onrender.com";
for (const [path, init] of [["/health"], ["/"], ["/api/state"], ["/v1/spending"], ["/v1/reserve", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer awk_nope" }, body: "{}" }]]) {
  const t = Date.now();
  try {
    const r = await fetch(base + path, { ...(init ?? {}), signal: AbortSignal.timeout(60000) });
    const body = (await r.text()).replace(/\s+/g, " ").slice(0, 140);
    console.log("WS", path, r.status, `${Date.now() - t}ms`, r.headers.get("content-security-policy") ? "csp" : "", body);
  } catch (e) { console.log("WS", path, "ERR", e.message); }
}
