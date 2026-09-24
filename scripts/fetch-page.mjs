// One-off: is the new PlainText payment-error code live?
for (let i = 0; i < 10; i++) {
  const html = await (await fetch('https://smartcontractexplainer.onrender.com/', { headers: { 'cache-control': 'no-cache' } })).text();
  const live = html.includes('function paymentErrorMessage') && html.includes('async function usdcBalance');
  console.log(`attempt ${i + 1}: ${live ? 'NEW CODE LIVE' : 'old page'} (${html.length} bytes)`);
  if (live) process.exit(0);
  await new Promise((r) => setTimeout(r, 30000));
}
process.exit(1);
