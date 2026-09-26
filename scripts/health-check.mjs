// Daily health check of all Fizzl services (.github/workflows/health.yml).
//
// Every paid route must answer 402 with a PAYMENT-REQUIRED challenge that
// passes the x402 schema, asks the expected price on the expected networks and
// has at most 5 tags. Free routes must answer. Nothing is ever paid.
//
// With GITHUB_TOKEN and GITHUB_REPOSITORY set, a failure opens (or comments on)
// an issue labelled "health-check", which GitHub emails to the repo owner; the
// issue is closed again on the first all-green run. Exits 1 on any failure.

import { createRequire } from 'module';
import fs from 'fs';

const require = createRequire(import.meta.url);
const { parsePaymentRequired } = require('@x402/core/schemas');

const BASE = 'eip155:8453';
const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const ICHI = 'https://ichimoku-signal.onrender.com';
const DOCTOR = 'https://x402-doctor.onrender.com';
const GUARD = 'https://presign-guard.onrender.com';
const PLAIN = 'https://smartcontractexplainer.onrender.com';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const TIMEOUT_MS = 30000;

// amount in USDC atomic units (6 decimals): 20000 = $0.02.
const PAID = [
  { service: 'Ichimoku Signal', name: 'GET /signal', url: `${ICHI}/signal/BTC-USDT?interval=4h`, amount: '20000', networks: [BASE, SOLANA] },
  { service: 'Ichimoku Signal', name: 'GET /signals', url: `${ICHI}/signals/BTC-USDT?interval=4h`, amount: '100000', networks: [BASE, SOLANA] },
  { service: 'Ichimoku Signal', name: 'GET /levels', url: `${ICHI}/levels/BTC-USDT?interval=4h`, amount: '50000', networks: [BASE, SOLANA] },
  { service: 'Ichimoku Signal', name: 'GET /scan', url: `${ICHI}/scan?interval=4h`, amount: '250000', networks: [BASE, SOLANA] },
  { service: 'x402 Doctor', name: 'GET /api/v1/diagnose', url: `${DOCTOR}/api/v1/diagnose?url=${encodeURIComponent(`${ICHI}/signal/BTC-USDT`)}`, amount: '10000', networks: [BASE, SOLANA] },
  { service: 'x402 Doctor', name: 'GET /api/v1/preflight', url: `${DOCTOR}/api/v1/preflight?url=${encodeURIComponent(`${ICHI}/signal/BTC-USDT`)}`, amount: '1000', networks: [BASE, SOLANA] },
  { service: 'x402 Doctor', name: 'GET /api/v1/fix', url: `${DOCTOR}/api/v1/fix?url=${encodeURIComponent(`${ICHI}/signal/BTC-USDT`)}`, amount: '50000', networks: [BASE, SOLANA] },
  { service: 'presign-guard', name: 'POST /v1/check', url: `${GUARD}/v1/check`, amount: '10000', networks: [BASE], body: { type: 'approval', chainId: 8453, token: USDC_BASE, spender: PERMIT2, amount: '1000000' } },
  { service: 'presign-guard', name: 'POST /v1/check/explain', url: `${GUARD}/v1/check/explain`, amount: '30000', networks: [BASE], body: { type: 'approval', chainId: 8453, token: USDC_BASE, spender: PERMIT2, amount: '1000000', lang: 'en' } },
  { service: 'presign-guard', name: 'GET /v1/token', url: `${GUARD}/v1/token?chain=base&address=${USDC_BASE}`, amount: '10000', networks: [BASE, SOLANA] },
  { service: 'presign-guard', name: 'GET /v1/approvals', url: `${GUARD}/v1/approvals?chain=base&address=${PERMIT2}`, amount: '20000', networks: [BASE, SOLANA] },
  { service: 'PlainText', name: 'POST /api/check-wallet', url: `${PLAIN}/api/check-wallet`, amount: '100000', networks: [BASE, SOLANA], body: { address: PERMIT2, chain: 'base', kind: 'token' } },
  { service: 'PlainText', name: 'POST /api/explain', url: `${PLAIN}/api/explain`, amount: '50000', networks: [BASE, SOLANA], body: { data: { spender: PERMIT2, amount: '1000000' } } },
];

async function request(url, { method = 'GET', body, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      method,
      signal: controller.signal,
      headers: { 'user-agent': 'fizzl-health-check', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } finally {
    clearTimeout(timer);
  }
}

// Render's free tier sleeps: wake each service first (up to ~2 minutes).
async function wake(origin) {
  for (let i = 0; i < 8; i++) {
    try {
      const res = await request(origin);
      if (res.status < 500) return true;
    } catch { /* still waking */ }
    await new Promise((r) => setTimeout(r, 15000));
  }
  return false;
}

const results = [];
const record = (service, name, ok, detail) => results.push({ service, name, ok, detail });

async function checkPaid(route) {
  try {
    const res = await request(route.url, { method: route.body ? 'POST' : 'GET', body: route.body });
    if (res.status !== 402) return record(route.service, route.name, false, `HTTP ${res.status}, expected 402`);
    const header = res.headers.get('payment-required');
    if (!header) return record(route.service, route.name, false, '402 without a PAYMENT-REQUIRED header');
    const challenge = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    const parsed = parsePaymentRequired(challenge);
    if (!parsed.success) return record(route.service, route.name, false, `challenge fails the x402 schema: ${JSON.stringify(parsed.error.issues).slice(0, 200)}`);
    const problems = [];
    for (const network of route.networks) {
      const option = challenge.accepts.find((a) => a.network === network);
      if (!option) problems.push(`no ${network === BASE ? 'Base' : 'Solana'} option (offers ${challenge.accepts.map((a) => `${a.network} ${a.amount}`).join(', ')})`);
      else if (option.amount !== route.amount) problems.push(`${network === BASE ? 'Base' : 'Solana'} asks ${option.amount}, expected ${route.amount}`);
    }
    const tags = (challenge.resource && challenge.resource.tags) || [];
    if (tags.length > 5) problems.push(`${tags.length} tags (x402 allows 5)`);
    const price = `$${(Number(route.amount) / 1e6).toFixed(route.amount.length > 4 ? 2 : 3)}`;
    record(route.service, route.name, problems.length === 0, problems.length ? problems.join('; ') : `402 ${price} on ${route.networks.map((n) => (n === BASE ? 'Base' : 'Solana')).join(' + ')}`);
  } catch (err) {
    record(route.service, route.name, false, `request failed: ${err.message}`);
  }
}

async function checkFree(service, name, fn) {
  try {
    const detail = await fn();
    record(service, name, true, detail);
  } catch (err) {
    record(service, name, false, err.message);
  }
}

async function main() {
  const origins = [[ICHI, 'Ichimoku Signal'], [DOCTOR, 'x402 Doctor'], [GUARD, 'presign-guard'], [PLAIN, 'PlainText']];
  const awake = await Promise.all(origins.map(([o]) => wake(o)));
  origins.forEach(([o, service], i) => record(service, 'site answers', awake[i], awake[i] ? o : `${o} did not answer within ~2 minutes`));

  for (const route of PAID) await checkPaid(route);

  await checkFree('Ichimoku Signal', 'free daily trend', async () => {
    const res = await request(`${ICHI}/api/trend/BTC-USDT`);
    const body = await res.json();
    if (res.status !== 200 || !body.signal) throw new Error(`HTTP ${res.status} ${JSON.stringify(body).slice(0, 120)}`);
    return `BTC-USDT daily: ${body.signal}`;
  });
  await checkFree('Ichimoku Signal', 'MCP tools', async () => {
    const res = await request(`${ICHI}/mcp`, { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers: { accept: 'application/json, text/event-stream' } });
    const body = await res.json();
    const names = ((body.result && body.result.tools) || []).map((t) => t.name).sort();
    const expected = ['confluence_signal', 'ichimoku_signal', 'ichimoku_trend', 'market_scan', 'price_levels'];
    const missing = expected.filter((n) => !names.includes(n));
    if (missing.length) throw new Error(`missing tools: ${missing.join(', ')} (got ${names.join(', ') || 'none'})`);
    return `${names.length} tools`;
  });
  await checkFree('Ichimoku Signal', 'bad input rejected before payment', async () => {
    const res = await request(`${ICHI}/signal/NOT_A_PAIR!`, { headers: { accept: 'application/json' } });
    if (res.headers.get('payment-required')) throw new Error('asks for payment on an invalid pair');
    if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
    return `HTTP ${res.status}, no payment asked`;
  });

  // Informational: which routes the CDP Bazaar lists (never a failure).
  const listed = [];
  try {
    for (let offset = 0; offset < 40000; offset += 500) {
      const res = await request(`https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?type=http&limit=500&offset=${offset}`);
      if (!res.ok) break;
      const items = (await res.json()).items || [];
      for (const it of items) {
        const r = String(it.resource || '');
        if ([ICHI, DOCTOR, GUARD, PLAIN].some((o) => r.startsWith(o))) listed.push(r.replace(/^https:\/\//, ''));
      }
      if (items.length < 500) break;
    }
  } catch { /* Bazaar unreachable: skip */ }

  const failed = results.filter((r) => !r.ok);
  const date = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const lines = [
    `**${failed.length ? `❌ ${failed.length} problem${failed.length > 1 ? 's' : ''}` : '✅ All good'}**: ${results.length - failed.length} of ${results.length} checks passed (${date} UTC)`,
    '',
    '| | Service | Check | Result |',
    '|---|---|---|---|',
    ...results.map((r) => `| ${r.ok ? '✅' : '❌'} | ${r.service} | ${r.name} | ${String(r.detail).replace(/\|/g, '/')} |`),
    '',
    `CDP Bazaar lists ${listed.length} route${listed.length === 1 ? '' : 's'}${listed.length ? `: ${listed.sort().join(', ')}` : ''}.`,
  ];
  const report = lines.join('\n');
  console.log(report);
  fs.writeFileSync('health-report.md', report + '\n');
  fs.writeFileSync('health-report.json', JSON.stringify({ checkedAt: new Date().toISOString(), ok: failed.length === 0, results, bazaar: listed }, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n');

  await updateIssue(failed, report);
  process.exit(failed.length ? 1 : 0);
}

// One open issue labelled "health-check" at a time: opened on the first
// failure, commented on while problems last, closed when all is green again.
async function updateIssue(failed, report) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) return;
  const gh = (path, init = {}) => fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'fizzl-health-check' },
  });
  const open = await (await gh('/issues?state=open&labels=health-check&per_page=1')).json();
  const issue = Array.isArray(open) ? open[0] : null;
  const run = process.env.GITHUB_RUN_ID ? `\n\n[Run log](https://github.com/${repo}/actions/runs/${process.env.GITHUB_RUN_ID})` : '';
  if (failed.length && !issue) {
    const title = `Health check: ${failed.map((f) => `${f.service} ${f.name}`).join(', ').slice(0, 180)}`;
    await gh('/issues', { method: 'POST', body: JSON.stringify({ title, body: report + run, labels: ['health-check'] }) });
  } else if (failed.length && issue) {
    await gh(`/issues/${issue.number}/comments`, { method: 'POST', body: JSON.stringify({ body: `Still failing:\n\n${report}${run}` }) });
  } else if (!failed.length && issue) {
    await gh(`/issues/${issue.number}/comments`, { method: 'POST', body: JSON.stringify({ body: `All good again.\n\n${report}${run}` }) });
    await gh(`/issues/${issue.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed', state_reason: 'completed' }) });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
