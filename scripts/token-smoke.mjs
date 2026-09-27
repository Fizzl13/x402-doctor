// Live check: presign-guard's signing page for Doctor (?service=x402-doctor). Unpaid GETs only.
const base = "https://presign-guard.onrender.com";
for (let round = 0; round < 16; round++) {
  const page = await fetch(`${base}/sign-receipt-key?service=x402-doctor`).then(async (r) => ({ status: r.status, text: await r.text() })).catch((e) => ({ status: String(e), text: "" }));
  const service = (page.text.match(/const SERVICE = "([^"]*)"/) || [])[1];
  console.log(`round ${round}: page ${page.status}, service ${service}`);
  if (service === "x402-doctor") {
    console.log(JSON.stringify(await fetch(`${base}/sign-receipt-key/x402-doctor-signer.json`).then((r) => r.json())));
    console.log(JSON.stringify(await fetch(`${base}/sign-receipt-key/presign-guard-signer.json`).then((r) => r.json())));
    break;
  }
  await new Promise((r) => setTimeout(r, 30000));
}
