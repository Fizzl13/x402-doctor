// Live check of the presign-guard branch: token verdicts with on-chain issuer controls.
import { execSync } from 'node:child_process';
execSync('git clone -q --depth 1 -b claude/x402-agents-solana-payments-nceg9b https://github.com/Fizzl13/presign-guard /tmp/pg && cd /tmp/pg && npm ci -s', { stdio: 'inherit' });
const { tokenVerdict } = await import('/tmp/pg/src/token-verdict.js');
const T = {
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', cbBTC: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
  EURC: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42', cbETH: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22',
  wstETH: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452', MORPHO: '0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842',
  WELL: '0xA88594D404727625A9437C3f886C7643872296AE', DEGEN: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed',
};
for (const [sym, a] of Object.entries(T)) {
  const t0 = Date.now();
  try {
    const r = await tokenVerdict({ chain: 'base', address: a.toLowerCase() });
    const c = r.reasons.filter((x) => /PAUS|BLACKLIST/.test(x.code));
    console.log(sym, Date.now() - t0 + 'ms', r.grade, '|', r.one_liner, '|', JSON.stringify(c), '|', r.sources.join(','));
  } catch (e) { console.log(sym, 'ERR', e.message); }
  await new Promise((s) => setTimeout(s, 2500));
}
