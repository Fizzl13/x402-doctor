// One-off: x402 Doctor + fix engine on pg1-ai-agent after the opt-in free tier change.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { diagnose } = require('../doctor/lib/diagnose.js');
const { createSafeFetch } = require('../doctor/lib/safe-fetch.js');
const { buildFixes } = require('../doctor/lib/recipes.js');
const safeFetch = createSafeFetch({});
for (const [url, method] of [['https://pg1-ai-agent.vercel.app/api/mcp', 'POST'], ['https://pg1-ai-agent.vercel.app/api/ioc', 'GET']]) {
  const report = await diagnose(url, { safeFetch, method });
  console.log(`\n=================== ${method} ${url}\nOVERALL ${report.overall}`);
  for (const c of report.checks) console.log(`  [${c.status}] ${c.id}: ${c.message}${c.hint && c.status !== 'pass' ? `\n        → ${c.hint}` : ''}`);
  if (report.challenge) console.log('challenge:', JSON.stringify(report.challenge).slice(0, 1500));
  console.log('probes:', JSON.stringify(report.probes));
  const out = buildFixes(report);
  console.log(`FIXES: ${out.summary} (${out.stack.name}, ${out.stack.detected_from})`);
  for (const f of out.fixes) {
    console.log(`\n## [${f.severity}] ${f.title}  (${f.checks.join(', ')})\n${f.why}\n- ${f.steps.join('\n- ')}`);
    for (const c of f.code) console.log(`--- ${c.label} (${c.stack})\n${c.snippet}`);
  }
  if (out.unfixed.length) console.log('unfixed:', JSON.stringify(out.unfixed));
}
// With the opt-in header: does the free tier still answer?
const r = await fetch('https://pg1-ai-agent.vercel.app/api/ioc?limit=1', { headers: { 'x-free-tier': '1' } });
console.log(`\nGET /api/ioc with x-free-tier: 1 -> ${r.status} ${(await r.text()).slice(0, 200)}`);
const m = await fetch('https://pg1-ai-agent.vercel.app/api/mcp', { method: 'OPTIONS', headers: { origin: 'https://example.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,payment-signature,x-free-tier' } });
console.log(`OPTIONS /api/mcp -> ${m.status} allow-headers: ${m.headers.get('access-control-allow-headers')} expose: ${m.headers.get('access-control-expose-headers')}`);
