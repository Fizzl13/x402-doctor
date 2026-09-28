// Research: wait for Doctor #86 to be live, then show the paywall and well-known checks on chekka's endpoint.
const target = 'https://crypto-sentiment-x402.onrender.com/sentiment/BTC';
for (let i = 0; i < 16; i++) {
  const r = await (await fetch('https://x402-doctor.fizzl.eu/api/diagnose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: target }) })).json();
  const pick = (id) => r.checks?.find((c) => c.id === id);
  const pw = pick('paywall');
  console.log(new Date().toISOString(), 'overall', r.overall, '| paywall', pw?.status, pw?.message, '| well-known', pick('well-known')?.status, pick('well-known')?.message, '| bazaar-listing', pick('bazaar-listing')?.status);
  if (pw?.status === 'fail') break;
  await new Promise((s) => setTimeout(s, 20000));
}
