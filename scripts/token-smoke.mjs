// One-off: rate the rest of our paid descriptions (Doctor web check allows 10 a minute).
const UA = { 'user-agent': 'fizzl-monitor/1.0' };
const list = [
  ['https://presign-guard.fizzl.eu/v1/check', 'POST'], ['https://presign-guard.fizzl.eu/v1/check/explain', 'POST'],
  ['https://presign-guard.fizzl.eu/v1/token?chain=base&address=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'], ['https://presign-guard.fizzl.eu/v1/approvals?chain=base&address=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'],
  ['https://ichimoku-signal.fizzl.eu/signal/BTC-USDT'], ['https://ichimoku-signal.fizzl.eu/signals/BTC-USDT'], ['https://ichimoku-signal.fizzl.eu/levels/BTC-USDT'],
  ['https://ichimoku-signal.fizzl.eu/scan'], ['https://ichimoku-signal.fizzl.eu/setups'],
  ['https://plaintext.fizzl.eu/api/check-wallet', 'POST'], ['https://plaintext.fizzl.eu/api/explain', 'POST'],
];
for (const [url, method] of list) {
  let desc = '';
  try { const pr = await fetch(url, { method: method || 'GET', headers: { ...UA, accept: 'application/json', 'content-type': 'application/json' }, ...(method ? { body: '{}' } : {}), signal: AbortSignal.timeout(60000) }); const hd = pr.headers.get('payment-required'); const ch = hd ? JSON.parse(Buffer.from(hd, 'base64').toString()) : await pr.json(); desc = ch.resource?.description ?? ch.accepts?.[0]?.description ?? ''; } catch (e) { desc = `ERR ${e.message}`; }
  let check = '';
  try { const d = await (await fetch('https://x402-doctor.fizzl.eu/api/diagnose', { method: 'POST', headers: { 'content-type': 'application/json', ...UA }, body: JSON.stringify({ url, ...(method ? { method } : {}) }), signal: AbortSignal.timeout(90000) })).json(); const c = (d.checks || []).find((x) => x.id === 'description-quality'); check = c ? JSON.stringify({ status: c.status, rating: c.rating, hint: c.hint }) : `none (${d.error || d.overall})`; } catch (e) { check = `ERR ${e.message}`; }
  console.log(`DESC ${url}\n  check: ${check}\n  desc: ${desc}`);
  await new Promise((r) => setTimeout(r, 8000));
}
