// One-off: dry run of the ichimoku-signal crowding-check example (prices only, pays nothing),
// plus the free 402 challenges of the Edge Agents endpoints it calls.
import { execSync } from 'child_process';
execSync('git clone -q --depth 1 -b claude/x402-agents-solana-payments-nceg9b https://github.com/Fizzl13/ichimoku-signal /tmp/is && cd /tmp/is && npm ci --silent', { stdio: 'inherit' });
execSync('cd /tmp/is && node examples/crowding-check/crowding-check.mjs BTC --dry-run && node examples/crowding-check/crowding-check.mjs ETH --dry-run', { stdio: 'inherit' });
for (const p of ['perp-funding-rates', 'btc-cftc-leveraged-fund-positioning']) {
  const r = await fetch(`https://pay.edge-agents.ai/v1/services/${p}`);
  const body = await r.json().catch(() => ({}));
  console.log(`\n${p}: ${r.status}`, JSON.stringify(body.extensions?.bazaar?.info?.output?.example ?? body.extensions?.bazaar ?? '').slice(0, 1500));
}
