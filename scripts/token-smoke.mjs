// Live check of the presign-guard branch: /v1/check reports pause/blacklist powers of the token.
import { execSync } from 'node:child_process';
execSync('git clone -q --depth 1 -b claude/x402-agents-solana-payments-nceg9b https://github.com/Fizzl13/presign-guard /tmp/pg && cd /tmp/pg && npm ci -s', { stdio: 'inherit' });
process.env.ORIGIN_REPUTATION = 'off';
const { parseRequest, analyze } = await import('/tmp/pg/src/presign-guard.js');
const SPENDER = '0x000000000022D473030F116dDEE9F6B43aC78BA3'; // Permit2
const T = { USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', cbBTC: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', DEGEN: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed' };
for (const [sym, token] of Object.entries(T)) {
  const t0 = Date.now();
  try {
    const r = await analyze(parseRequest({ type: 'approval', chainId: 8453, token, spender: SPENDER, amount: '1000000' }));
    const c = r.reasons.filter((x) => /PAUS|BLACKLIST/.test(x.code));
    console.log(sym, Date.now() - t0 + 'ms', r.verdict, JSON.stringify(c), '| all:', r.reasons.map((x) => x.code).join(','));
  } catch (e) { console.log(sym, 'ERR', e.message); }
  await new Promise((s) => setTimeout(s, 2500));
}
