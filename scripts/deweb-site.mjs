#!/usr/bin/env node
// Builds Fizzl's on-chain website for X Layer DeWEB (TapeOut): one self-contained index.html, with every x402
// endpoint in the Trust Index that accepts payment on X Layer (eip155:196), its price and today's verdict, and what
// x402 Doctor and presign-guard check before an agent pays or signs there. No off-chain resources (no external
// scripts, styles, fonts or images), so the page keeps TapeKit's "fully on-chain" badge (SPEC §8); links are plain
// navigation. scripts/deweb-xlayer.mjs writes it to SiteRegistry.
//
//   node scripts/deweb-site.mjs [--data network.json] [--out deweb/out]
// Without --data it reads GET https://x402-doctor.fizzl.eu/api/trust/network?network=eip155:196.

import fs from 'node:fs';
import path from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const SOURCE = 'https://x402-doctor.fizzl.eu/api/trust/network?network=eip155:196';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = (x) => Number(x || 0).toLocaleString('en-US');

export function compact(data) {
  return {
    updated: data.updated,
    days: data.days?.length ?? 0,
    endpoints: data.endpoints,
    payable: data.payable_now,
    services: data.services,
    categories: (data.categories || []).map((c) => [c.name, c.services]),
    sellers: (data.sellers || []).map((s) => [s.host, s.endpoints, s.payable]),
    // [url, price in USD, verdict, category id]; the rest of each record lives in the Trust Index.
    rows: (data.resources || []).map((r) => [r.url, r.price_usd ?? null, r.verdict ?? null, r.category ?? null]),
  };
}

const TAPEOUT_CODES = [
  ['red', 'TAPEOUT_CIRCUIT_LOCKED_FOREVER', 'transferFrom of a circuit into its own container: the container then owns the NFT that controls it, and nobody can move either again.'],
  ['red', 'TAPEOUT_CONTAINER_DELEGATECALL', 'a call through a container that runs foreign code as the container.'],
  ['orange', 'TAPEOUT_CIRCUIT_TRANSFER', 'a circuit leaves the wallet, and its container goes along: the coins in it, its website and its paid name.'],
  ['orange', 'TAPEOUT_ALL_CIRCUITS_APPROVAL', 'an operator may take every circuit of a processor, and with them every container.'],
  ['orange', 'TAPEOUT_SITE_OPERATOR', 'another address may rewrite the website.'],
  ['orange', 'TAPEOUT_NAME_FEE_MISMATCH', 'a name payment that is not months × monthlyFee.'],
  ['orange', 'TAPEOUT_CONTRACT_CHANGED', 'a TapeOut core contract runs other code than the version TapeKit pins.'],
];

export function buildPage(data) {
  const d = compact(data);
  const date = String(d.updated || '').slice(0, 10);
  const json = JSON.stringify(d).replace(/</g, '\\u003c');
  const sellers = d.sellers.slice(0, 12).map(([h, e]) => `<tr><td>${esc(h)}</td><td class="n">${n(e)}</td></tr>`).join('');
  const cats = d.categories.map(([name, s]) => `<tr><td>${esc(name)}</td><td class="n">${n(s)}</td></tr>`).join('');
  const codes = TAPEOUT_CODES.map(([sev, code, text]) => `<li><b class="${sev}">${sev}</b> <code>${code}</code>: ${esc(text)}</li>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fizzl on X Layer: x402 endpoints, checked</title>
<meta name="description" content="${n(d.endpoints)} x402 endpoints accept payment on X Layer. Fizzl checks them every day, and checks X Layer and TapeOut transactions before an agent signs.">
<style>
:root{--bg:#06191a;--card:#0b2526;--ink:#e8f5f3;--muted:#9fbab6;--line:#1d3d3d;--mint:#5ef2c4;--red:#ff6b6b;--orange:#ffb454;--green:#5ef2c4}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:920px;margin:0 auto;padding:40px 16px 60px}h1{font-size:clamp(28px,5vw,44px);line-height:1.1;margin:8px 0 12px;letter-spacing:-1px}
h2{color:var(--mint);font-size:22px;margin:40px 0 10px}p,li{color:var(--muted);overflow-wrap:anywhere}a{color:var(--mint)}code{font:13px ui-monospace,Menlo,monospace;color:#dff}
.tag{display:inline-block;font-size:13px;color:var(--mint);border:1px solid var(--line);border-radius:999px;padding:2px 10px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:22px 0}.kpi{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px}
.kpi b{display:block;font-size:28px;color:var(--mint)}.kpi span{font-size:13px;color:var(--muted)}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{border-bottom:1px solid var(--line);padding:7px 6px;text-align:left;vertical-align:top}th{color:var(--ink)}td{color:var(--muted)}
.n{text-align:right;white-space:nowrap}.tbl{overflow-x:auto}.red{color:var(--red)}.orange{color:var(--orange)}.green{color:var(--green)}
input{width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--ink);font-size:15px;margin:8px 0}
td.u{word-break:break-all}footer{margin-top:48px;font-size:13px;color:var(--muted)}
</style>
</head>
<body>
<main>
<span class="tag">On-chain site · X Layer DeWEB · data of ${esc(date)}</span>
<h1>x402 on X Layer, checked before your agent pays or signs.</h1>
<p>AI agents pay for APIs with x402: the API answers <code>402 Payment Required</code>, the agent pays in USDC or USDT and gets the answer. ${n(d.endpoints)} x402 endpoints in the <a href="https://x402-doctor.fizzl.eu/trust">x402 Trust Index</a> accept that payment on X Layer. Fizzl checks every one of them every day, and checks X Layer and TapeOut transactions before an agent signs them. This page itself is stored on X Layer: no server holds it.</p>

<div class="kpis">
<div class="kpi"><b>${n(d.endpoints)}</b><span>x402 endpoints that take payment on X Layer</span></div>
<div class="kpi"><b>${n(d.services)}</b><span>distinct services</span></div>
<div class="kpi"><b>${n(d.sellers.length)}</b><span>sellers</span></div>
<div class="kpi"><b>${n(d.payable)}</b><span>payable at the last check</span></div>
</div>

<h2>Before your agent pays: x402 Doctor</h2>
<p>Doctor reads each endpoint's 402 every day: is the price what it says, is the payout address real, does it still answer, and did it deliver when bought. An agent asks before paying:</p>
<p><code>GET https://x402-doctor.fizzl.eu/api/v1/preflight?url=&lt;endpoint&gt;</code> ($0.001): go, caution or no_go, with the reasons. The free web check is at <a href="https://x402-doctor.fizzl.eu">x402-doctor.fizzl.eu</a>.</p>

<h2>Before your agent signs: presign-guard</h2>
<p>presign-guard decodes a transaction before it is signed and simulates it on X Layer: what really leaves the wallet, approvals hidden in a call, fake tokens, sanctioned addresses. For TapeOut it knows that a circuit controls its container, with the coins, website and name in it:</p>
<ul>${codes}</ul>
<p><code>POST https://presign-guard.fizzl.eu/v1/check</code> with <code>{"type":"transaction","chainId":196,"to":…,"data":…,"from":…}</code>. Free verdict-only check in its MCP server (<code>presign_quick_check</code>).</p>

<h2>Who sells on X Layer</h2>
<div class="tbl"><table><tr><th>Seller</th><th class="n">Endpoints</th></tr>${sellers}</table></div>

<h2>What they sell</h2>
<div class="tbl"><table><tr><th>Category</th><th class="n">Services</th></tr>${cats}</table></div>

<h2>Every endpoint</h2>
<p>Today's verdict per endpoint: <b class="green">go</b> payable as listed, <b class="orange">caution</b> payable with a catch, <b class="red">no_go</b> don't pay. Type to filter.</p>
<input id="q" placeholder="Filter by host, path or category" aria-label="Filter endpoints">
<div class="tbl"><table><thead><tr><th>Endpoint</th><th class="n">Price</th><th>Verdict</th></tr></thead><tbody id="rows"></tbody></table></div>
<p id="more"></p>

<footer>Made by <a href="https://fizzl.eu">Fizzl</a>. Data: x402 Trust Index (<a href="${SOURCE}">source</a>, CC BY 4.0), ${n(d.days)} days. Checks: <a href="https://x402-doctor.fizzl.eu">x402 Doctor</a> and <a href="https://presign-guard.fizzl.eu">presign-guard</a>. Not financial advice.</footer>
</main>
<script type="application/json" id="data">${json}</script>
<script>
(function(){
var d=JSON.parse(document.getElementById('data').textContent),body=document.getElementById('rows'),more=document.getElementById('more'),q=document.getElementById('q');
function e(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function show(){var t=q.value.toLowerCase(),out=[],hit=0;for(var i=0;i<d.rows.length;i++){var r=d.rows[i];if(t&&(r[0]+' '+(r[3]||'')).toLowerCase().indexOf(t)<0)continue;hit++;if(out.length<200)out.push('<tr><td class="u">'+e(r[0])+'</td><td class="n">'+(r[1]==null?'':'$'+r[1])+'</td><td class="'+({go:'green',caution:'orange',no_go:'red'}[r[2]]||'')+'">'+e(r[2]||'')+'</td></tr>')}
body.innerHTML=out.join('');more.textContent=hit>200?'Showing 200 of '+hit+'. Filter to see more.':hit+' shown.'}
q.addEventListener('input',show);show();
})();
</script>
</body>
</html>
`;
}

async function main() {
  const dataPath = arg('data', null);
  const out = arg('out', 'deweb/out');
  const data = dataPath ? JSON.parse(fs.readFileSync(dataPath, 'utf8')) : await (await fetch(SOURCE)).json();
  if (!Array.isArray(data.resources)) throw new Error('no resources in the network data');
  fs.mkdirSync(out, { recursive: true });
  const html = buildPage(data);
  fs.writeFileSync(path.join(out, 'index.html'), html);
  console.log(`index.html: ${html.length} bytes, ${data.resources.length} endpoints`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((err) => { console.error(err); process.exit(1); });
