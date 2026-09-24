// One-off: which assets and networks do x402 resources in the CDP Bazaar accept?
const known = {
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC (Base)',
  'epjfwdd5aufqssqem2qn1xzybapc8g4wegghkzwytdt1v': 'USDC (Solana)',
  '0x036cbd53842c5426634e7929541ec2318f3dcf7e': 'USDC (Base Sepolia testnet)',
  '4zmmc9srt5ri5x14gagxhahii3gnpaeerypjgzjdncdu': 'USDC (Solana devnet)',
};
const assets = new Map(), networks = new Map(), perResource = new Map();
let total = 0, options = 0;
for (let offset = 0; offset < 40000; offset += 500) {
  const res = await fetch(`https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?type=http&limit=500&offset=${offset}`);
  if (!res.ok) { console.log(`CDP HTTP ${res.status}`); break; }
  const items = (await res.json()).items || [];
  total += items.length;
  for (const it of items) {
    const names = new Set();
    for (const a of it.accepts || []) {
      options++;
      const key = String(a.asset || '').toLowerCase();
      const name = known[key] || (a.extra && a.extra.name ? `${a.extra.name} ${a.asset}` : a.asset);
      assets.set(name, (assets.get(name) || 0) + 1);
      networks.set(a.network, (networks.get(a.network) || 0) + 1);
      names.add(name.startsWith('USDC') ? 'USDC (any)' : 'other');
    }
    for (const n of names) perResource.set(n, (perResource.get(n) || 0) + 1);
  }
  if (items.length < 500) break;
}
const top = (m, n = 10) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `  ${v}\t${(100 * v / options).toFixed(1)}%\t${k}`).join('\n');
console.log(`resources ${total}, payment options ${options}`);
console.log('assets:\n' + top(assets, 12));
console.log('networks:\n' + top(networks, 10));
console.log('resources accepting USDC:', perResource.get('USDC (any)'), 'accepting something else:', perResource.get('other') || 0);
