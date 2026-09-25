// One-off: is /scan live, does its 402 pass the x402 schema, and is it in the CDP Bazaar?
import { createRequire } from 'module';
const require = createRequire(new URL('../doctor/package.json', import.meta.url));
const { parsePaymentRequired } = require('@x402/core/schemas');
const O = 'https://ichimoku-signal.onrender.com';
const status = await (await fetch(`${O}/`)).json();
console.log('status:', JSON.stringify({ scan: status.scan, price: status.payment && status.payment.scan }));
const r = await fetch(`${O}/scan?interval=1d`);
const c = JSON.parse(Buffer.from(r.headers.get('payment-required') || 'e30=', 'base64').toString());
const p = parsePaymentRequired(c);
console.log(`/scan: HTTP ${r.status}, amounts ${(c.accepts || []).map((a) => a.amount).join('/')}, tags ${(c.resource && c.resource.tags || []).length}, schema ${p.success ? 'ok' : JSON.stringify(p.error.issues)}`);
const html = await (await fetch(`${O}/scan?interval=4x`, { headers: { accept: 'text/html' } })).text();
console.log('error page:', /Check the link/.test(html) ? 'readable page' : html.slice(0, 80));
const hits = [];
for (let offset = 0; offset < 40000; offset += 500) {
  const res = await fetch(`https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?type=http&limit=500&offset=${offset}`);
  if (!res.ok) break;
  const items = (await res.json()).items || [];
  for (const it of items) if (String(it.resource || '').includes('ichimoku-signal.onrender.com')) hits.push(`${it.resource}  lastUpdated=${it.lastUpdated}`);
  if (items.length < 500) break;
}
console.log('Bazaar:\n' + hits.join('\n'));
