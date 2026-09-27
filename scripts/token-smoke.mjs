// Live check: both services' signer certificates. Unpaid GETs only.
for (const [svc, url] of [["presign-guard", "https://presign-guard.onrender.com"], ["x402-doctor", "https://x402-doctor.onrender.com"]]) {
  const d = await fetch(`${url}/.well-known/${svc}-signer.json`).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  console.log(svc, JSON.stringify({ signing: d.signing, signers: d.signers, certificate: d.certificate }));
}
