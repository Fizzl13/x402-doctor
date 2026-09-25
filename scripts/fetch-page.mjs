// One-off: presign-guard branch with token security, live GoPlus, USDC vs DEGEN approvals on Base.
import { execSync } from 'child_process';
execSync('git clone -q --depth 1 -b claude/x402-agents-solana-payments-nceg9b https://github.com/Fizzl13/presign-guard /tmp/pg && cd /tmp/pg && npm ci --omit=dev --silent', { stdio: 'inherit' });
const { createCheckRouter } = await import('/tmp/pg/src/presign-guard.js');
const express = (await import('/tmp/pg/node_modules/express/index.js')).default;
const app = express(); app.use(createCheckRouter());
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const cases = {
  'USDC, 100 USDC to Permit2': { type: 'approval', chainId: 8453, token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', spender: PERMIT2, amount: '100000000' },
  'DEGEN, 1000 DEGEN to Permit2': { type: 'approval', chainId: 8453, token: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', spender: PERMIT2, amount: '1000000000000000000000' },
};
for (const [label, body] of Object.entries(cases)) {
  const res = await fetch(`${base}/v1/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json();
  console.log(`\n### ${label}: HTTP ${res.status} verdict=${j.verdict}`);
  for (const x of j.reasons || []) console.log(`  ${x.severity.padEnd(6)} ${x.code} ${x.subject || ''} ${x.details ? JSON.stringify(x.details) : ''}`);
  if (j.error) console.log('  ', j.error, j.message);
}
server.close();
