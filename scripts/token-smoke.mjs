import { tokenVerdict } from "../pg/src/token-verdict.js";
const cases = [["solana","DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"],["solana","EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],["solana","qikeUfbJaWPHy7sTTYfQuBuafzmUBZAH7SjCbjZCyFA"],["base","0x4ed4e862860bed51a9570b96d89af5e1b0efefed"],["base","0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"],["base","0x940181a94a35a4569e4529a3cdfb74e38fd98631"],["base","0x4200000000000000000000000000000000000006"],["base","0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf"],["ethereum","0xdac17f958d2ee523a2206206994597c13d831ec7"]];
for (const [chain,address] of cases) {
  try { const r = await tokenVerdict({chain,address}); console.log(chain, r.market?.symbol, "|", r.one_liner, "|", r.reasons.map(x=>x.code+":"+x.severity[0]).join(" "), "|", r.sources.join(",")); }
  catch (e) { console.log(chain, address, "ERR", e.message); }
}
