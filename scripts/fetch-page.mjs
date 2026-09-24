// One-off: the fix engine (library call, no payment) on pg1-ai-agent, plus the live /api/v1/fix 402.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { diagnose } = require('../doctor/lib/diagnose.js');
const { createSafeFetch } = require('../doctor/lib/safe-fetch.js');
const { buildFixes } = require('../doctor/lib/recipes.js');
const safeFetch = createSafeFetch({});
for (const [url, method] of [['https://pg1-ai-agent.vercel.app/api/mcp', 'POST'], ['https://pg1-ai-agent.vercel.app/api/ioc', 'GET']]) {
  const report = await diagnose(url, { safeFetch, method });
  const out = buildFixes(report);
  console.log(`\n=================== ${method} ${url}\nstack: ${out.stack.name} (${out.stack.detected_from})\nprobes: ${JSON.stringify(report.probes)}\n${out.summary}`);
  for (const f of out.fixes) {
    console.log(`\n## [${f.severity}] ${f.title}  (${f.checks.join(', ')})\n${f.why}\n- ${f.steps.join('\n- ')}`);
    for (const c of f.code) console.log(`--- ${c.label} (${c.stack})\n${c.snippet}`);
  }
  if (out.unfixed.length) console.log('unfixed:', JSON.stringify(out.unfixed));
}
for (let i = 0; i < 30; i++) {
  const r = await fetch('https://x402-doctor.onrender.com/api/v1/fix?url=' + encodeURIComponent('https://x402-doctor.onrender.com/demo/broken'));
  if (r.status === 402) { const b = await r.json(); console.log(`\nlive /api/v1/fix: 402, amounts ${b.accepts.map((a) => a.amount + ' ' + a.network).join(', ')}`); break; }
  console.log(`live /api/v1/fix: ${r.status} (waiting for deploy)`);
  await new Promise((r) => setTimeout(r, 15000));
}
