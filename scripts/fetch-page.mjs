// One-off: presign-guard live status + x402 Doctor on both paid routes.
import { execFileSync } from 'node:child_process';
const SITE = 'https://presign-guard.onrender.com';
for (const p of ['/health', '/', '/openapi.json', '/.well-known/x402']) {
  try {
    const r = await fetch(SITE + p, { signal: AbortSignal.timeout(90000) });
    console.log(`${p}: ${r.status} ${(await r.text()).slice(0, 400)}`);
  } catch (e) { console.log(`${p}: ${e.message}`); }
}
for (const route of ['/v1/check', '/v1/check/explain']) {
  let out = '';
  try { out = execFileSync('node', ['doctor/bin/x402-doctor.js', SITE + route, '--method', 'POST'], { encoding: 'utf8', timeout: 120000 }); }
  catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  console.log(`\n===== Doctor: POST ${route}\n${out}`);
}
