// One-off: who is 0x4f600c8A…? Account type and its outgoing USDC payments on Base (read-only).
const A = '0x4f600c8A9ba01465F33C41a445b1e427cC664f1f';
const B = 'https://base.blockscout.com/api/v2';
const info = await (await fetch(`${B}/addresses/${A}`)).json();
console.log('is_contract:', info.is_contract, '| implementations:', JSON.stringify(info.implementations || []), '| name:', info.name, '| tags:', JSON.stringify(info.public_tags || info.metadata?.tags || []));
const counters = await (await fetch(`${B}/addresses/${A}/counters`)).json().catch(() => ({}));
console.log('counters:', JSON.stringify(counters));
let url = `${B}/addresses/${A}/token-transfers?type=ERC-20`;
const rows = [];
for (let p = 0; p < 10 && url; p++) {
  const j = await (await fetch(url)).json();
  for (const t of j.items || []) rows.push({ t: t.timestamp, dir: t.from?.hash?.toLowerCase() === A.toLowerCase() ? 'OUT' : 'IN ', other: t.from?.hash?.toLowerCase() === A.toLowerCase() ? t.to?.hash : t.from?.hash, sym: t.token?.symbol, amt: Number(t.total?.value) / 10 ** Number(t.total?.decimals || 6) });
  url = j.next_page_params ? `${B}/addresses/${A}/token-transfers?type=ERC-20&` + new URLSearchParams(j.next_page_params) : null;
}
console.log(`\n${rows.length} token transfers`);
for (const r of rows) console.log(`${r.t}  ${r.dir}  ${r.amt} ${r.sym}  ${r.other}`);
const out = {};
for (const r of rows.filter((r) => r.dir === 'OUT')) (out[r.other] ||= { n: 0, amt: 0 }), out[r.other].n++, out[r.other].amt += r.amt;
console.log('\nPAID TO');
for (const [k, v] of Object.entries(out).sort((a, b) => b[1].n - a[1].n)) console.log(`${k}  ${v.n}×  ${v.amt.toFixed(4)}`);
