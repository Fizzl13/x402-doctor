// TAT pilot baseline: 20 Base tokens (addresses verified on-chain), with
// presign-guard's current token verdict for each, frozen before TAT's evidence.
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
execSync('git clone -q --depth 1 https://github.com/Fizzl13/presign-guard pg && cd pg && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error', { stdio: 'inherit' });
const { tokenVerdict } = await import(`${process.cwd()}/pg/src/token-verdict.js`);

const RPCS = ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://base.llamarpc.com'];
async function rpc(method, params) {
  for (const url of RPCS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10000) });
      const j = await r.json();
      if (j.result !== undefined) return j.result;
    } catch {}
  }
  return null;
}
const decodeString = (hex) => {
  if (!hex || hex === '0x') return null;
  const b = Buffer.from(hex.slice(2), 'hex');
  if (b.length >= 64) { const len = Number(BigInt('0x' + b.subarray(32, 64).toString('hex'))); if (len < 100) return b.subarray(64, 64 + len).toString('utf8'); }
  return b.toString('utf8').replace(/\0+$/, '');
};
const symbolOf = async (a) => decodeString(await rpc('eth_call', [{ to: a, data: '0x95d89b41' }, 'latest']));

const BLUE = [
  ['WETH', '0x4200000000000000000000000000000000000006'], ['cbBTC', '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf'],
  ['cbETH', '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22'], ['AERO', '0x940181a94A35A4569E4529A3CDfB74e38FD98631'],
  ['DEGEN', '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed'], ['BRETT', '0x532f27101965dd16442E59d40670FaF5eBB142E4'],
  ['TOSHI', '0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4'], ['VIRTUAL', '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b'],
  ['EURC', '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42'], ['wstETH', '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452'],
  ['DAI', '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb'], ['MORPHO', '0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842'],
  ['WELL', '0xA88594D404727625A9437C3f886C7643872296AE'], ['ZORA', '0x1111111111166b7FE7bd91427724B487980aFc69'],
  ['HIGHER', '0x0578d8A44db98B23BF096A382e016e29a5Ce0ffe'],
];
const picked = [];
for (const [expect, address] of BLUE) {
  const code = await rpc('eth_getCode', [address, 'latest']);
  const sym = await symbolOf(address);
  const ok = code && code !== '0x' && sym && sym.toUpperCase() === expect.toUpperCase();
  console.log(`blue ${expect} ${address} code=${code && code.length > 2} symbol=${sym} ${ok ? 'OK' : 'DROP'}`);
  if (ok) picked.push({ group: 'blue_chip', symbol: sym, address });
}
// Fresh launches: newest Base token profiles on DexScreener with a real pool.
const profiles = await (await fetch('https://api.dexscreener.com/token-profiles/latest/v1')).json();
const fresh = [];
for (const p of profiles.filter((x) => x.chainId === 'base')) {
  if (picked.length + fresh.length >= 20) break;
  const address = p.tokenAddress;
  const code = await rpc('eth_getCode', [address, 'latest']);
  const sym = await symbolOf(address);
  if (!code || code === '0x' || !sym) continue;
  const pairs = await (await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`)).json();
  const liq = Math.max(0, ...((pairs.pairs || []).filter((x) => x.chainId === 'base').map((x) => x.liquidity?.usd || 0)));
  const created = Math.min(...((pairs.pairs || []).map((x) => x.pairCreatedAt || Infinity)));
  console.log(`fresh ${sym} ${address} liq=$${Math.round(liq)} age_h=${((Date.now() - created) / 3.6e6).toFixed(1)}`);
  if (liq >= 5000) fresh.push({ group: 'fresh_launch', symbol: sym, address });
}
picked.push(...fresh);
const block = parseInt(await rpc('eth_blockNumber', []), 16);
const out = [];
for (const t of picked.slice(0, 20)) {
  let v;
  try { v = await tokenVerdict({ chain: 'base', address: t.address }); } catch (e) { v = { error: e.message }; }
  out.push({ ...t, verdict: v.verdict, grade: v.grade, reasons: (v.reasons || []).map((r) => `${r.severity}:${r.code}`), one_liner: v.one_liner, error: v.error });
}
const baseline = { purpose: 'presign-guard token verdicts before TAT pilot evidence', chain: 'base', block, takenAt: new Date().toISOString(), presign_guard_commit: execSync('git -C pg rev-parse HEAD').toString().trim(), tokens: out };
const text = JSON.stringify(baseline);
console.log('\nBASELINE_SHA256', createHash('sha256').update(text).digest('hex'));
console.log('BASELINE_JSON', text);
for (const t of out) console.log(`${t.group.padEnd(12)} ${String(t.symbol).padEnd(10)} ${t.address} ${t.verdict}/${t.grade} ${t.reasons.join(',')}`);
