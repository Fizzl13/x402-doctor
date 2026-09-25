// One-off: which contract is the payout wallet delegated to via EIP-7702? (read-only)
const A = '0x6B0F4651eD42893ab58139938175E4a69f175F25';
const rpc = async (method, params) => (await (await fetch('https://mainnet.base.org', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;
const code = await rpc('eth_getCode', [A, 'latest']);
console.log('code:', code);
if (code && code.startsWith('0xef0100')) {
  const delegate = '0x' + code.slice(8, 48);
  console.log('delegate:', delegate);
  const info = await (await fetch(`https://base.blockscout.com/api/v2/addresses/${delegate}`)).json();
  console.log('delegate name:', info.name, '| verified:', info.is_verified, '| tags:', JSON.stringify(info.public_tags || []), '| creator:', info.creator_address_hash);
  const sc = await (await fetch(`https://base.blockscout.com/api/v2/smart-contracts/${delegate}`)).json().catch(() => ({}));
  console.log('contract name:', sc.name, '| compiler:', sc.compiler_version);
}
const me = await (await fetch(`https://base.blockscout.com/api/v2/addresses/${A}`)).json();
console.log('payout tags:', JSON.stringify(me.public_tags || me.metadata || []), '| name:', me.name);
const txs = await (await fetch(`https://base.blockscout.com/api/v2/addresses/${A}/transactions`)).json();
for (const t of (txs.items || []).slice(0, 10)) console.log(t.timestamp, t.method, 'from', t.from?.hash, 'to', t.to?.hash, t.type, JSON.stringify(t.authorization_list || '').slice(0, 200));
