// Register the fizzl.eu origins in agent402's seller index (no account, no email).
const origins = ['https://x402-doctor.fizzl.eu', 'https://presign-guard.fizzl.eu', 'https://ichimoku-signal.fizzl.eu', 'https://plaintext.fizzl.eu'];
for (const origin of origins) {
  const r = await fetch('https://agent402.tools/api/index/register', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ origin }) });
  console.log(`${origin}: HTTP ${r.status} ${(await r.text()).slice(0, 400)}`);
  await new Promise((res) => setTimeout(res, 2000));
}
