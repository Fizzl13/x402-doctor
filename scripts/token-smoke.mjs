// presign-guard: wait until the signer is published (signing: true) after the restart. Free, read-only.
const B = "https://presign-guard.onrender.com";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 56; i++) {
  const r = await fetch(`${B}/.well-known/presign-guard-signer.json`).catch(() => null);
  const d = r && r.ok ? await r.json().catch(() => null) : null;
  console.log(new Date().toISOString(), r && r.status, d && JSON.stringify({ signing: d.signing, signers: d.signers }));
  if (d && d.signing) break;
  await wait(15000);
}
