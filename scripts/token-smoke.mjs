// PlainText: what do its live 402 answers look like to a prober (GET and POST, header vs body)? Nothing paid.
const B = 'https://smartcontractexplainer.onrender.com';
const dec = (h) => { try { return JSON.parse(Buffer.from(h, 'base64').toString('utf8')); } catch (e) { return { undecodable: String(e) }; } };
for (const path of ['/api/check-wallet', '/api/explain']) {
  for (const [method, body] of [['GET', undefined], ['POST', undefined], ['POST', '{}']]) {
    const t0 = Date.now();
    const r = await fetch(B + path, { method, headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body, signal: AbortSignal.timeout(90000) }).catch((e) => ({ status: 0, err: e.message }));
    const ms = Date.now() - t0;
    const text = r.text ? await r.text() : '';
    let j = null; try { j = JSON.parse(text); } catch {}
    const h = r.headers?.get('payment-required');
    const hd = h ? dec(h) : null;
    console.log(`\n${method} ${path}${body ? ' {}' : ''} → ${r.status} ${ms}ms ct=${r.headers?.get('content-type')}`);
    console.log('  header keys:', hd ? Object.keys(hd).join(',') : 'none', '| x402Version', hd?.x402Version, '| accepts', hd?.accepts?.length, '| resource', JSON.stringify(hd?.resource)?.slice(0, 160));
    console.log('  body keys  :', j ? Object.keys(j).join(',') : text.slice(0, 120).replace(/\s+/g, ' '), '| body.resource == header.resource:', JSON.stringify(j?.resource) === JSON.stringify(hd?.resource));
    if (hd?.accepts) for (const a of hd.accepts) console.log('   accept', a.scheme, a.network, a.amount, a.asset?.slice(0, 10), a.payTo?.slice(0, 10), 'maxTimeout', a.maxTimeoutSeconds, 'extra', JSON.stringify(a.extra));
  }
}
