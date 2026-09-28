// Wait for the homepage reorder to go live.
for (let i = 0; i < 30; i++) {
  const h = await (await fetch('https://ichimoku-signal.fizzl.eu/', { headers: { accept: 'text/html' } })).text();
  const p = h.indexOf("Yesterday's #1 trade setup"), v = h.indexOf('Trade setups and the whole suite'), f = h.indexOf('<footer>');
  if (p > 0 && p < v) { console.log('LIVE after', i * 20, 's; preview before video:', p < v, 'before footer:', p < f); process.exit(0); }
  await new Promise((r) => setTimeout(r, 20000));
}
console.log('not live after 10 min');
