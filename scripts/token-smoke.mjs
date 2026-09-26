// Sample GoPlus approval data (token + NFT) to design presign-guard's /v1/approvals. Free API, nothing paid.
const G = 'https://api.gopluslabs.io/api/v2';
const wallets = [
  ['1', '0xd8da6bf26964af9d7eed9e03e53415d37aa96045'],
  ['8453', '0x0fd3d46e688855b24536df33bba3dfa35b67445c'],
  ['8453', '0x6b0f4651ed42893ab58139938175e4a69f175f25'],
  ['1', '0x28c6c06298d514db089934071355e5743bf21d60'],
];
for (const [chain, addr] of wallets) {
  for (const ep of ['token_approval_security', 'nft721_approval_security', 'nft1155_approval_security']) {
    const r = await fetch(`${G}/${ep}/${chain}?addresses=${addr}`);
    const t = await r.text();
    let j; try { j = JSON.parse(t); } catch { console.log(ep, chain, addr, r.status, t.slice(0, 200)); continue; }
    const res = j.result;
    const n = Array.isArray(res) ? res.length : res ? Object.keys(res).length : 0;
    console.log(`\n### ${ep} chain ${chain} ${addr}: HTTP ${r.status} code ${j.code} msg ${j.message} items ${n}`);
    const items = Array.isArray(res) ? res : [];
    if (items.length) {
      const first = { ...items[0] }; const list = first.approved_list || [];
      first.approved_list = list.slice(0, 2);
      console.log(JSON.stringify(first, null, 1).slice(0, 2500));
      console.log('keys of all items:', [...new Set(items.flatMap((i) => Object.keys(i)))].join(','));
      console.log('approved_list keys:', [...new Set(items.flatMap((i) => (i.approved_list || []).flatMap((a) => Object.keys(a))))].join(','));
      console.log('address_info keys:', [...new Set(items.flatMap((i) => (i.approved_list || []).flatMap((a) => Object.keys(a.address_info || {}))))].join(','));
      const amounts = items.flatMap((i) => (i.approved_list || []).map((a) => a.approved_amount)).slice(0, 12);
      console.log('sample amounts:', JSON.stringify(amounts));
      const mal = items.flatMap((i) => (i.approved_list || []).filter((a) => (a.address_info?.malicious_behavior || []).length || a.address_info?.doubt_list == 1).map((a) => [a.approved_contract, a.address_info.malicious_behavior, a.address_info.doubt_list]));
      console.log('flagged spenders:', JSON.stringify(mal).slice(0, 600));
    }
  }
}
