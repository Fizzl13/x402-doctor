// Read-only: how GoPlus and RugCheck report the top holders of two Genesis-launched mints,
// plus which program owns each holder's owner account.
const RPC = 'https://api.mainnet-beta.solana.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpc = async (method, params) => (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json());
for (const mint of ['H6H8eXheCUdEd82ULuaDYq6ePiRPasZEaddF1HrCPLEX', 'rMVmRp5DJch9sVxJTgchcDbgkK3phgmEd9a8Yk3PLEX']) {
  const gp = await (await fetch(`https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${mint}`)).json();
  const sec = gp.result?.[mint];
  for (const h of (sec?.holders || []).slice(0, 8)) console.log('GP', mint.slice(0, 6), JSON.stringify(h).slice(0, 220));
  const rc = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`);
  const rj = rc.ok ? await rc.json() : null;
  console.log('RC', mint.slice(0, 6), rc.status, 'risks', JSON.stringify((rj?.risks || []).map((r) => r.name)).slice(0, 300));
  const top = (rj?.topHolders || []).slice(0, 8);
  const owners = top.map((h) => h.owner).filter(Boolean);
  const oi = owners.length ? await rpc('getMultipleAccounts', [owners, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]) : {};
  top.forEach((h, i) => console.log('RC', mint.slice(0, 6), 'pct', h.pct, 'addr', h.address, 'owner', h.owner, 'insider', h.insider, 'ownerProgram', oi.result?.value?.[i]?.owner ?? 'wallet/none'));
  for (const m of (rj?.markets || []).slice(0, 2)) console.log('RC mkt', mint.slice(0, 6), m.marketType, m.pubkey, 'lpLocked', m.lp?.lpLockedPct);
  await sleep(1500);
}
