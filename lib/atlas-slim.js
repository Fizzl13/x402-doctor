// The star map as atlas.fizzl.eu draws it: one dust particle per endpoint, but at most `perSeller` for one seller.
// On 18 Nov 2026 the Trust Index held 133,149 endpoints and one seller had 72,052 of them: 5.2 MB of JSON that a
// phone parses, then paints 133k particles again for every day the player shows. A seller over the cap keeps all its
// bait endpoints plus an even sample of the rest (the same ones every build: by position in the list), and its exact
// counts travel beside the sample, so the card and the totals stay true:
//   seller_days: [[seller index, [[go, caution, no-go, unreachable] per day]], ...] for every capped seller
//   day_totals:  [[go, caution, no-go, unreachable] per day] over all endpoints
//   endpoints_total: how many endpoints the index holds
// The full map (trustIndex.atlas()) is left as it is: the market summary counts every endpoint.

const KINDS = { g: 0, c: 1, n: 2, x: 3 };

function slimAtlas(map, { perSeller = 1000 } = {}) {
  if (!map || !Array.isArray(map.endpoints)) return map;
  const D = (map.days || []).length;
  const eps = map.endpoints;
  const dayTotals = Array.from({ length: D }, () => [0, 0, 0, 0]);
  const bySeller = new Map();
  eps.forEach((e, i) => {
    const h = e[1] || '';
    for (let d = 0; d < D; d++) { const k = KINDS[h[d]]; if (k !== undefined) dayTotals[d][k]++; }
    let list = bySeller.get(e[0]);
    if (!list) bySeller.set(e[0], (list = []));
    list.push(i);
  });
  const keep = new Uint8Array(eps.length);
  const sellerDays = [];
  for (const [si, list] of bySeller) {
    if (list.length <= perSeller) { for (const i of list) keep[i] = 1; continue; }
    const counts = Array.from({ length: D }, () => [0, 0, 0, 0]);
    const rest = [];
    let kept = 0;
    for (const i of list) {
      const h = eps[i][1] || '';
      for (let d = 0; d < D; d++) { const k = KINDS[h[d]]; if (k !== undefined) counts[d][k]++; }
      if (eps[i][2]) { keep[i] = 1; kept++; } else rest.push(i);
    }
    const room = Math.max(0, perSeller - kept);
    for (let j = 0; j < room; j++) keep[rest[Math.floor((j * rest.length) / room)]] = 1;
    sellerDays.push([si, counts]);
  }
  sellerDays.sort((a, b) => a[0] - b[0]);
  return {
    ...map,
    endpoints: eps.filter((_, i) => keep[i]),
    endpoints_total: eps.length,
    day_totals: dayTotals,
    seller_days: sellerDays,
  };
}

module.exports = { slimAtlas };
