// One-off: x402 Doctor diagnosis of a public endpoint, run from the library.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createSafeFetch } = require('../doctor/lib/safe-fetch');
const diagnoseLib = require('../doctor/lib/diagnose');
const target = 'https://pay.edge-agents.ai/v1/services/usdc-supply-pulse';
for (const method of ['GET', 'POST']) {
  const report = await diagnoseLib.diagnose(target, { safeFetch: createSafeFetch({}), method }).catch((e) => ({ error: e.message }));
  console.log(`\n===== ${method}: overall=${report.overall}`);
  for (const c of report.checks || []) console.log(`${String(c.status).padEnd(5)} ${c.id || c.name}: ${c.message || c.detail || ''}`.slice(0, 400));
  if (report.error) console.log(report.error);
}
const raw = await fetch(target);
console.log('\nRAW GET', raw.status, JSON.stringify([...raw.headers].filter(([k]) => /payment|content-type/i.test(k))).slice(0, 600));
console.log((await raw.text()).slice(0, 1200));
