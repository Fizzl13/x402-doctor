// The new x402-over-MCP check (work branch) against live MCP servers. Never pays.
import { spawnSync } from "node:child_process";
const run = (cmd, args, cwd) => { const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 300000 }); return `${r.stdout}${r.stderr}`; };
console.log(run("git", ["clone", "-q", "--depth", "1", "-b", "claude/x402-agents-solana-payments-nceg9b", "https://github.com/Fizzl13/x402-doctor", "/tmp/d"]));
console.log(run("npm", ["ci", "--silent", "--no-audit", "--no-fund"], "/tmp/d").slice(-500));
for (const url of ["https://pg1-ai-agent.vercel.app/api/mcp", "https://presign-guard.onrender.com/mcp", "https://x402-doctor.onrender.com/mcp"]) {
  console.log(`\n==================== ${url}`);
  console.log(run("node", ["bin/x402-doctor.js", url], "/tmp/d").slice(-3500));
  const j = run("node", ["bin/x402-doctor.js", "--json", url], "/tmp/d");
  try { console.log("mcp:", JSON.stringify(JSON.parse(j).mcp)); } catch { console.log("json parse failed"); }
}
