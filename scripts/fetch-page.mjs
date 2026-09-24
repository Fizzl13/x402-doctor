// One-off: which facilitator settles Solana for Ichimoku and the Doctor?
const j = async (u, h = {}) => { const r = await fetch(u, { headers: { accept: 'application/json', ...h } }); return [r, await r.text()]; };
const [, ih] = await j('https://ichimoku-signal.onrender.com/');
try { const h = JSON.parse(ih); console.log('ichimoku health payment:', JSON.stringify(h.payment || h).slice(0, 600)); } catch { console.log('ichimoku / not json:', ih.slice(0, 200)); }
const [, dh] = await j('https://x402-doctor.onrender.com/api/health');
console.log('doctor health:', dh.slice(0, 600));
const feePayer = async (u) => { const r = await fetch(u); const pr = r.headers.get('payment-required'); if (!pr) return `HTTP ${r.status}, no challenge`; const c = JSON.parse(Buffer.from(pr, 'base64').toString()); return c.accepts.filter((a) => a.network.startsWith('solana')).map((a) => a.extra && a.extra.feePayer).join(','); };
console.log('ichimoku solana feePayer:', await feePayer('https://ichimoku-signal.onrender.com/signal/BTC-USDT'));
console.log('doctor solana feePayer:', await feePayer('https://x402-doctor.onrender.com/api/v1/diagnose?url=https://example.com'));
const [, ps] = await j('https://facilitator.payai.network/supported');
try { console.log('payai solana signers:', JSON.stringify(JSON.parse(ps).signers?.['solana:*'] || JSON.parse(ps).kinds.filter((k) => k.network.startsWith('solana')).map((k) => k.extra))); } catch { console.log('payai supported:', ps.slice(0, 300)); }
