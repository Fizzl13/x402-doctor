// pay catalog check on the updated ichimoku-signal draft (new /setups, /signals $0.15, /scan $0.10).
// Probes unpaid; nothing paid or submitted.
import { spawnSync } from "node:child_process";
import { cpSync } from "node:fs";
const run = (cmd, args, cwd) => { const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 600000 }); return `exit ${r.status}\n${r.stdout}${r.stderr}`; };
console.log(run("git", ["clone", "-q", "--depth", "1", "https://github.com/solana-foundation/pay-skills", "/tmp/pay-skills"]));
for (const name of ["ichimoku-signal"]) {
  cpSync(`research/pay-skills/providers/fizzl/${name}`, `/tmp/pay-skills/providers/fizzl/${name}`, { recursive: true });
  console.log(`\n===== pay catalog check fizzl/${name}`);
  console.log(run("npx", ["-y", "@solana/pay", "catalog", "check", `providers/fizzl/${name}/PAY.md`], "/tmp/pay-skills").replace(/\x1b\[[0-9;]*m/g, "").slice(-4000));
}
