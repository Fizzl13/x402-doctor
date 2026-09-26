// Validate our pay-skills drafts with pay.sh's own checker (probes endpoints unpaid; nothing is paid or submitted).
import { execSync } from "node:child_process";
import { cpSync, writeFileSync } from "node:fs";
const sh = (c, opts = {}) => { try { return execSync(c, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600000, ...opts }); } catch (e) { return `EXIT ${e.status}\n${e.stdout || ""}\n${e.stderr || ""}`; } };
console.log(sh("git clone -q --depth 1 https://github.com/solana-foundation/pay-skills /tmp/pay-skills && echo cloned"));
const hosts = { "presign-guard": "presign-guard.onrender.com", "ichimoku-signal": "ichimoku-signal.onrender.com", "x402-doctor": "x402-doctor.onrender.com" };
for (const [name, host] of Object.entries(hosts)) {
  const dir = `/tmp/pay-skills/providers/fizzl/${name}`;
  cpSync(`research/pay-skills/providers/fizzl/${name}`, dir, { recursive: true });
  const spec = await (await fetch(`https://${host}/openapi.json`)).text();
  writeFileSync(`${dir}/openapi.json`, spec);
  const j = JSON.parse(spec);
  console.log(`\n${name}: openapi ${j.openapi} paths: ${Object.keys(j.paths || {}).join(", ")}`);
}
console.log(sh("npx -y @solana/pay --version"));
for (const name of Object.keys(hosts)) {
  console.log(`\n===== pay catalog check fizzl/${name}`);
  console.log(sh(`npx -y @solana/pay catalog check providers/fizzl/${name}/PAY.md`, { cwd: "/tmp/pay-skills" }).slice(-6000));
}
