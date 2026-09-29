// Price probe: the live 402 prices of the fizzl services (read-only, never pays). Output is data only.
const amt = (h) => { try { return JSON.parse(Buffer.from(h, 'base64').toString()).accepts.map((a) => `${a.network.slice(0, 8)} $${Number(a.amount) / 1e6}`).join(' | '); } catch { return 'UNREADABLE'; } };
const probe = async (url, method = 'GET') => {
  try {
    const r = await fetch(url, { method, headers: { accept: 'application/json', 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined, signal: AbortSignal.timeout(60000) });
    const h = r.headers.get('payment-required');
    console.log(`PRICE ${method} ${url} -> ${r.status} ${h ? amt(h) : '-'}`);
  } catch (e) { console.log(`PRICE ${url} ERR ${e.message}`); }
};
const I = 'https://ichimoku-signal.fizzl.eu';
for (const p of ['/signal/BTC-USDT', '/signals/BTC-USDT', '/levels/BTC-USDT', '/scan?interval=4h', '/setups?interval=4h']) await probe(I + p);
await probe('https://plaintext.fizzl.eu/api/check-wallet', 'POST');
await probe('https://plaintext.fizzl.eu/api/explain', 'POST');
for (const base of ['https://presign-guard.fizzl.eu', 'https://x402-doctor.fizzl.eu']) {
  try {
    const spec = await (await fetch(`${base}/openapi.json`, { signal: AbortSignal.timeout(30000) })).json();
    for (const [path, ops] of Object.entries(spec.paths || {})) for (const [m, op] of Object.entries(ops)) {
      const pi = op['x-payment-info'] || op['x-x402'] || op['x-price'];
      if (pi) console.log(`SPEC ${base} ${m.toUpperCase()} ${path} ${JSON.stringify(pi).slice(0, 160)}`);
    }
  } catch (e) { console.log(`SPEC ${base} ERR ${e.message}`); }
}
