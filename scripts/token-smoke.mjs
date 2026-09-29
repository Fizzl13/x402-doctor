// Read-only: list Token ACL MintConfig accounts on Solana mainnet, print address + decoded mint,
// and the mint's jsonParsed freeze authority/extensions. No keys, no payments.
const RPC = 'https://api.mainnet-beta.solana.com';
const call = async (method, params) => (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30000) })).json());
const r = await call('getProgramAccounts', ['TACLkU6CiCdkQN2MjoyDkVg2yAH9zkxiHDsiztQ52TP', { encoding: 'base64', filters: [{ dataSize: 100 }] }]);
if (r.error) console.log('ACL err', JSON.stringify(r.error));
const accts = r.result ?? [];
console.log('ACL count', accts.length);
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (buf) => { let n = BigInt('0x' + Buffer.from(buf).toString('hex')); let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const b of buf) { if (b === 0) s = '1' + s; else break; } return s; };
for (const a of accts.slice(0, 5)) {
  const d = Buffer.from(a.account.data[0], 'base64');
  const mint = b58(d.subarray(4, 36));
  console.log('ACL cfg', a.pubkey, 'disc', d[0], 'thaw', d[2], 'freeze', d[3], 'mint', mint, 'gate', b58(d.subarray(68, 100)));
  const m = await call('getAccountInfo', [mint, { encoding: 'jsonParsed' }]);
  const info = m.result?.value?.data?.parsed?.info;
  console.log('ACL mint', mint, 'owner', m.result?.value?.owner, 'freezeAuth', info?.freezeAuthority, 'ext', JSON.stringify((info?.extensions ?? []).map((e) => [e.extension, e.state?.accountState ?? e.state?.delegate ?? ''])).slice(0, 300));
}
