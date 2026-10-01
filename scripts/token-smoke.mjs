// One-off: live check of the new PlainText (prices, free checks, verdict source). Read-only, never pays. Output is data only. Run 2026-10-01T1035Z.
await new Promise((r) => setTimeout(r, 420000)); // let Render deploy
const UA = { 'user-agent': 'fizzl-monitor/1.0' };
const P = 'https://plaintext.fizzl.eu';
for (const [route, body] of [['/api/check-wallet', { address: '0x000000000022D473030F116dDEE9F6B43aC78BA3', chain: 'base' }], ['/api/explain', { data: { chainId: 8453, token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', spender: '0x000000000022D473030F116dDEE9F6B43aC78BA3', amount: '1000000' } }]]) {
  const r = await fetch(P + route, { method: 'POST', headers: { 'content-type': 'application/json', ...UA }, body: JSON.stringify(body) });
  let amt = '-'; const h = r.headers.get('payment-required');
  if (h) amt = JSON.parse(Buffer.from(h, 'base64').toString()).accepts.map((a) => `${a.network.split(':')[0]} ${a.amount}`).join(', ');
  console.log(`PAID ${route} ${r.status} ${amt}`);
}
console.log('QUOTA', await (await fetch(P + '/api/free/quota', { headers: UA })).text());
const t = Date.now();
const r = await fetch(P + '/api/free/explain', { method: 'POST', headers: { 'content-type': 'application/json', ...UA }, body: JSON.stringify({ data: { chainId: 8453, token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', spender: '0x000000000022D473030F116dDEE9F6B43aC78BA3', amount: '1000000' } }) });
const b = await r.json().catch(() => ({}));
console.log(`FREE explain ${r.status} ${Date.now() - t}ms source=${b.source} verdict=${b.verdict} reasons=${JSON.stringify((b.reasons || []).map((x) => x.code))} receipt=${Boolean(b.receipt)} left=${b.free_left} | ${String(b.explanation || b.error || '').slice(0, 300)}`);
const page = await (await fetch(P + '/', { headers: { accept: 'text/html', ...UA } })).text();
console.log('PAGE free button', page.includes('checkWalletFreeBtn'), '| $0.04', page.includes('$0.04'));
