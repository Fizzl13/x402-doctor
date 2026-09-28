// Wait for the Ichimoku deploy, then check the live paywall text.
const H = { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (iPhone)' };
for (let i = 0; i < 30; i++) {
  const s = await (await fetch('https://ichimoku-signal.fizzl.eu/setups?interval=4h', { headers: H })).text();
  if (s.includes("<title>Today's top trade setups</title>")) {
    console.log('LIVE after', i * 20, 's');
    for (const u of ['/setups?interval=4h&pay=base', '/signal/BTC-USDT?interval=4h', '/signals/ETH-USDT', '/levels/SOL-USDT', '/scan']) {
      const h = await (await fetch('https://ichimoku-signal.fizzl.eu' + u, { headers: H })).text();
      console.log(u, '|', (h.match(/<title>[^<]*<\/title>/) || ['?'])[0], '| one-time:', h.includes('One-time payment'), '| old:', h.includes('To access this content'));
    }
    const r = await fetch('https://ichimoku-signal.fizzl.eu/setups?interval=4h', { headers: { accept: 'application/json' } });
    const c = JSON.parse(Buffer.from(r.headers.get('payment-required'), 'base64').toString());
    console.log('agent', r.status, c.resource.description.slice(0, 60));
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 20000));
}
console.log('not live after 10 min');
