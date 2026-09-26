// Final pay-skills check: wait for the last summary deploys, save the live specs (pretty-printed) next to
// our PAY.md drafts, and run pay.sh's checker on all three. Probes unpaid; nothing paid or submitted.
import { spawnSync } from "node:child_process";
import { cpSync, writeFileSync } from "node:fs";
const run = (cmd, args, cwd) => { const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 600000 }); return `exit ${r.status}\n${r.stdout}${r.stderr}`; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hosts = {
  "presign-guard": ["presign-guard.onrender.com", (s) => s.paths["/v1/check/explain"].post.summary.startsWith("Get ")],
  "ichimoku-signal": ["ichimoku-signal.onrender.com", (s) => s.paths["/scan"].get.summary.startsWith("Get ")],
  "x402-doctor": ["x402-doctor.onrender.com", () => true],
};
for (const [name, [host, ready]] of Object.entries(hosts)) {
  let spec;
  for (let i = 0; i < 30; i++) { spec = await (await fetch(`https://${host}/openapi.json`)).json(); if (ready(spec)) break; await sleep(20000); }
  console.log(`${name}: ${ready(spec) ? "new spec live" : "OLD SPEC"}`);
  writeFileSync(`research/pay-skills/providers/fizzl/${name}/openapi.json`, JSON.stringify(spec, null, 2) + "\n");
}
console.log(run("git", ["clone", "-q", "--depth", "1", "https://github.com/solana-foundation/pay-skills", "/tmp/pay-skills"]));
for (const name of Object.keys(hosts)) {
  cpSync(`research/pay-skills/providers/fizzl/${name}`, `/tmp/pay-skills/providers/fizzl/${name}`, { recursive: true });
  console.log(`\n===== pay catalog check fizzl/${name}`);
  console.log(run("npx", ["-y", "@solana/pay", "catalog", "check", `providers/fizzl/${name}/PAY.md`], "/tmp/pay-skills").replace(/\x1b\[[0-9;]*m/g, "").slice(-4000));
}
