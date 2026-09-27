// The free/paid fix (work branch) on four live MCP servers. Never pays.
import { spawnSync } from "node:child_process";
const run = (cmd, args, cwd) => { const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 300000 }); return `${r.stdout}${r.stderr}`; };
run("git", ["clone", "-q", "--depth", "1", "-b", "claude/x402-agents-solana-payments-nceg9b", "https://github.com/Fizzl13/x402-doctor", "/tmp/d"]);
run("npm", ["ci", "--silent", "--no-audit", "--no-fund"], "/tmp/d");
for (const url of ["https://gblin-mcp.gblin-mcp-worker.workers.dev/mcp", "https://pg1-ai-agent.vercel.app/api/mcp", "https://presign-guard.onrender.com/mcp", "https://x402-doctor.onrender.com/mcp"]) {
  const j = run("node", ["bin/x402-doctor.js", "--json", url], "/tmp/d");
  try {
    const d = JSON.parse(j);
    console.log(`\n${url}\n  overall=${d.overall}; called: ${(d.mcp?.calls || []).map((c) => c.tool).join(", ") || "none"}`);
    for (const c of d.checks.filter((c) => c.group === "mcp")) console.log(`  ${c.status} ${c.id}: ${c.message.slice(0, 170)}`);
  } catch { console.log(url, "parse failed", j.slice(-300)); }
}
