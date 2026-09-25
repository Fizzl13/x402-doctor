// One-off: 30-day paid demand per category, from the CDP x402 catalogue (quality.l30Days*). Read-only.
const items = [];
for (let page = 0; page < 80; page++) {
  const r = await fetch(`https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?type=http&limit=500&offset=${page * 500}`, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) { console.log('HTTP', r.status, 'at page', page); break; }
  const batch = (await r.json()).items || [];
  items.push(...batch);
  if (batch.length < 500) break;
}
const cats = [
  ['wallet/tx security', /phish|scam|rug|honeypot|approval|pre-?sign|risk score|security|sanction|drainer|audit|exploit/],
  ['token due diligence', /token (analysis|report|safety|score|check)|holder|liquidity|tokenomics|unlock|contract risk|memecoin|launch/],
  ['trading signals/TA', /signal|indicator|rsi|macd|ichimoku|technical|backtest|trading (idea|setup)|momentum|trend/],
  ['crypto market data', /price|ohlc|candle|funding|open interest|orderbook|dex|swap quote|market data|coin|token price|whale|on-?chain|wallet (balance|portfolio|analy)|defi|tvl|yield|balance/],
  ['news/sentiment', /news|sentiment|headline|twitter|tweet|social|reddit|narrative|linkedin/],
  ['search/scrape/web', /search|scrap|crawl|web page|url to|markdown|extract|browser|screenshot/],
  ['llm/ai inference', /llm|gpt|claude|inference|chat completion|summar|translat|embedding|prompt|image gen|text-to|tts|speech|transcri|vision|model/],
  ['media/images', /image|video|meme|nft|art|music|audio|avatar/],
  ['x402/agent infra', /x402|facilitator|agent (registry|directory)|discovery|diagnos|monitor|uptime|reputation|trust|escrow|identity|kyc|attest/],
  ['weather/geo/misc data', /weather|geo|flight|stock|equit|forex|sports|odds|lottery|horoscope|astrolog|tarot/],
  ['payments/commerce', /invoice|pay(ment)? link|checkout|gift card|bridge|onramp|transfer/],
];
const catOf = (it) => { const t = `${it.description || ''} ${it.resource}`.toLowerCase(); for (const [n, re] of cats) if (re.test(t)) return n; return 'other'; };
const host = (u) => { try { return new URL(u).host; } catch { return '?'; } };
const agg = {};
const rows = [];
for (const it of items) {
  const q = it.quality || {};
  const calls = Number(q.l30DaysTotalCalls) || 0, payers = Number(q.l30DaysUniquePayers) || 0;
  const c = catOf(it);
  const a = (agg[c] ||= { resources: 0, withCalls: 0, calls: 0, payers: 0, hosts: new Set(), paidHosts: new Set() });
  a.resources++; a.hosts.add(host(it.resource));
  if (calls) { a.withCalls++; a.calls += calls; a.payers += payers; a.paidHosts.add(host(it.resource)); }
  const amt = (it.accepts || []).map((x) => Number(x.amount ?? x.maxAmountRequired) / 1e6).find((v) => v > 0 && v < 1000);
  rows.push({ c, calls, payers, url: it.resource, price: amt, d: (it.description || '').slice(0, 90) });
}
console.log(`catalogue items: ${items.length}`);
console.log(['category', 'resources', 'w/ calls', 'calls30d', 'payers30d*', 'providers', 'paid providers'].join(' | '));
for (const [c, a] of Object.entries(agg).sort((x, y) => y[1].payers - x[1].payers)) console.log([c, a.resources, a.withCalls, a.calls, a.payers, a.hosts.size, a.paidHosts.size].join(' | '));
console.log('* payers summed per resource: one wallet paying 3 resources counts 3 times');
const top = (list, n) => list.slice(0, n).map((r) => `  ${String(r.payers).padStart(5)} payers ${String(r.calls).padStart(7)} calls  $${r.price ?? '?'}  [${r.c}] ${r.url}  — ${r.d}`).join('\n');
console.log('\nTOP 40 by unique payers:\n' + top([...rows].sort((a, b) => b.payers - a.payers), 40));
for (const c of ['wallet/tx security', 'token due diligence', 'trading signals/TA', 'x402/agent infra', 'crypto market data']) console.log(`\nTOP 8 ${c}:\n` + top(rows.filter((r) => r.c === c).sort((a, b) => b.payers - a.payers), 8));
const calls = rows.map((r) => r.calls).sort((a, b) => b - a);
const totalCalls = calls.reduce((s, v) => s + v, 0);
console.log(`\nconcentration: top 10 resources = ${Math.round(100 * calls.slice(0, 10).reduce((s, v) => s + v, 0) / totalCalls)}% of ${totalCalls} calls; resources with >=1 call: ${calls.filter((v) => v > 0).length}; with >=10 payers: ${rows.filter((r) => r.payers >= 10).length}`);
