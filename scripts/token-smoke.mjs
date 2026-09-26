// PlainText from outside: 402s, CDP validator, Bazaar/Agentic Market presence.
const B = "https://smartcontractexplainer.onrender.com";
const t0 = Date.now(); const h = await fetch(B + "/api/health").catch((e) => ({ status: String(e) }));
console.log("health", h.status, (Date.now() - t0) + " ms");
for (const p of ["/api/check-wallet", "/api/explain"]) {
  const r = await fetch(B + p, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const hd = r.headers.get("payment-required");
  const acc = hd ? JSON.parse(Buffer.from(hd, "base64").toString()).accepts.map((a) => `${a.network} $${Number(a.amount) / 1e6} -> ${a.payTo}`).join(" | ") : (await r.text()).slice(0, 200);
  console.log(`POST ${p}: ${r.status} ${acc}`);
  const v = await fetch("https://api.cdp.coinbase.com/platform/v2/x402/validate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resource: B + p, method: "POST" }) }).then((x) => x.json()).catch((e) => ({ error: String(e) }));
  const failed = (v.preflight || []).filter((c) => !c.passed).map((c) => `${c.check}: ${c.detail}`);
  console.log(`  validate: valid=${v.valid} outcome=${v.simulation?.outcome} failed=${JSON.stringify(failed).slice(0, 400)}`);
}
const am = await fetch("https://api.agentic.market/v1/services/smartcontractexplainer-onrender-com").then(async (x) => ({ s: x.status, j: await x.json().catch(() => null) }));
console.log("agentic.market:", am.s, JSON.stringify(am.j)?.slice(0, 600));
let found = [];
for (let off = 0; off < 20000; off += 500) {
  const r = await fetch(`https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?type=http&limit=500&offset=${off}`).then((x) => x.json()).catch(() => null);
  const items = r?.items || r?.resources || [];
  for (const it of items) if (JSON.stringify(it).includes("smartcontractexplainer")) found.push({ resource: it.resource, quality: it.quality, lastUpdated: it.lastUpdated });
  if (items.length < 500) break;
}
console.log("CDP Bazaar entries:", JSON.stringify(found, null, 1).slice(0, 1200));
const mcp = await fetch(B + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }).then((x) => x.json()).catch((e) => ({ error: String(e) }));
console.log("mcp tools:", (mcp.result?.tools || []).map((t) => t.name).join(", ") || JSON.stringify(mcp).slice(0, 200));
