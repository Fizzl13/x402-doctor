// One-off: incoming USDC payments to the Ichimoku Signal payout wallets (Base + Solana).
// Payout addresses are read from the live 402 challenges; own services' payTo are shown too,
// so shared wallets are visible. Read-only, pays nothing.
const decode = (h) => JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
async function challenge(url, init) {
  const r = await fetch(url, init);
  const h = r.headers.get('payment-required');
  return h ? decode(h) : await r.json().catch(() => ({}));
}
const sources = {
  ichimoku: await challenge('https://ichimoku-signal.onrender.com/signal/BTC-USDT', { headers: { accept: 'application/json' } }),
  doctor: await challenge('https://x402-doctor.onrender.com/api/v1/diagnose?url=https://example.com', { headers: { accept: 'application/json' } }),
  presign: await challenge('https://presign-guard.onrender.com/v1/check', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: '{}' }),
};
const payTo = {};
for (const [svc, c] of Object.entries(sources)) for (const a of c.accepts || []) (payTo[a.payTo] ||= { network: a.network, services: new Set() }).services.add(svc);
console.log('PAYOUT WALLETS');
for (const [addr, v] of Object.entries(payTo)) console.log(`  ${addr}  ${v.network}  used by: ${[...v.services].join(', ')}`);

// ---- Base: USDC transfers in, via Blockscout
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
for (const [addr, v] of Object.entries(payTo)) {
  if (!v.network.startsWith('eip155:8453')) continue;
  console.log(`\nBASE incoming USDC → ${addr}`);
  let url = `https://base.blockscout.com/api/v2/addresses/${addr}/token-transfers?type=ERC-20&filter=to&token=${USDC_BASE}`;
  const rows = [];
  for (let page = 0; page < 20 && url; page++) {
    const r = await fetch(url);
    if (!r.ok) { console.log('  blockscout HTTP', r.status); break; }
    const j = await r.json();
    for (const t of j.items || []) rows.push({ t: t.timestamp, from: t.from?.hash, usd: Number(t.total?.value) / 10 ** Number(t.total?.decimals || 6), tx: t.transaction_hash || t.tx_hash });
    const n = j.next_page_params;
    url = n ? `https://base.blockscout.com/api/v2/addresses/${addr}/token-transfers?type=ERC-20&filter=to&token=${USDC_BASE}&` + new URLSearchParams(n) : null;
  }
  for (const x of rows) console.log(`  ${x.t}  $${x.usd.toFixed(4)}  from ${x.from}  ${x.tx}`);
  const by = {};
  for (const x of rows) (by[x.from] ||= { n: 0, usd: 0, first: x.t, last: x.t }), by[x.from].n++, by[x.from].usd += x.usd, (by[x.from].first = x.t < by[x.from].first ? x.t : by[x.from].first), (by[x.from].last = x.t > by[x.from].last ? x.t : by[x.from].last);
  console.log('  BY PAYER');
  for (const [f, s] of Object.entries(by).sort((a, b) => b[1].usd - a[1].usd)) console.log(`   ${f}  ${s.n} payments  $${s.usd.toFixed(2)}  ${s.first.slice(0, 10)} → ${s.last.slice(0, 10)}`);
}

// ---- Solana: signatures on the payout's USDC token account, then who paid
const RPC = 'https://api.mainnet-beta.solana.com';
const rpc = async (method, params) => (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;
const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
for (const [addr, v] of Object.entries(payTo)) {
  if (!v.network.startsWith('solana:5eykt')) continue;
  console.log(`\nSOLANA incoming USDC → ${addr}`);
  const accounts = await rpc('getTokenAccountsByOwner', [addr, { mint: USDC_SOL }, { encoding: 'jsonParsed' }]);
  for (const acc of accounts?.value || []) {
    console.log(`  token account ${acc.pubkey}  balance ${acc.account.data.parsed.info.tokenAmount.uiAmountString} USDC`);
    const sigs = (await rpc('getSignaturesForAddress', [acc.pubkey, { limit: 200 }])) || [];
    const by = {};
    for (const s of sigs) {
      if (s.err) continue;
      await new Promise((r) => setTimeout(r, 250));
      const tx = await rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
      const pre = tx?.meta?.preTokenBalances || [], post = tx?.meta?.postTokenBalances || [];
      const delta = (owner) => {
        const a = pre.find((b) => b.owner === owner && b.mint === USDC_SOL), b = post.find((b) => b.owner === owner && b.mint === USDC_SOL);
        return Number(b?.uiTokenAmount?.uiAmount || 0) - Number(a?.uiTokenAmount?.uiAmount || 0);
      };
      const inAmt = delta(addr);
      if (inAmt <= 0) continue;
      const payer = post.map((b) => b.owner).find((o) => o !== addr && delta(o) < 0) || '?';
      const t = new Date((s.blockTime || 0) * 1000).toISOString();
      console.log(`  ${t}  $${inAmt.toFixed(4)}  from ${payer}  ${s.signature}`);
      (by[payer] ||= { n: 0, usd: 0 }), by[payer].n++, by[payer].usd += inAmt;
    }
    console.log('  BY PAYER');
    for (const [f, s] of Object.entries(by).sort((a, b) => b[1].usd - a[1].usd)) console.log(`   ${f}  ${s.n} payments  $${s.usd.toFixed(2)}`);
  }
}
