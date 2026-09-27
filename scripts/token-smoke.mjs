// x402 Doctor after #60: wait for the deploy and for signing to switch on. Free, read-only.
const B = "https://x402-doctor.onrender.com";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let last;
for (let i = 0; i < 56; i++) {
  const r = await fetch(`${B}/.well-known/x402-doctor-signer.json`).catch(() => null);
  const d = r && r.ok ? await r.json().catch(() => null) : null;
  const line = `${r && r.status} ${d ? JSON.stringify({ signing: d.signing, signers: d.signers }) : ""}`;
  if (line !== last) console.log(new Date().toISOString(), line);
  last = line;
  if (d && d.signing) break;
  await wait(15000);
}
const spec = await (await fetch(`${B}/openapi.json`)).json();
console.log("openapi", spec.info.version, "receipt on preflight:", Boolean(spec.paths["/api/v1/preflight"].get.responses[200].content["application/json"].schema.properties.receipt));
