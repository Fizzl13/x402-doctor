// The day budget across restarts. The inkoper keeps what it spent today in memory (createBudget), and every deploy
// (each merge to master) starts a new instance. So each purchase writes what it spent into the usage log
// (input.spent_usd, with the instance that spent it; buy-server.js), and a new instance reads today's file and
// counts what the other instances spent. The old instance writes its last calls when it stops, so the file is read
// again a few minutes after the start.
'use strict';

const crypto = require('node:crypto');

const INSTANCE = crypto.randomBytes(6).toString('hex');
const DEFAULT_REPO = 'Fizzl13/usage-log';

// USD spent on `day` (YYYY-MM-DD) by other instances, from events/buy/<day>.jsonl; null without USAGE_LOG_TOKEN.
async function spentByOthers({ env = process.env, fetch: fetchImpl = globalThis.fetch, day, instance = INSTANCE }) {
  const token = env.USAGE_LOG_TOKEN;
  if (!token) return null;
  const repo = env.USAGE_LOG_REPO || DEFAULT_REPO;
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/contents/events/buy/${day}.jsonl`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github.raw+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'usage-log/buy' },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 404) return 0;
  if (!res.ok) throw new Error(`usage log: HTTP ${res.status}`);
  let sum = 0;
  for (const line of (await res.text()).split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const usd = Number(e?.input?.spent_usd);
    if (e?.input?.instance !== instance && usd > 0) sum += usd;
  }
  return Math.round(sum * 1e6) / 1e6;
}

module.exports = { spentByOthers, INSTANCE };
