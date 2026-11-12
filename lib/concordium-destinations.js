'use strict';

// Lock destinations: for the sellers an agent may pay, the payout addresses Concordium vouches for.
//
// Concordium's Protocol-Level Locks (announced for early 2027) ring-fence an agent's funds to pre-defined
// destinations, so a compromised agent can't send them anywhere else. The chain enforces the list; it doesn't say
// which addresses belong on it. This does, from the same check the Fizzl Agent Wallet runs before it pays
// (lib/concordium-seller.js): a seller's payTo goes on the list only when the seller's Agent Card carries a Verified
// by Concordium badge whose agent is Active in the registry, the card is the one anchored on chain, it lists the
// seller's origin, and that payTo is the agent's own wallet, the key it bound with CIS-8, or a smart wallet that key
// owns. Everything else is left off, with the reason. Until locks ship, the same list is an allow-list for a wallet's
// spend rules. Read-only: nothing is paid, signed or registered here.
//
//   concordiumDestinations(urls, { safeFetch, check }) ->
//     { checked_at, destinations: [{ network, payTo, seller, how, agent }], refused: [{ seller, payTo?, network?,
//       reason }], allowlist: { <network>: [payTo, …] }, note }

const { concordiumSeller } = require('./concordium-seller');

const MAX_SELLERS = 10;
const PARALLEL = 3;
// The payee outcomes (lib/concordium-agent.js) that put a payTo on the list.
const VOUCHED = {
  'verified-wallet': "the agent's own wallet in the registry",
  'verified-external-key': 'the key the agent bound with CIS-8',
  'verified-safe-owner': 'a smart wallet the bound key owns (read live)',
};

// The sellers a caller passes: 1 to 10 distinct http(s) URLs; anything else is refused.
function cleanSellers(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_SELLERS) throw Object.assign(new Error(`urls must be a list of 1 to ${MAX_SELLERS} seller URLs`), { status: 400 });
  const out = [];
  for (const u of value) {
    if (typeof u !== 'string' || u.length > 2000 || !/^https?:\/\//i.test(u)) throw Object.assign(new Error('each url must be an http or https URL'), { status: 400 });
    try { new URL(u); } catch { throw Object.assign(new Error(`not a valid URL: ${u.slice(0, 80)}`), { status: 400 }); }
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function concordiumDestinations(urls, { safeFetch, check = concordiumSeller, now = () => Date.now() } = {}) {
  const sellers = cleanSellers(urls);
  const seen = await mapLimit(sellers, PARALLEL, async (seller) => {
    try { return { seller, view: await check(seller, { safeFetch }) }; } catch (err) { return { seller, error: err.message }; }
  });
  const destinations = [];
  const refused = [];
  for (const { seller, view, error } of seen) {
    if (error) { refused.push({ seller, reason: `could not be checked: ${String(error).slice(0, 200)}` }); continue; }
    const badge = view?.badge;
    if (!badge) { refused.push({ seller, reason: "no Verified by Concordium badge in the seller's Agent Card" }); continue; }
    if (badge.verdict === 'problem') { refused.push({ seller, reason: String(badge.summary || 'the badge does not hold for this seller').slice(0, 300) }); continue; }
    const agent = badge.agent ? { network: badge.agent.network, tokenId: badge.agent.tokenId, owner: badge.agent.owner } : null;
    if (!badge.payees?.length) refused.push({ seller, reason: 'the seller names no payout address to compare' });
    for (const p of badge.payees || []) {
      if (VOUCHED[p.outcome]) {
        if (!destinations.some((d) => d.network === p.network && d.payTo === p.payTo)) destinations.push({ network: p.network, payTo: p.payTo, seller, how: VOUCHED[p.outcome], agent });
      } else {
        refused.push({ seller, network: p.network, payTo: p.payTo, reason: `not vouched for (${p.outcome})` });
      }
    }
  }
  const allowlist = {};
  for (const d of destinations) (allowlist[d.network] ||= []).push(d.payTo);
  return {
    checked_at: new Date(now()).toISOString(),
    destinations,
    refused,
    allowlist,
    note: "The payout addresses Concordium's Agent Registry vouches for, per network: the destinations to ring-fence an agent's funds to (Protocol-Level Locks, announced for early 2027), or the allow-list of a wallet's spend rules today. A seller is checked as it is now: ask again before relying on an old list.",
  };
}

module.exports = { concordiumDestinations, cleanSellers, MAX_SELLERS, VOUCHED };
