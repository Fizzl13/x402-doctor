// One-off: test PG1's free MCP tools (sanctions + domain age) before using them in presign-guard.
const E = "https://pg1-ai-agent.vercel.app/api/mcp";
let id = 0;
async function rpc(method, params) {
  const t = Date.now();
  const res = await fetch(E, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  const text = await res.text();
  let body = text;
  const m = text.match(/^data: (.*)$/m);
  try { body = JSON.parse(m ? m[1] : text); } catch {}
  return { status: res.status, ms: Date.now() - t, ct: res.headers.get("content-type"), body };
}
const show = (label, r) => {
  const c = r.body?.result?.content?.[0]?.text;
  console.log(`\n## ${label}  [HTTP ${r.status}, ${r.ms} ms, ${r.ct}]`);
  console.log(c ? c.slice(0, 900) : JSON.stringify(r.body).slice(0, 900));
  if (r.body?.result?.isError) console.log("(isError: true)");
  if (r.body?.result?.structuredContent) console.log("structured:", JSON.stringify(r.body.result.structuredContent).slice(0, 400));
};
const call = (name, args) => rpc("tools/call", { name, arguments: args });

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "presign-guard-test", version: "0.1" } });
console.log("initialize", init.status, init.ms, "ms", JSON.stringify(init.body?.result?.serverInfo));
const list = await rpc("tools/list", {});
console.log("tools:", (list.body?.result?.tools || []).map((t) => `${t.name}: ${JSON.stringify(t.inputSchema?.properties)}`).join("\n  "));

const cases = [
  ["sanctions: Lazarus (Ronin hack) checksum", "check_wallet_sanctions", { address: "0x098B716B8Aaf21512996dC57EB0615e2383E2f96" }],
  ["sanctions: same, lowercase", "check_wallet_sanctions", { address: "0x098b716b8aaf21512996dc57eb0615e2383e2f96" }],
  ["sanctions: Tornado Cash router (delisted Mar 2025)", "check_wallet_sanctions", { address: "0x8589427373D6D84E98730D7795D8f6f8731FDA16" }],
  ["sanctions: vitalik.eth (clean)", "check_wallet_sanctions", { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }],
  ["sanctions: Solana address (clean)", "check_wallet_sanctions", { address: "ATWJ82T8nRdQwZnaysB68N5EpaSvLRsQP4h6eWmaJBH9" }],
  ["sanctions: invalid 'hello'", "check_wallet_sanctions", { address: "hello" }],
  ["sanctions: missing argument", "check_wallet_sanctions", {}],
  ["domain: uniswap.org", "check_domain_age", { domain: "uniswap.org" }],
  ["domain: URL with path", "check_domain_age", { domain: "https://app.uniswap.org/swap?x=1" }],
  ["domain: onrender.com subdomain", "check_domain_age", { domain: "presign-guard.onrender.com" }],
  ["domain: .xyz", "check_domain_age", { domain: "rugcheck.xyz" }],
  ["domain: nonexistent", "check_domain_age", { domain: "this-domain-does-not-exist-9f3k2.com" }],
  ["domain: IP", "check_domain_age", { domain: "8.8.8.8" }],
  ["domain: .nl ccTLD", "check_domain_age", { domain: "fizzl.eu" }],
];
for (const [label, name, args] of cases) show(label, await call(name, args));

const times = [];
for (let i = 0; i < 6; i++) times.push((await call("check_wallet_sanctions", { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" })).ms);
const dt = [];
for (let i = 0; i < 4; i++) dt.push((await call("check_domain_age", { domain: "uniswap.org" })).ms);
console.log("\nsanctions ms:", times.join(", "), " domain ms:", dt.join(", "));
