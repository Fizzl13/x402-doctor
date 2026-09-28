// Wait for the plainer homepage wording to go live.
for (let i = 0; i < 30; i++) {
  const h = await (await fetch('https://ichimoku-signal.fizzl.eu/', { headers: { accept: 'text/html' } })).text();
  if (h.includes('for your agent or in your browser')) {
    const checks = { 'coin buttons': h.includes('<span class="coin">BTC</span>: entry, stop and targets: $0.05'), 'top 10': h.includes('Top 10 trade setups today: $0.50'), 'scan': h.includes('All 148 coins, strongest first: $0.10'), 'plain trend words': h.includes("'Price above the cloud (uptrend)'"), 'R explained': h.includes('R measures the result'), 'for developers': h.includes('For developers: how agents use it'), 'wallets in details': h.includes('Phantom or Solflare (Solana)'), 'no placeholders': !/\{\{[A-Z_]+\}\}/.test(h) };
    console.log('LIVE after', i * 20, 's', JSON.stringify(checks));
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 20000));
}
console.log('not live after 10 min');
