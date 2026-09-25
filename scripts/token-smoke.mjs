// One-off: presign-guard branch analyze() with live GoPlus + PG1.
import { parseRequest, analyze } from "../pg/src/presign-guard.js";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const cases = [
  ["approval to Lazarus (OFAC)", { type: "approval", chainId: 1, token: "0xdAC17F958D2ee523a2206206994597C13D831ec7", spender: "0x098B716B8Aaf21512996dC57EB0615e2383E2f96", amount: "1000000" }],
  ["Permit2 approval, origin uniswap.org", { type: "approval", chainId: 8453, token: USDC, spender: "0x000000000022D473030F116dDEE9F6B43aC78BA3", amount: "1000000", origin: "https://app.uniswap.org/swap" }],
  ["same, origin fizzl.eu (no RDAP)", { type: "approval", chainId: 8453, token: USDC, spender: "0x000000000022D473030F116dDEE9F6B43aC78BA3", amount: "1000000", origin: "fizzl.eu" }],
  ["same, unregistered origin", { type: "approval", chainId: 8453, token: USDC, spender: "0x000000000022D473030F116dDEE9F6B43aC78BA3", amount: "1000000", origin: "claim-usdc-airdrop-8k2j.com" }],
];
for (const [label, body] of cases) {
  const t = Date.now();
  const r = await analyze(parseRequest(body));
  console.log(`\n## ${label}  (${Date.now() - t} ms)\n${r.verdict} | sources ${r.sources.join(",")}`);
  for (const x of r.reasons) console.log(`  ${x.severity} ${x.code} ${x.subject ?? ""} ${x.details ? JSON.stringify(x.details).slice(0, 200) : ""}`);
}
