// Who gets paid, and for how much, compared with earlier daily scans. A seller can build a clean month of payout days
// and then change its payout address or its price; the track record per host doesn't show that. The daily Trust Index
// scan keeps, per endpoint, a short fingerprint of the payout address on each network and the price, with the day each
// last changed (mergeIndex in lib/trust-scan.js). The preflight compares the live 402 with them (changeReasons):
//
//   payto_changed   caution  the payout address on a network differs from the last daily scan, or changed in a daily
//                            scan of the last 7 days after it had been the same before
//   price_changed   caution  the price is higher than in the last daily scan (info when it is lower), or it changed in
//                            a daily scan of the last 7 days
//
// Fingerprints, not addresses: the index stays small, and the address itself is in the 402. Suggested on r/x402,
// 31 Oct 2026 ("payTo changed recently" and "price differs from last time" as their own warnings).
'use strict';

const crypto = require('node:crypto');
const { NETWORKS } = require('./networks');

const RECENT_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const caseless = (network) => String(network).startsWith('eip155:');
const fingerprint = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 10);

// { network: fingerprint } of the options' payout addresses (several on one network: of them together, sorted).
function payToMap(options) {
  const by = new Map();
  for (const o of options || []) {
    if (!o?.network || !o.pay_to || typeof o.pay_to !== 'string') continue;
    if (!by.has(o.network)) by.set(o.network, new Set());
    by.get(o.network).add(caseless(o.network) ? o.pay_to.toLowerCase() : o.pay_to);
  }
  const out = {};
  for (const [network, set] of by) out[network] = fingerprint([...set].sort().join(','));
  return out;
}

// The index entry's pt after today's scan: { a: {network: fingerprint}, s: day of the last change, c: [networks that
// changed then, left out when none] }. A network seen for the first time, or no longer offered, is not a change; only a network offered
// both times with another address is.
function mergePayTo(old, today, date) {
  if (!today || !Object.keys(today).length) return old || undefined;
  if (!old?.a) return { a: today, s: date };
  const changed = Object.keys(today).filter((n) => old.a[n] && old.a[n] !== today[n]);
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

const same = (a, b) => Math.abs(a - b) <= Math.max(a, b) * 0.01;
const netName = (n) => NETWORKS[n]?.name || n;
const usd = (x) => `$${Number(x.toPrecision(6))}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayText = (day) => { const [y, m, d] = String(day).split('-').map(Number); return d && m ? `${d} ${MONTHS[m - 1]} ${y}` : String(day); };
const daysAgo = (day, now) => Math.floor((now - Date.parse(`${day}T00:00:00Z`)) / DAY_MS);
const list = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]);

// The preflight's reasons from the live options and the endpoint's Trust Index record ({ payto, price, days, ... }).
function changeReasons({ record, options, now = Date.now() } = {}) {
  const out = [];
  if (!record) return out;
  const lastDay = record.days?.[record.days.length - 1];
  const live = payToMap(options);
  const pt = record.payto;
  if (pt?.a) {
    const differs = Object.keys(live).filter((n) => pt.a[n] && pt.a[n] !== live[n]);
    const recent = pt.c?.length && pt.s && daysAgo(pt.s, now) <= RECENT_DAYS;
    if (differs.length) {
      out.push({ level: 'caution', code: 'payto_changed', message: `The payout address on ${list(differs.map(netName))} is not the one x402 Doctor's daily scan saw${lastDay ? ` (last scan ${dayText(lastDay)})` : ''}. Check that the seller really moved its payouts before paying.` });
    } else if (recent) {
      out.push({ level: 'caution', code: 'payto_changed', message: `The payout address on ${list(pt.c.map(netName))} changed in the daily scan of ${dayText(pt.s)}, after it had been the same before. A seller with a clean record can still redirect payouts.` });
    }
  }
  const pr = record.price;
  const livePrices = (options || []).filter((o) => o?.payable && o.usd > 0).map((o) => o.usd);
  const cheapest = livePrices.length ? Math.min(...livePrices) : null;
  if (Array.isArray(pr) && pr[0] > 0 && cheapest !== null && !same(pr[0], cheapest)) {
    const higher = cheapest > pr[0];
    out.push({ level: higher ? 'caution' : 'info', code: 'price_changed', message: `Asks ${usd(cheapest)} now; the daily scan${lastDay ? ` of ${dayText(lastDay)}` : ''} saw ${usd(pr[0])}.` });
  } else if (Array.isArray(pr) && pr[2] > 0 && pr[1] && daysAgo(pr[1], now) <= RECENT_DAYS) {
    const higher = pr[0] > pr[2];
    out.push({ level: higher ? 'caution' : 'info', code: 'price_changed', message: `The price went from ${usd(pr[2])} to ${usd(pr[0])} in the daily scan of ${dayText(pr[1])}.` });
  }
  return out;
}

module.exports = { payToMap, mergePayTo, mergePrice, changeReasons, RECENT_DAYS };
