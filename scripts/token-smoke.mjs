// The site-scan check (work branch) on live endpoints. Never pays.
import { spawnSync } from "node:child_process";
const run = (cmd, args, cwd) => { const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 300000 }); return `${r.stdout}${r.stderr}`; };
run("git", ["clone", "-q", "--depth", "1", "-b", "claude/x402-agents-solana-payments-nceg9b", "https://github.com/Fizzl13/x402-doctor", "/tmp/d"]);
run("npm", ["ci", "--silent", "--no-audit", "--no-fund"], "/tmp/d");
for (const url of ["https://pg1-ai-agent.vercel.app/api/mcp", "https://ichimoku-signal.onrender.com/signal/BTC-USDT", "https://presign-guard.onrender.com/mcp"]) {
  const j = run("node", ["bin/x402-doctor.js", "--json", url], "/tmp/d");
  try {
    const d = JSON.parse(j);
    const c = d.checks.find((x) => x.id === "metamask-site-scan");
    console.log(`\n${url}\n  overall=${d.overall}\n  ${c ? `${c.status}: ${c.message}` : "no metamask-site-scan check"}`);
  } catch { console.log(url, "parse failed", j.slice(-300)); }
}
