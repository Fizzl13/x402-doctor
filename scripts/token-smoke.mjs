// Live check after the MCP deploy: Doctor's free web API on PG1's MCP URL. Never pays.
for (let round = 0; round < 16; round++) {
  const r = await fetch("https://x402-doctor.onrender.com/api/diagnose", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://pg1-ai-agent.vercel.app/api/mcp" }) });
  const d = await r.json().catch(() => ({}));
  console.log(`round ${round}: HTTP ${r.status} method=${d.method} overall=${d.overall}`);
  if (d.method === "MCP") {
    for (const c of d.checks) console.log(`${c.status} [${c.group}] ${c.id}: ${c.message.slice(0, 200)}`);
    break;
  }
  await new Promise((res) => setTimeout(res, 30000));
}
