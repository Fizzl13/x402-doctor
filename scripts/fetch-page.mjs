// One-off: Ichimoku routes in the CDP Bazaar, and do the live 402s pass the x402 schema?
import { createRequire } from 'module';
const require = createRequire(new URL('../doctor/package.json', import.meta.url));
const { parsePaymentRequired } = require('@x402/core/schemas');
for (const route of ['signal', 'signals', 'levels']) {
  const r = await fetch(`https://ichimoku-signal.onrender.com/${route}/BTC-USDT?interval=4h`);
  const c = JSON.parse(Buffer.from(r.headers.get('payment-required') || 'e30=', 'base64').toString());
  const p = parsePaymentRequired(c);
  console.log(`${route}: HTTP ${r.status}, tags ${(c.resource && c.resource.tags || []).length}, schema ${p.success ? 'ok' : JSON.stringify(p.error.issues)}`);
}
const hits = [];
let total = 0;
for (let offset = 0; offset < 40000; offset += 500) {
  const res = await fetch(`https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?type=http&limit=500&offset=${offset}`);
  if (!res.ok) break;
  const items = (await res.json()).items || [];
  total += items.length;
  for (const it of items) if (String(it.resource || '').includes('ichimoku-signal.onrender.com')) hits.push(`${it.resource}  lastUpdated=${it.lastUpdated}`);
  if (items.length < 500) break;
}
console.log(`catalog ${total}, ichimoku entries: ${hits.length}`);
for (const h of hits) console.log('  ' + h);
