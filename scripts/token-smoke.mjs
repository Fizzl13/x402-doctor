// GBLIN's tool descriptions and metadata (tools/list only, free).
const r = await fetch("https://gblin-mcp.gblin-mcp-worker.workers.dev/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
const t = await r.text(); const m = t.match(/^data: (.*)$/m); const b = JSON.parse(m ? m[1] : t);
for (const tool of b.result.tools) console.log(`\n## ${tool.name} | title=${tool.title || ""} | annotations=${JSON.stringify(tool.annotations || {})} | _meta=${JSON.stringify(tool._meta || {}).slice(0, 300)}\n${(tool.description || "").slice(0, 500)}`);
