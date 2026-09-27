// Reproduce PG1's report: live Doctor web diagnose of their MCP URL, plus a direct probe. Free.
for (const method of [undefined, "POST"]) {
  const r = await fetch("https://x402-doctor.onrender.com/api/diagnose", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(method ? { url: "https://pg1-ai-agent.vercel.app/api/mcp", method } : { url: "https://pg1-ai-agent.vercel.app/api/mcp" }) });
  const d = await r.json();
  console.log(`\n=== diagnose method=${method || "auto"} HTTP ${r.status} overall=${d.overall} error=${d.error || ""}`);
  for (const c of d.checks || []) console.log(`${c.status} ${c.id}: ${c.message || c.title || ""} ${c.detail ? "| " + JSON.stringify(c.detail).slice(0, 300) : ""}`);
}
for (const [m, body] of [["GET"], ["POST", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })]]) {
  const r = await fetch("https://pg1-ai-agent.vercel.app/api/mcp", { method: m, headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body });
  console.log(`\n=== direct ${m}: HTTP ${r.status} ${[...r.headers].filter(([k]) => /payment|content-type|www-auth/i.test(k)).map((h) => h.join(": ")).join(" | ")}`);
  console.log((await r.text()).slice(0, 400));
}
