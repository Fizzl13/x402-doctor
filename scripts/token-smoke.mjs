const H = { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (iPhone)' };
for (const u of ['/signal/BTC-USDT?interval=4h', '/signal/BTC-USDT', '/signal/ETH-USDT?interval=1h', '/signal/BTC-USDT?interval=4h']) {
  const r = await fetch('https://ichimoku-signal.fizzl.eu' + u, { headers: H });
  const h = await r.text();
  const cfg = (h.match(/paymentRequired: (\{.*\}),\n/) || [])[1];
  let desc = ''; try { desc = JSON.parse(cfg).resource.description.slice(0, 70); } catch {}
  console.log(u, r.status, h.length, (h.match(/<title>[^<]*<\/title>/) || ['?'])[0], 'one-time', h.includes('One-time payment'), 'wallet-btns', h.includes('open-in-wallet'), '| desc:', desc, '| cache:', r.headers.get('cf-cache-status'), r.headers.get('age'), r.headers.get('x-render-origin-server'));
}
