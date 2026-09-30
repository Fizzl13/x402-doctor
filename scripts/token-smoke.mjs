// One-off check: presign-guard signer info (read-only). Output is data only.
for (const u of ['https://presign-guard.fizzl.eu/.well-known/presign-guard-signer.json', 'https://x402-doctor.fizzl.eu/.well-known/x402-doctor-signer.json']) {
  const r = await fetch(u); console.log(u, r.status, (await r.text()).slice(0, 1500));
}
