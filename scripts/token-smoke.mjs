// Wait for the "What you get" block, then check the live preview data that fills row 1.
for (let i = 0; i < 30; i++) {
  const h = await (await fetch('https://ichimoku-signal.fizzl.eu/', { headers: { accept: 'text/html' } })).text();
  if (h.includes('What you get for $0.50') && h.includes('id="sample-row"')) {
    console.log('LIVE after', i * 20, 's; price placeholder filled:', !h.includes('{{SETUPS_PRICE}}'));
    const p = await (await fetch('https://ichimoku-signal.fizzl.eu/setups/preview')).json();
    const s = p.setup;
    console.log('row 1 will show:', s ? [s.pair.replace('-USDT', ''), s.direction, s.entry, s.stop, s.target_1, s.target_2, s.risk_reward_1].join(' | ') : 'no setup (row stays blurred)');
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 20000));
}
console.log('not live after 10 min');
