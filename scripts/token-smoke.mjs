// Live check after both deploys: Doctor's web API on presign-guard's MCP server. Never pays.
for (let round = 0; round < 20; round++) {
  const tl = await fetch("https://presign-guard.onrender.com/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }).then((r) => r.json()).catch(() => ({}));
  const hasExamples = (tl.result?.tools || []).every((t) => t._meta?.examples?.length);
  const r = await fetch("https://x402-doctor.onrender.com/api/diagnose", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://presign-guard.onrender.com/mcp" }) });
  const d = await r.json().catch(() => ({}));
  const refused = (d.checks || []).some((c) => /refused before the payment step/.test(c.message));
  console.log(`round ${round}: presign examples ${hasExamples}, doctor overall=${d.overall}, refused=${refused}`);
  if (hasExamples && d.method === "MCP" && !refused) {
    for (const c of d.checks) console.log(`${c.status} [${c.group}] ${c.id}: ${c.message.slice(0, 180)}`);
    break;
  }
  await new Promise((res) => setTimeout(res, 30000));
}
