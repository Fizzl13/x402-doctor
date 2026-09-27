// Live check after RECEIPT_SIGNER_CERT (round 2): signing pages and well-known signer files.
// Unpaid GETs only.
const base = { "presign-guard": "https://presign-guard.onrender.com", "x402-doctor": "https://x402-doctor.onrender.com" };
for (let round = 0; round < 20; round++) {
  let ready = true;
  for (const [svc, url] of Object.entries(base)) {
    const page = await fetch(`${url}/sign-receipt-key`).then(async (r) => ({ status: r.status, text: await r.text() })).catch((e) => ({ status: String(e) }));
    const wk = await fetch(`${url}/.well-known/${svc}-signer.json`).then((r) => r.json()).catch((e) => ({ error: String(e) }));
    console.log(`round ${round} ${svc}: page ${page.status} ${page.text ? `(has service: ${page.text.includes(`"${svc}"`)}, placeholders left: ${/\{\{/.test(page.text)})` : ""}`);
    console.log(JSON.stringify({ signing: wk.signing, authority: wk.authority, certificate: wk.certificate, signers: wk.signers, certificate_format: wk.certificate_format }));
    if (page.status !== 200 || !wk.certificate) ready = false;
  }
  if (ready) break;
  await new Promise((r) => setTimeout(r, 30000));
}
