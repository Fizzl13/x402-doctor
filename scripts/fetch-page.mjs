// One-off: Ichimoku top-100 live after the deploy (free trend for coins beyond Binance.US, 402 for the paid route).
const SITE = 'https://ichimoku-signal.onrender.com';
for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(`${SITE}/api/trend/BTC-USDT`, { signal: AbortSignal.timeout(90000) });
    const b = await r.json();
    console.log(`wait ${i}: ${r.status} exchange=${b.exchange}`);
    if (b.exchange) break;
  } catch (e) { console.log(`wait ${i}: ${e.message}`); }
  await new Promise((r) => setTimeout(r, 15000));
}
for (const pair of ['BTC-USDT', 'TAO-USDT', 'XMR-USDT', 'KAS-USDT', 'LEO-USDT']) {
  const r = await fetch(`${SITE}/api/trend/${pair}`);
  console.log(`trend ${pair}: ${r.status} ${await r.text()}`);
}
for (const [path, want] of [['/signal/TAO-USDT?interval=2h', 402], ['/signal/TAO-USDT?interval=1M', 400], ['/signal/NOPE-USDT', 404], ['/signal/:PAIR', 400]]) {
  const r = await fetch(SITE + path, { headers: { accept: 'application/json' } });
  console.log(`${path}: ${r.status} (want ${want}) ${(await r.text()).slice(0, 160)}`);
}
