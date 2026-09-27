// MetaMask's site scanner (run by Blockaid): the verdict MetaMask shows before
// it opens a site in its browser. A domain it blocks ("wallet drainer")
// loses every MetaMask buyer in the browser, whatever the endpoint does;
// agents paying over HTTP or MCP are not affected. Read-only, one GET per
// host, cached for an hour.

const SCAN_URL = 'https://dapp-scanning.api.cx.metamask.io/scan?url=';
const TTL_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 6000;
const cache = new Map();

const isLocal = (host) => host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')
  || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$)/.test(host);

async function scanHost(host, fetchImpl = fetch) {
  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.result;
  const res = await fetchImpl(`${SCAN_URL}${encodeURIComponent(`https://${host}`)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`scanner HTTP ${res.status}`);
  const result = await res.json();
  if (cache.size > 2000) cache.clear();
  cache.set(host, { at: Date.now(), result });
  return result;
}

async function checkSiteScan(targetUrl, checks, { fetchImpl = fetch } = {}) {
  const group = 'wallets';
  const host = new URL(targetUrl).hostname;
  if (isLocal(host)) return;
  let scan;
  try {
    scan = await scanHost(host, fetchImpl);
  } catch (err) {
    checks.push({ id: 'metamask-site-scan', status: 'info', group, message: `Could not ask MetaMask's site scanner about ${host}: ${err.message}.` });
    return;
  }
  const action = String(scan.recommendedAction || '').toUpperCase();
  const risks = Array.isArray(scan.riskFactors) ? scan.riskFactors : [];
  const why = risks.map((r) => `${r.type || 'risk'}${r.severity ? ` (${String(r.severity).toLowerCase()})` : ''}${r.message ? `: ${String(r.message).replace(/\.+\s*$/, '')}` : ''}`).join('; ');
  const hint = `If this is your site, report a false positive to Blockaid: in MetaMask, "Report a detection problem" on the warning screen, or Blockaid's report form (choose developer / false positive), and say what the site asks users to sign (for x402: an EIP-3009 USDC payment of the listed amount to your payTo). Browser x402 payments to a regular wallet can look like a drainer to scanners. Agents paying over HTTP or MCP are not affected.`;
  if (action === 'BLOCK') {
    checks.push({ id: 'metamask-site-scan', status: 'warn', group, message: `MetaMask blocks ${host}: its site scanner (Blockaid) flags it${why ? ` as ${why}` : ''}. MetaMask users see "This website might be harmful" and cannot pay in the browser.`, hint });
  } else if (action && action !== 'NONE') {
    checks.push({ id: 'metamask-site-scan', status: 'warn', group, message: `MetaMask's site scanner recommends "${action}" for ${host}${why ? `: ${why}` : ''}.`, hint });
  } else {
    checks.push({ id: 'metamask-site-scan', status: 'pass', group, message: `MetaMask's site scanner (Blockaid) has no warning for ${host}.` });
  }
}

module.exports = { checkSiteScan, _clearCache: () => cache.clear() };
