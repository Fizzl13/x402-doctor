// Shape of PG1's check_hostname_reputation and GoPlus phishing_site. Free, read-only.
const PG1 = "https://pg1-ai-agent.vercel.app/api/mcp";
const rpc = async (method, params) => {
  const r = await fetch(PG1, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const t = await r.text(); const m = t.match(/^data: (.*)$/m);
  return { status: r.status, body: JSON.parse(m ? m[1] : t) };
};
const list = await rpc("tools/list", {});
const tool = list.body.result.tools.find((t) => t.name === "check_hostname_reputation");
console.log("TOOL", JSON.stringify(tool, null, 1).slice(0, 2500));
for (const host of ["002271coinbase.com", "metamask-login.com", "google.com", "x402-doctor.onrender.com", "presign-guard.onrender.com", "app.uniswap.org", "uniswap.org"]) {
  const c = await rpc("tools/call", { name: "check_hostname_reputation", arguments: { hostname: host } });
  console.log(`\nPG1 ${host} HTTP ${c.status}:`, JSON.stringify(c.body.result?.structuredContent ?? c.body.result ?? c.body).slice(0, 900));
  const g = await fetch(`https://api.gopluslabs.io/api/v1/phishing_site?url=${encodeURIComponent("https://" + host)}`).then((r) => r.json()).catch((e) => ({ e: e.message }));
  console.log(`GoPlus ${host}:`, JSON.stringify(g).slice(0, 300));
}
