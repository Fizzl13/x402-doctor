// market-summary.js
//
// Where the money in the x402 market goes, for the card on lab.fizzl.eu: the CDP Bazaar's settled calls over
// the last 30 days per seller (bazaar-index siteCalls), grouped by today's Trust Index verdicts of that
// seller's endpoints and by kind of service. Counts only, and every one of them is already public on
// /api/trust/atlas; the shares are left to the page.

'use strict';

// A seller by today's verdicts of its endpoints: none failing and none caution, caution only, some failing
// (at most half), or mostly failing (more than half). Unreachable endpoints count in the total, not as failing.
const BUCKETS = ['all_go', 'caution', 'some_no_go', 'mostly_no_go'];

function bucketOf(s) {
  if (s.n > s.total / 2) return 'mostly_no_go';
  if (s.n > 0) return 'some_no_go';
  if (s.c > 0) return 'caution';
  return 'all_go';
}

// map: trustIndex.atlas() (sellers [site, category, ...], endpoints [seller, history, bait?], days, categories).
// calls: Map of seller site -> settled calls over 30 days. Only sellers scanned on the last day count.
function marketSummary(map, calls) {
  if (!map || !Array.isArray(map.sellers) || !map.sellers.length || !Array.isArray(map.days) || !map.days.length || !(calls instanceof Map)) return null;
  const last = map.days.length - 1;
  const st = map.sellers.map(() => ({ g: 0, c: 0, n: 0, total: 0, bait: 0 }));
  for (const [i, h, bait] of map.endpoints || []) {
    const v = typeof h === 'string' ? h[h.length - 1] : undefined; // atlas() pads each history to the end of days[]
    if (!st[i] || !v || v === '-') continue;
    st[i].total++;
    if (v === 'g' || v === 'c' || v === 'n') st[i][v]++;
    if (bait) st[i].bait++;
  }
  const verdict = Object.fromEntries(BUCKETS.map((key) => [key, { key, sellers: 0, sellers_with_calls: 0, calls: 0 }]));
  const bait = { sellers: 0, calls: 0 };
  const kinds = new Map();
  let total = 0, scanned = 0;
  map.sellers.forEach((seller, i) => {
    const s = st[i];
    if (!s.total) return;
    scanned++;
    const n = Number(calls.get(seller[0])) || 0;
    total += n;
    const b = verdict[bucketOf(s)];
    b.sellers++; b.calls += n; if (n > 0) b.sellers_with_calls++;
    if (s.bait) { bait.sellers++; bait.calls += n; }
    const cat = map.categories?.[seller[1]];
    const id = cat?.id || 'other';
    const k = kinds.get(id) || { id, name: cat?.name || id, sellers: 0, sellers_with_calls: 0, calls: 0, top: 0 };
    k.sellers++; k.calls += n; if (n > 0) k.sellers_with_calls++; if (n > k.top) k.top = n;
    kinds.set(id, k);
  });
  if (!scanned) return null;
  return {
    scan_day: map.days[last],
    sellers: scanned,
    calls_30d: total,
    by_verdict: BUCKETS.map((key) => verdict[key]),
    bait,
    // top_seller_share: how much of a kind's calls its largest seller has (one seller can be most of a kind).
    by_kind: [...kinds.values()].sort((a, b) => b.calls - a.calls).map(({ top, ...k }) => ({ ...k, top_seller_share: k.calls ? Math.round((top / k.calls) * 1000) / 1000 : 0 })),
  };
}

module.exports = { marketSummary, BUCKETS };
