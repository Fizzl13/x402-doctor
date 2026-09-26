// How PG1 treats no key, a wrong key, and what get_usage_status returns.
const E = "https://pg1-ai-agent.vercel.app/api/mcp";
async function call(name, args, key) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (key) headers["x-api-key"] = key;
  const r = await fetch(E, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const t = await r.text();
  console.log(`\n## ${name} key=${key ? "fake" : "none"} -> HTTP ${r.status}\n${t.slice(0, 900)}`);
}
await call("get_usage_status", {});
await call("get_usage_status", {}, "FAKE-0000-0000-0000");
await call("get_usage_status", { license_key: "FAKE-0000-0000-0000" });
await call("check_wallet_sanctions", { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }, "FAKE-0000-0000-0000");
await call("check_domain_age", { domain: "uniswap.org" }, "FAKE-0000-0000-0000");
