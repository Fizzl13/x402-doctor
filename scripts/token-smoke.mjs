// Re-validate our pay-skills drafts with pay.sh's checker, full output (probes endpoints unpaid; nothing paid or submitted).
import { spawnSync } from "node:child_process";
import { cpSync, writeFileSync } from "node:fs";
const run = (cmd, args, cwd) => { const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 600000 }); return `exit ${r.status}\n${r.stdout}${r.stderr}`; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
console.log(run("git", ["clone", "-q", "--depth", "1", "https://github.com/solana-foundation/pay-skills", "/tmp/pay-skills"]));
const hosts = { "presign-guard": "presign-guard.onrender.com", "ichimoku-signal": "ichimoku-signal.onrender.com", "x402-doctor": "x402-doctor.onrender.com" };
for (const [name, host] of Object.entries(hosts)) {
  let spec;
  for (let i = 0; i < 30; i++) { // wait for the deploy with the short summaries
    spec = await (await fetch(`https://${host}/openapi.json`)).json();
    const long = Object.values(spec.paths).flatMap((o) => Object.values(o)).filter((op) => op.summary?.length > 63);
    if (!long.length) break;
    await sleep(20000);
  }
  const dir = `/tmp/pay-skills/providers/fizzl/${name}`;
  cpSync(`research/pay-skills/providers/fizzl/${name}`, dir, { recursive: true });
  writeFileSync(`${dir}/openapi.json`, JSON.stringify(spec, null, 2) + "\n");
}
for (const name of Object.keys(hosts)) {
  console.log(`\n===== pay catalog check fizzl/${name}`);
  console.log(run("npx", ["-y", "@solana/pay", "catalog", "check", `providers/fizzl/${name}/PAY.md`], "/tmp/pay-skills").replace(/\x1b\[[0-9;]*m/g, "").slice(-7000));
}
