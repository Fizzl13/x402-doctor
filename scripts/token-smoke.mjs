// What Doctor tells GBLIN about their MCP server (free web diagnose, never pays).
const r = await fetch("https://x402-doctor.onrender.com/api/diagnose", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://gblin-mcp.gblin-mcp-worker.workers.dev/mcp" }) });
const d = await r.json();
console.log(`HTTP ${r.status} method=${d.method} overall=${d.overall}`);
for (const c of d.checks || []) console.log(`${c.status} [${c.group}] ${c.id}: ${c.message}${c.hint && c.status !== "pass" ? `\n    -> ${c.hint}` : ""}`);
console.log("\nmcp:", JSON.stringify(d.mcp));
