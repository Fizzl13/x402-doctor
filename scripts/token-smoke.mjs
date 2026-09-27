// Live check of presign-guard's origin reputation via the free MCP quick check. Never pays.
const call = async (origin) => {
  const args = { type: "approval", chainId: 8453, token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", spender: "0x000000000022D473030F116dDEE9F6B43aC78BA3", amount: "1000000", origin };
  const r = await fetch("https://presign-guard.onrender.com/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "presign_quick_check", arguments: args } }) });
  const b = await r.json();
  return b.result?.content?.[0]?.text ?? JSON.stringify(b);
};
await new Promise((res) => setTimeout(res, 150000)); // let Render deploy
for (let round = 0; round < 4; round++) {
  const out = await call("002271coinbase.com");
  console.log(`round ${round}: 002271coinbase.com -> ${out}`);
  if (/"red"/.test(out)) {
    for (const o of ["metamask-login.com", "ichimoku-signal.onrender.com", "uniswap.org"]) console.log(`${o} -> ${await call(o)}`);
    break;
  }
  await new Promise((res) => setTimeout(res, 60000));
}
