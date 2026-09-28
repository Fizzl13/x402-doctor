// Before the Bazaar refresh calls: does each fizzl.eu route's 402 advertise the fizzl.eu resource URL, a Bazaar extension, and what price?
const urls = [
  'https://x402-doctor.fizzl.eu/api/v1/diagnose?url=https://ichimoku-signal.fizzl.eu/signal/BTC-USDT',
  'https://presign-guard.fizzl.eu/v1/token?chain=base&address=0x940181a94A35A4569E4529A3CDfB74e38FD98631',
  'https://ichimoku-signal.fizzl.eu/signal/BTC-USDT',
  'https://plaintext.fizzl.eu/api/check-wallet',
];
for (const u of urls) {
  const r = await fetch(u, { method: u.includes('plaintext') ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: u.includes('plaintext') ? '{}' : undefined });
  const pr = r.headers.get('payment-required');
  const c = pr ? JSON.parse(Buffer.from(pr, 'base64').toString('utf8')) : null;
  console.log(`\n== ${u}\n  ${r.status} resource.url=${c?.resource?.url} bazaar=${Boolean(c?.extensions?.bazaar)} accepts=${JSON.stringify((c?.accepts || []).map((a) => `${a.network}:${a.amount}`))}`);
}
