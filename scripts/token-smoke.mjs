// Run 2 (after key). Wait for the Render restart first.
await new Promise((r) => setTimeout(r, 120000));
// One-off: PlainText live check after #30 (prices, free routes, presign-guard verdicts). Never pays.
const B = 'https://plaintext.fizzl.eu';
const UA = { 'user-agent': 'fizzl-monitor/1.0', 'content-type': 'application/json' };
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t.slice(0, 300); } };
const amounts = async (path) => {
  const r = await fetch(B + path, { method: 'POST', headers: UA, body: '{}' });
  const hdr = r.headers.get('payment-required');
  let acc = [];
  try { acc = JSON.parse(Buffer.from(hdr, 'base64').toString()).accepts || []; } catch {}
  if (!acc.length) { const b = await j(r); acc = (b && b.accepts) || []; }
  console.log('PAID', path, r.status, acc.map((a) => `${String(a.network).split(':')[0]} ${a.amount || a.maxAmountRequired}`).join(', '));
};
await amounts('/api/check-wallet');
await amounts('/api/explain');
console.log('QUOTA', JSON.stringify(await j(await fetch(B + '/api/free/quota', { headers: UA }))));
const show = (label, b) => console.log(label, typeof b === 'string' ? b : JSON.stringify({ source: b.source, verdict: b.verdict, reasons: (b.reasons || []).map((x) => `${x.code}:${x.severity}`), receipt: !!b.receipt, left: b.free_left, err: b.error, summary: String(b.summary || b.explanation || '').slice(0, 160) }));
// Unlimited USDC approval on Base to a random EOA spender — should hit presign-guard /v1/approvals.
const approval = { chainId: 8453, token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', spender: '0x1111111111111111111111111111111111111112', amount: '115792089237316195423570985008687907853269984665640564039457584007913129639935' };
show('FREE explain approval', await j(await fetch(B + '/api/free/explain', { method: 'POST', headers: UA, body: JSON.stringify({ data: approval }) })));
show('FREE check-wallet USDC', await j(await fetch(B + '/api/free/check-wallet', { method: 'POST', headers: UA, body: JSON.stringify({ address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', chain: 'base' }) })));
const page = await (await fetch(B + '/', { headers: UA })).text();
console.log('PAGE free button', /Explain free/.test(page), '| $0.04', page.includes('$0.04'), '| $0.03', page.includes('$0.03'));
