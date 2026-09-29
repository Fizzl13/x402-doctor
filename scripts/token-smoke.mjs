// Read-only: find tokens launched with Metaplex Genesis (program GNS1…) and how their top holders look.
const RPC = 'https://api.mainnet-beta.solana.com';
const call = async (method, params) => (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(40000) })).json());
const GEN = 'GNS1S5J5AspKXgpjz6SvKL66kPaKWAhaGRhCqPRxii2B';
const sigs = await call('getSignaturesForAddress', [GEN, { limit: 40 }]);
console.log('GEN sigs', sigs.result?.length, JSON.stringify(sigs.error || ''));
const mints = new Map();
for (const s of (sigs.result || []).slice(0, 25)) {
  const tx = await call('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
  const bals = tx.result?.meta?.postTokenBalances || [];
  for (const b of bals) if (b.mint !== 'So11111111111111111111111111111111111111112') mints.set(b.mint, (mints.get(b.mint) || 0) + 1);
  const progs = new Set((tx.result?.transaction?.message?.instructions || []).map((i) => i.programId));
  const inner = new Set((tx.result?.meta?.innerInstructions || []).flatMap((x) => x.instructions.map((i) => i.programId)));
  console.log('GEN tx', s.signature.slice(0, 10), 'progs', [...progs].join(','), 'inner', [...inner].filter((p) => !/^(11111|Token|ATok|Compute)/.test(p)).join(','));
}
console.log('GEN mints', JSON.stringify([...mints].slice(0, 15)));
for (const [mint] of [...mints].slice(0, 3)) {
  const big = await call('getTokenLargestAccounts', [mint]);
  const accts = (big.result?.value || []).slice(0, 8);
  const infos = await call('getMultipleAccounts', [accts.map((a) => a.address), { encoding: 'jsonParsed' }]);
  const owners = (infos.result?.value || []).map((v) => v?.data?.parsed?.info?.owner);
  const ownerInfos = await call('getMultipleAccounts', [owners.filter(Boolean), { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]);
  owners.forEach((o, i) => console.log('HOLD', mint.slice(0, 8), accts[i]?.uiAmountString, 'owner', o, 'ownerProgram', ownerInfos.result?.value?.[owners.filter(Boolean).indexOf(o)]?.owner ?? 'none(wallet)'));
}
