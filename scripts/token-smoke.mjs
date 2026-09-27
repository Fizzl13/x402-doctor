// Register our four origins in agent402's seller index (no account, no email), with index status before and after.
const origins = ['https://x402-doctor.onrender.com', 'https://presign-guard.onrender.com', 'https://ichimoku-signal.onrender.com', 'https://smartcontractexplainer.onrender.com'];
const status = async (o) => { try { const r = await fetch(`https://agent402.tools/api/index?seller=${new URL(o).host}`, { headers: { accept: 'application/json' } }); return `${r.status} ${(await r.text()).slice(0, 400)}`; } catch (e) { return e.message; } };
for (const origin of origins) {
  console.log(`\n== ${origin}\nbefore: ${await status(origin)}`);
  const r = await fetch('https://agent402.tools/api/index/register', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ origin }) });
  console.log(`register: HTTP ${r.status} ${(await r.text()).slice(0, 1500)}`);
  await new Promise((res) => setTimeout(res, 3000));
  console.log(`after: ${await status(origin)}`);
}
