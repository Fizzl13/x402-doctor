// One-off: live test of NEW_WALLET_SPENDER on Base (free calls only, never pays). Run 2026-09-30T2200Z.
import { randomBytes } from "node:crypto";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const FRESH = "0x" + randomBytes(20).toString("hex"); // never used: no on-chain history
const OLD = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";   // vitalik.eth, years old
const post = (url, name, args) => fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }).then(async (r) => `${r.status} ${(await r.text()).slice(0, 600)}`);
const pg1 = (a) => post("https://pg1-ai-agent.vercel.app/api/mcp", "check_wallet_age", { address: a, chain: "base" });
const quick = (spender) => post("https://presign-guard.fizzl.eu/mcp", "presign_quick_check", { type: "approval", chainId: 8453, token: USDC, spender, amount: "1000000" });
console.log("fresh:", FRESH);
for (const a of [FRESH, OLD]) { const t = Date.now(); console.log("PG1 age", a, await pg1(a), `${Date.now() - t}ms`); }
console.log("waiting 6 min for the Render deploy");
await new Promise((r) => setTimeout(r, 360000));
console.log("health:", await fetch("https://presign-guard.fizzl.eu/health").then((r) => r.text()));
for (const a of [FRESH, OLD]) { const t = Date.now(); console.log("quick", a, await quick(a), `${Date.now() - t}ms`); }
