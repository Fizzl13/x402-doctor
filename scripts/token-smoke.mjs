// Wait for the Ichimoku deploy, then check the live paywall's wallet buttons.
const H = { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (iPhone)' };
for (let i = 0; i < 30; i++) {
  const sol = await (await fetch('https://ichimoku-signal.fizzl.eu/setups?interval=4h', { headers: H })).text();
  if (sol.includes('open-in-wallet')) {
    const base = await (await fetch('https://ichimoku-signal.fizzl.eu/setups?interval=4h&pay=base', { headers: H })).text();
    const links = (s) => [...s.matchAll(/href="(https:\/\/(?:phantom\.app|solflare\.com|go\.cb-w\.com|metamask\.app\.link)[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
    console.log('LIVE after', i * 20, 's');
    console.log(links(sol).join('\n'));
    console.log(links(base).join('\n'));
    const r = await fetch('https://ichimoku-signal.fizzl.eu/setups?interval=4h', { headers: { accept: 'application/json' } });
    console.log('agent 402 still:', r.status, !!r.headers.get('payment-required'));
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 20000));
}
console.log('not live after 10 min');
