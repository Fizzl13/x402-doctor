// nohumans.directory demand: what agents search for before paying (free MCP tool and free REST), read-only.
const API = "https://api.nohumans.directory";
async function mcp(method, params, session) {
  const r = await fetch(`${API}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e6), method, params }) });
  const text = await r.text();
  const json = text.startsWith("{") ? JSON.parse(text) : JSON.parse((text.match(/data: (.*)/g) || []).map((l) => l.slice(6)).pop() || "{}");
  return { json, session: r.headers.get("mcp-session-id") || session, status: r.status };
}
const init = await mcp("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fizzl-research", version: "1" } });
const s = init.session;
await fetch(`${API}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(s ? { "mcp-session-id": s } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
const tools = await mcp("tools/list", {}, s);
const t = (tools.json.result?.tools || []).find((x) => x.name === "what_agents_are_asking_for");
console.log("tool:", JSON.stringify(t).slice(0, 900));
for (const args of [{}, { limit: 100 }]) {
  const r = await mcp("tools/call", { name: "what_agents_are_asking_for", arguments: args }, s);
  const out = r.json.result?.content?.map((c) => c.text).join("\n") ?? JSON.stringify(r.json);
  console.log(`\n=== what_agents_are_asking_for ${JSON.stringify(args)} (${out.length} chars)\n${out.slice(0, 9000)}`);
}
const d = await fetch(`${API}/v1/demand`);
console.log(`\n=== GET /v1/demand ${d.status}\n${(await d.text()).slice(0, 6000)}`);
