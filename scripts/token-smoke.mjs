// Read-only: top holders of two Genesis-launched mints, and which program owns each holder.
const RPC = 'https://api.mainnet-beta.solana.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (method, params) => { for (let i = 0; i < 4; i++) { const j = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (!j.error) return j; console.log('ERR', method, j.error.message); await sleep(3000 * (i + 1)); } return {}; };
for (const mint of ['H6H8eXheCUdEd82ULuaDYq6ePiRPasZEaddF1HrCPLEX', 'rMVmRp5DJch9sVxJTgchcDbgkK3phgmEd9a8Yk3PLEX']) {
  const m = await call('getAccountInfo', [mint, { encoding: 'jsonParsed' }]); await sleep(800);
  const info = m.result?.value?.data?.parsed?.info;
  console.log('MINT', mint, 'program', m.result?.value?.owner, 'supply', info?.supply, 'dec', info?.decimals, 'mintAuth', info?.mintAuthority, 'freeze', info?.freezeAuthority);
  const big = await call('getTokenLargestAccounts', [mint]); await sleep(800);
  const accts = (big.result?.value || []).slice(0, 10);
  const infos = await call('getMultipleAccounts', [accts.map((a) => a.address), { encoding: 'jsonParsed' }]); await sleep(800);
  const owners = (infos.result?.value || []).map((v) => v?.data?.parsed?.info?.owner ?? null);
  const oi = await call('getMultipleAccounts', [owners.map((o) => o || '11111111111111111111111111111111'), { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]); await sleep(800);
  accts.forEach((a, i) => console.log('HOLD', mint.slice(0, 6), a.uiAmountString, 'tokenAcct', a.address, 'owner', owners[i], 'ownerProgram', oi.result?.value?.[i]?.owner ?? 'wallet'));
}
