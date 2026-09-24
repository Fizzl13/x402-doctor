// One-off: is PlainText's "Paste your own" tab live, and does /api/explain still answer 402?
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SITE = 'https://smartcontractexplainer.onrender.com';
for (let i = 0; i < 16; i++) {
  const html = await (await fetch(SITE + '/', { headers: { 'cache-control': 'no-cache' } })).text();
  if (html.includes('id="panel-paste"')) {
    console.log('PASTE TAB LIVE');
    const empty = await fetch(SITE + '/api/explain', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    console.log('empty body:', empty.status, empty.headers.get('payment-required') ? 'with payment-required header' : '');
    const big = await fetch(SITE + '/api/explain', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: 'x'.repeat(6000) }) });
    console.log('oversized:', big.status, await big.text());
    process.exit(empty.status === 402 && big.status === 413 ? 0 : 1);
  }
  console.log(`attempt ${i + 1}: old page`);
  await wait(30000);
}
process.exit(1);
