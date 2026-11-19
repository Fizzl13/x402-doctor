// GET /facilitator in a browser: the same facts as the JSON (lib/facilitator-service.js info()), as a page a seller
// can read. Agents and curl keep getting JSON: the page is only served when the request prefers text/html.
'use strict';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const NEAR = 'near:mainnet';
const GUIDE_NEAR = 'https://fizzl.eu/guides/accept-usdc-near-x402/';

function codeFor(url) {
  return `import { HTTPFacilitatorClient } from "@x402/core/server";

const facilitator = new HTTPFacilitatorClient({
  url: "${url}",
  // Only needed after the free settles of the day:
  createAuthHeaders: async () => ({
    settle: { "x-credit-key": process.env.DOCTOR_CREDIT_KEY },
  }),
});`;
}

function renderFacilitatorPage(info) {
  const near = info.near;
  const by = (info.today && info.today.by_network) || {};
  const row = (label, network) => {
    const t = by[network];
    return t ? `<tr><td>${esc(label)}</td><td class="n">${esc(t.settled)}</td><td class="n">${esc(t.refused)}</td><td class="n">${esc(t.daily_max)}</td></tr>` : '';
  };
  const off = info.enabled ? '' : '<p class="warn">The facilitator is switched off here right now: verify and settle answer 503.</p>';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>x402 facilitator for USDC on Solana and NEAR | x402 Doctor</title>
<meta name="description" content="An x402 facilitator any seller can use for USDC on Solana and on NEAR. Verify is free, the first settles a day per payTo are free, payer and payTo are screened against OFAC, and on NEAR the relayer pays the gas.">
<link rel="canonical" href="${esc(info.url)}">
<link rel="alternate" type="application/json" href="${esc(info.url)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Lexend:wght@400;500;600;700&family=Unbounded:wght@600;700&display=swap">
<style>
  :root { --bg:#020708; --panel:#041212; --line:rgba(97,245,195,.16); --text:#f4f8f7; --soft:#a8b5b2; --accent:#61f5c3; --warn:#d29922; }
  @media (prefers-color-scheme: light) { :root { --bg:#f6f8fa; --panel:#ffffff; --line:#d0d7de; --text:#1f2328; --soft:#57606a; --accent:#0a7a5c; --warn:#9a6700; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:'Lexend',system-ui,sans-serif; line-height:1.6; }
  .wrap { max-width:760px; margin:0 auto; padding:48px 16px 80px; }
  h1 { font-family:'Unbounded','Lexend',sans-serif; font-size:1.6rem; letter-spacing:-.01em; margin:0 0 8px; text-wrap:balance; }
  h2 { font-size:.8rem; letter-spacing:.06em; text-transform:uppercase; color:var(--soft); margin:32px 0 10px; }
  p, li { color:var(--soft); }
  .sub { margin:0 0 24px; }
  a { color:var(--accent); }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.9em; color:var(--text); overflow-wrap:anywhere; }
  pre { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px 16px; overflow-x:auto; }
  pre code { font-size:13px; overflow-wrap:normal; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr)); gap:12px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:16px 18px; min-width:0; }
  .card h3 { margin:0 0 8px; font-size:1.05rem; color:var(--text); }
  .card ul { margin:0; padding-left:18px; }
  .tbl { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; font-size:14.5px; }
  th, td { text-align:left; padding:8px; border-bottom:1px solid var(--line); color:var(--soft); }
  th { color:var(--text); font-weight:600; }
  td.n, th.n { text-align:right; font-variant-numeric:tabular-nums; }
  .warn { color:var(--warn); }
  footer { margin-top:40px; font-size:13px; color:var(--soft); }
</style>
</head>
<body>
<div class="wrap">
  <h1>An x402 facilitator for USDC on Solana and NEAR</h1>
  <p class="sub">By x402 Doctor, open to any seller. Point your x402 resource server at <code>${esc(info.url)}</code> and nothing else in your code changes. Agents reading this URL get the same facts as JSON.</p>
  ${off}

  <h2>What it settles</h2>
  <div class="cards">
    <div class="card">
      <h3>USDC on Solana</h3>
      <ul>
        <li>Scheme <code>exact</code>, network <code>${esc(SOLANA)}</code></li>
        <li>Fee payer <code>${esc(info.fee_payer || 'not set')}</code> pays the network fee</li>
        <li>Payments signed in Phantom settle too</li>
        <li>${esc(info.pricing && info.pricing.settle)}</li>
      </ul>
    </div>
    ${near ? `<div class="card">
      <h3>USDC on NEAR</h3>
      <ul>
        <li>Scheme <code>exact</code>, network <code>${esc(NEAR)}</code>, USDC <code>${esc(near.asset)}</code></li>
        <li>Relayer <code>${esc(near.relayer || 'not set')}</code> pays the gas; buyer and seller need no NEAR</li>
        <li>Your payTo must be registered on the USDC contract once (<code>storage_deposit</code>, about 0.00125 NEAR)</li>
        <li>${esc(near.settle)}</li>
      </ul>
    </div>` : ''}
  </div>

  <h2>On every settle</h2>
  <ul>
    <li>Payer and payTo are screened against the OFAC SDN list first; a listed address is refused, and so is every settle while the list can't be read.</li>
    <li>Each signed payment settles once.</li>
    <li>Verify is free. Past the free settles, each settle takes credits from a prepaid key (<a href="${esc(info.pricing && info.pricing.credits)}">credit packs</a>, sent as <code>x-credit-key</code>); a settle that fails gives its credit back.</li>
  </ul>

  <h2>Use it</h2>
  <pre><code>${esc(codeFor(info.url))}</code></pre>
  <p>Register the scheme for each network you offer: <code>ExactSvmScheme</code> from <code>@x402/svm/exact/server</code> for Solana (the library fills <code>extra.feePayer</code> from <code>/supported</code>), <code>ExactNearScheme</code> from <code>@x402/near/exact/server</code> for NEAR. Step by step for NEAR, with working code: <a href="${GUIDE_NEAR}">Accept USDC on NEAR with x402</a>.</p>
  <p>Endpoints: <code>${esc(info.endpoints && info.endpoints.supported)}</code>, <code>${esc(info.endpoints && info.endpoints.verify)}</code>, <code>${esc(info.endpoints && info.endpoints.settle)}</code>.</p>

  <h2>Today (${esc(info.today && info.today.day)}, UTC)</h2>
  <div class="tbl"><table>
    <tr><th>Network</th><th class="n">Settled</th><th class="n">Refused</th><th class="n">Daily max</th></tr>
    ${row('Solana', SOLANA)}${row('NEAR', NEAR)}
  </table></div>

  <footer>Check your own 402 for free with <a href="/">x402 Doctor</a> · <a href="/facilitators">Status of other facilitators</a> · <a href="https://fizzl.eu/privacy/">Privacy</a> · <a href="https://fizzl.eu/terms/">Terms</a> · © 2026 Fizzl</footer>
</div>
</body>
</html>`;
}

module.exports = { renderFacilitatorPage };
