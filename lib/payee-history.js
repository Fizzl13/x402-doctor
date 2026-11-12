// Who gets paid, and for how much, compared with earlier daily scans. A seller can build a clean month of payout days
// and then change its payout address or its price; the track record per host doesn't show that. The daily Trust Index
// scan keeps, per endpoint, a short fingerprint of the payout address on each network and the price, with the day each
// last changed (mergeIndex in lib/trust-scan.js). The preflight compares the live 402 with them (changeReasons):
//
//   payto_changed   caution  the payout address on a network differs from the last daily scan, or changed in a daily
//                            scan of the last 7 days after it had been the same before; an info line
//                            (payto_changed_bound) instead when the new address is bound to the seller's ERC-8004
//                            agent (ERC-8478 verified-wallet or verified-delegation)
//   payto_changed_alone caution  the same, for a change in a daily scan in which this was the only endpoint of its site
//                            that moved, while at least 3 others of the site kept their payout address. Most changes come
//                            per seller (a seller rotating its wallet: 91% of 357 changes on 2-3 Nov 2026), so one route
//                            paying somewhere new on its own is the rarer case and gets its own code. Site, not host
//                            name (lib/site.js): on 2 Nov one seller moved 250 endpoints at once across 64 subdomains,
//                            some with a single endpoint, which per host name looked like 64 separate moves.
//   price_changed   caution  the price is higher than in the last daily scan (info when it is lower), or it changed in
//                            a daily scan of the last 7 days
//
// Each reason also carries `change` (field pay_to or price; networks or from_usd/to_usd; kind differs_from_scan or
// changed_in_scan; day), which the preflight lists as changed_fields and changes, so an agent can compare without
// reading the codes (suggested on X, 10 Nov 2026).
//
// Fingerprints, not addresses: the index stays small, and the address itself is in the 402. Suggested on r/x402,
// 31 Oct 2026 ("payTo changed recently" and "price differs from last time" as their own warnings).
'use strict';

const crypto = require('node:crypto');
const { NETWORKS, tokenBurn } = require('./networks');

const RECENT_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const caseless = (network) => String(network).startsWith('eip155:');
const fingerprint = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 10);

// { network: fingerprint } of the options' payout addresses (several on one network: of them together, sorted).
// A deliberate token burn (lib/networks.js tokenBurn: 0x…dEaD or the incinerator with the seller's own token) next to
// a real payout address on the same network is an extra way to pay, not a payout address: adding or dropping one is
// no payout move. wafermap.xyz added a WAFERMAP burn beside its USDC payTo on Robinhood Chain on 3 Nov 2026, and the
// index counted its 35 endpoints as moved. A network with only a burn keeps it, so a payTo that becomes a burn address
// still counts. withBurns: the fingerprint as it was before (the index's older entries), to compare without a false move.
function payToMap(options, { withBurns = false } = {}) {
  const by = new Map();
  for (const o of options || []) {
    if (!o?.network || !o.pay_to || typeof o.pay_to !== 'string') continue;
    if (!by.has(o.network)) by.set(o.network, { pay: new Set(), burn: new Set() });
    const address = caseless(o.network) ? o.pay_to.toLowerCase() : o.pay_to;
    by.get(o.network)[!withBurns && tokenBurn(o.network, o.asset, o.pay_to) ? 'burn' : 'pay'].add(address);
  }
  const out = {};
  for (const [network, { pay, burn }] of by) out[network] = fingerprint([...(pay.size ? pay : burn)].sort().join(','));
  return out;
}

// The older fingerprints (burns included), only for the networks where they differ; null when none does.
function payToMapWithBurns(options) {
  const now = payToMap(options);
  const old = payToMap(options, { withBurns: true });
  const out = {};
  for (const n of Object.keys(old)) if (old[n] !== now[n]) out[n] = old[n];
  return Object.keys(out).length ? out : null;
}

// The index entry's pt after today's scan: { a: {network: fingerprint}, s: day of the last change, c: [networks that
// changed then, left out when none] }. A network seen for the first time, or no longer offered, is not a change; only a network offered
// both times with another address is.
// withBurns: today's older fingerprints (payToMapWithBurns), so an entry stored before burns were left out is not a move.
function mergePayTo(old, today, date, withBurns = null) {
  if (!today || !Object.keys(today).length) return old || undefined;
  if (!old?.a) return { a: today, s: date };
  const changed = Object.keys(today).filter((n) => old.a[n] && old.a[n] !== today[n] && old.a[n] !== withBurns?.[n]);
  if (changed.length) return { a: { ...old.a, ...today }, s: date, c: changed };
  return { ...old, a: { ...old.a, ...today } };
}

// The index entry's pr after today's scan: [price, day it became this price, the price before (left out at first)].
function mergePrice(old, price, date) {
  if (!(price > 0)) return old || undefined;
  if (!Array.isArray(old) || !(old[0] > 0)) return [price, date];
  if (same(old[0], price)) return old;
  return [price, date, old[0]];
}

// After a day's scan: for each endpoint whose payout address changed that day, how many endpoints of the same site moved
// that day, and how many of the site's endpoints have payout fingerprints at all: pt.m = [moved, of]. hostOf(url) gives
// the grouping key (the site, lib/site.js, from mergeIndex).
const ALONE_MIN_PEERS = 3;
function markHostMoves(resources, date, hostOf) {
  const byHost = new Map();
  for (const r of Object.values(resources || {})) {
    if (!r?.pt?.a) continue;
    const host = hostOf(r.url);
    if (!host) continue;
    const h = byHost.get(host) || { of: 0, moved: [] };
    h.of += 1;
    if (r.pt.s === date && Array.isArray(r.pt.c) && r.pt.c.length) h.moved.push(r);
    byHost.set(host, h);
  }
  for (const { of, moved } of byHost.values()) for (const r of moved) r.pt = { ...r.pt, m: [moved.length, of] };
  return resources;
}

const same = (a, b) => Math.abs(a - b) <= Math.max(a, b) * 0.01;
const netName = (n) => NETWORKS[n]?.name || n;
const usd = (x) => `$${Number(x.toPrecision(6))}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayText = (day) => { const [y, m, d] = String(day).split('-').map(Number); return d && m ? `${d} ${MONTHS[m - 1]} ${y}` : String(day); };
const daysAgo = (day, now) => Math.floor((now - Date.parse(`${day}T00:00:00Z`)) / DAY_MS);
const list = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]);

// payto_per_request (info): the seller asked for a new payout address on these networks on each of two requests.
function perRequestReason(networks, day) {
  return { level: 'info', code: 'payto_per_request', message: `The seller asks for a new payout address on ${list(networks.map(netName))} on every request (two requests in a row, two addresses), as payment processors with a deposit address per payment do, so no daily scan can vouch for it. Pass pay_to with the address your agent was asked to pay, and x402 Doctor screens that one.`, change: { field: 'pay_to', networks, kind: 'per_request', day: day || null, bound: false } };
}

// The preflight's reasons from the live options and the endpoint's Trust Index record ({ payto, price, days, ... }).
// bound: Map of network -> agent id for options whose payTo is bound to the seller's ERC-8004 agent (ERC-8478,
// verified-wallet or verified-delegation), or -> { concordium: 'agent #993 (testnet)' } for one bound to the seller's
// agent in Concordium's Agent Registry (its agent wallet or CIS-8 key): a moved address that is bound is the seller's
// own move, an info line.
// perRequest: Set of networks on which the seller asked x402 Doctor for a different payout address on each of two
// requests in a row (preflight's second look): a seller that hands out a deposit address per payment. Its address
// can't match any scan, so a difference from the scan says nothing there: an info line, payto_per_request. On 12 Nov
// 2026 three sellers did this on Base (a new address on every 402), and payto_changed made every preflight for them a
// caution.
function changeReasons({ record, options, now = Date.now(), bound = new Map(), perRequest = new Set() } = {}) {
  const out = [];
  if (!record) return out;
  const lastDay = record.days?.[record.days.length - 1];
  const live = payToMap(options);
  const liveWithBurns = payToMapWithBurns(options);
  const pt = record.payto;
  if (pt?.a) {
    const moved = Object.keys(live).filter((n) => pt.a[n] && pt.a[n] !== live[n] && pt.a[n] !== liveWithBurns?.[n]);
    const recentNets = pt.s && daysAgo(pt.s, now) <= RECENT_DAYS ? (pt.c || []) : [];
    const ok = [...new Set([...moved, ...recentNets])].filter((n) => bound.has(n));
    const fresh = [...new Set([...moved, ...recentNets])].filter((n) => perRequest.has(n) && !bound.has(n));
    const watched = (n) => !bound.has(n) && !perRequest.has(n);
    const differs = moved.filter(watched);
    const recent = recentNets.filter(watched).length > 0;
    if (fresh.length) out.push(perRequestReason(fresh, lastDay));
    if (ok.length) {
      const by = ok.map((n) => bound.get(n));
      const concordium = [...new Set(by.filter((v) => v && typeof v === 'object' && v.concordium).map((v) => v.concordium))];
      const erc = by.filter((v) => !(v && typeof v === 'object'));
      const agents = [...new Set(erc.filter(Boolean))];
      const whose = [
        ...(erc.length ? [`the seller's ERC-8004 agent${agents.length ? ` #${agents.join(', #')}` : ''} (ERC-8478)`] : []),
        ...(concordium.length ? [`the seller's ${concordium.join(', ')} in Concordium's Agent Registry (its agent wallet or CIS-8 key)`] : []),
      ];
      out.push({ level: 'info', code: 'payto_changed_bound', message: `The payout address on ${list(ok.map(netName))} changed since the daily scan, and the new one is bound to ${whose.join(' and ')}: the seller moved it.`, change: { field: 'pay_to', networks: ok, kind: moved.some((n) => ok.includes(n)) ? 'differs_from_scan' : 'changed_in_scan', day: (moved.some((n) => ok.includes(n)) ? lastDay : pt.s) || null, bound: true } });
    }
    if (differs.length) {
      out.push({ level: 'caution', code: 'payto_changed', message: `The payout address on ${list(differs.map(netName))} is not the one x402 Doctor's daily scan saw${lastDay ? ` (last scan ${dayText(lastDay)})` : ''}. Check that the seller really moved its payouts before paying.`, change: { field: 'pay_to', networks: differs, kind: 'differs_from_scan', day: lastDay || null, bound: false } });
    } else if (recent) {
      const changedNets = pt.c.filter(watched);
      const nets = list(changedNets.map(netName));
      const change = { field: 'pay_to', networks: changedNets, kind: 'changed_in_scan', day: pt.s, bound: false };
      const [moved, of] = Array.isArray(pt.m) ? pt.m : [null, null];
      if (moved === 1 && of - 1 >= ALONE_MIN_PEERS) {
        out.push({ level: 'caution', code: 'payto_changed_alone', message: `The payout address on ${nets} changed in the daily scan of ${dayText(pt.s)}, and this was the only endpoint of its site that moved: its ${of - 1} other endpoints kept theirs. Sellers usually move all their routes at once; one route paying somewhere new on its own is worth checking with the seller before paying.`, change });
      } else {
        const together = moved > 1 ? ` Together with ${moved - 1} other endpoint${moved === 2 ? '' : 's'} of the same site, as when a seller rotates its wallet.` : '';
        out.push({ level: 'caution', code: 'payto_changed', message: `The payout address on ${nets} changed in the daily scan of ${dayText(pt.s)}, after it had been the same before.${together} A seller with a clean record can still redirect payouts.`, change });
      }
    }
  }
  const pr = record.price;
  const livePrices = (options || []).filter((o) => o?.payable && o.usd > 0).map((o) => o.usd);
  const cheapest = livePrices.length ? Math.min(...livePrices) : null;
  if (Array.isArray(pr) && pr[0] > 0 && cheapest !== null && !same(pr[0], cheapest)) {
    const higher = cheapest > pr[0];
    out.push({ level: higher ? 'caution' : 'info', code: 'price_changed', message: `Asks ${usd(cheapest)} now; the daily scan${lastDay ? ` of ${dayText(lastDay)}` : ''} saw ${usd(pr[0])}.`, change: { field: 'price', from_usd: pr[0], to_usd: cheapest, kind: 'differs_from_scan', day: lastDay || null } });
  } else if (Array.isArray(pr) && pr[2] > 0 && pr[1] && daysAgo(pr[1], now) <= RECENT_DAYS) {
    const higher = pr[0] > pr[2];
    out.push({ level: higher ? 'caution' : 'info', code: 'price_changed', message: `The price went from ${usd(pr[2])} to ${usd(pr[0])} in the daily scan of ${dayText(pr[1])}.`, change: { field: 'price', from_usd: pr[2], to_usd: pr[0], kind: 'changed_in_scan', day: pr[1] } });
  }
  return out;
}

module.exports = { payToMap, payToMapWithBurns, mergePayTo, mergePrice, changeReasons, perRequestReason, RECENT_DAYS, markHostMoves };
