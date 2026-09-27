// TAT pilot baseline: 20 Base tokens (addresses verified on-chain), with
// presign-guard's current token verdict for each, frozen before TAT's evidence.
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
execSync('git clone -q --depth 1 https://github.com/Fizzl13/presign-guard pg && cd pg && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error', { stdio: 'inherit' });
const { tokenVerdict, parseTokenRequest } = await import(`${process.cwd()}/pg/src/token-verdict.js`);

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
// GoPlus raw answer for two tokens: is "no security data" real, or the runner being limited?
for (const a of ['0x940181a94A35A4569E4529A3CDfB74e38FD98631', '0x532f27101965dd16442E59d40670FaF5eBB142E4']) {
  const r = await fetch(`https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${a}`);
  console.log('GOPLUS', a, r.status, (await r.text()).slice(0, 400));
}
// Fresh launches: GeckoTerminal's newest Base pools, token verified on-chain, some liquidity.
const fresh = [];
const seen = new Set(picked.map((t) => t.address.toLowerCase()));
const known = new Set(['0x4200000000000000000000000000000000000006', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913']);
for (let page = 1; page <= 3 && picked.length + fresh.length < 20; page++) {
  const j = await (await fetch(`https://api.geckoterminal.com/api/v2/networks/base/new_pools?page=${page}`, { headers: { accept: 'application/json' } })).json();
  for (const pool of j.data || []) {
    if (picked.length + fresh.length >= 20) break;
    const liq = Number(pool.attributes?.reserve_in_usd || 0);
    const address = String(pool.relationships?.base_token?.data?.id || '').replace(/^base_/, '');
    if (!/^0x[0-9a-fA-F]{40}$/.test(address) || known.has(address.toLowerCase()) || seen.has(address.toLowerCase()) || liq < 10000) continue;
    const code = await rpc('eth_getCode', [address, 'latest']);
    const sym = await symbolOf(address);
    if (!code || code === '0x' || !sym) continue;
    seen.add(address.toLowerCase());
    console.log(`fresh ${sym} ${address} liq=$${Math.round(liq)} created=${pool.attributes?.pool_created_at}`);
    fresh.push({ group: 'fresh_launch', symbol: sym, address, pool_created_at: pool.attributes?.pool_created_at, liquidity_usd: Math.round(liq) });
  }
  await new Promise((r) => setTimeout(r, 2500));
}
picked.push(...fresh);
const block = parseInt(await rpc('eth_blockNumber', []), 16);
const out = [];
for (const t of picked.slice(0, 20)) {
  let v;
  // Same path as GET /v1/token (parseTokenRequest lowercases EVM addresses), paced and
  // retried because GoPlus rate-limits unauthenticated callers.
  for (let attempt = 0; attempt < 4; attempt++) {
    try { v = await tokenVerdict(parseTokenRequest({ chain: 'base', address: t.address })); break; } catch (e) { v = { error: e.message }; if (!/too many/i.test(e.message)) break; await new Promise((r) => setTimeout(r, 15000)); }
  }
  await new Promise((r) => setTimeout(r, 4000));
  out.push({ ...t, verdict: v.verdict, grade: v.grade, reasons: (v.reasons || []).map((r) => `${r.severity}:${r.code}`), one_liner: v.one_liner, error: v.error });
}
const baseline = { purpose: 'presign-guard token verdicts before TAT pilot evidence', chain: 'base', block, takenAt: new Date().toISOString(), presign_guard_commit: execSync('git -C pg rev-parse HEAD').toString().trim(), tokens: out };
const text = JSON.stringify(baseline);
console.log('\nBASELINE_SHA256', createHash('sha256').update(text).digest('hex'));
console.log('BASELINE_JSON', text);
for (const t of out) console.log(`${t.group.padEnd(12)} ${String(t.symbol).padEnd(10)} ${t.address} ${t.verdict}/${t.grade} ${t.reasons.join(',')}`);
