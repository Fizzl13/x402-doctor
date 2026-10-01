// One-off: PlainText heavy-wallet check after #33 / presign-guard #75. Never pays.
const UA = { 'user-agent': 'fizzl-monitor/1.0', 'content-type': 'application/json' };
for (const address of ['0x1111111254eeb25477b68fb85ed929f73a960582']) {
  const t = Date.now();
  const w = await (await fetch('https://plaintext.fizzl.eu/api/free/check-wallet', { method: 'POST', headers: UA, body: JSON.stringify({ address, chain: 'base' }) })).json();
  console.log('WALLET', address.slice(0, 8), `${((Date.now() - t) / 1000).toFixed(1)}s`, w.source, w.verdict, 'grade=' + w.grade, 'approvals=' + (w.raw || []).length, 'reasons=' + JSON.stringify((w.reasons || []).map((x) => x.code)), 'receipt=' + !!w.receipt, 'err=' + (w.error || ''));
}
