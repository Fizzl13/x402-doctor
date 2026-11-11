'use strict';

// "Verified by Concordium" for one seller, without the full check: what a wallet shows next to a seller and checks
// right before its agent pays. The badge in the seller's Agent Card, its agent in Concordium's Agent Registry and
// every payTo against it (lib/concordium-agent.js), and a zero-knowledge seller proof when one is served
// (lib/concordium-proof.js). A wallet passes the payTo it is about to pay (accepts), so the check is about that
// address; without accepts the endpoint's 402 is read once. Read-only: no payment, no outreach draft, no other checks.
//
//   badge: null (no badge in the seller's card) or
//     { verdict: 'verified' (every payTo is the agent's) | 'partial' (some can't be compared) | 'problem' (a payTo
//       that isn't the agent's, a revoked agent, a card changed after anchoring, an origin the card doesn't list),
//       summary, agent: { network, tokenId, tokenAddress, owner, agentWallet }, payees: [{ network, payTo, outcome }], fix }
//   proof: null or { status: 'verified' | 'invalid' | 'unchecked', facts: ['adult', …], network, summary }
// Without accepts (a seller in a search result) the card is read first: a seller without a badge costs that one
// small read, and its 402 is not asked for (nor a proof looked for).

const { checkConcordiumAgent, checkConcordiumProof, probe402, checkEnvelope } = require('./diagnose');
const { cardBadge } = require('./concordium-agent');

const VERDICT = { pass: 'verified', info: 'partial', warn: 'problem' };
const MAX_ACCEPTS = 10;

// The accepts a caller passes: at most ten { network, payTo, asset? } with short strings; anything else is refused.
function cleanAccepts(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || !value.length || value.length > MAX_ACCEPTS) throw Object.assign(new Error(`accepts must be a list of 1 to ${MAX_ACCEPTS} payment options`), { status: 400 });
  return value.map((a) => {
    const ok = (s) => typeof s === 'string' && s.length > 0 && s.length <= 200;
    if (!a || !ok(a.network) || !ok(a.payTo) || (a.asset !== undefined && !ok(a.asset))) throw Object.assign(new Error('each payment option needs network and payTo (strings), asset optional'), { status: 400 });
    return { network: a.network, payTo: a.payTo, ...(a.asset ? { asset: a.asset } : {}) };
  });
}

function view(url, checks) {
  const a = checks.find((c) => c.id === 'concordium-agent');
  const p = checks.find((c) => c.id === 'concordium-proof');
  return {
    url,
    badge: a ? {
      verdict: VERDICT[a.status] ?? 'partial',
      summary: a.message,
      agent: a.agent ? { network: a.agent.network ?? null, tokenId: a.agent.tokenId ?? null, tokenAddress: a.agent.tokenAddress ?? null, owner: a.agent.owner ?? null, agentWallet: a.agent.agentWallet ?? null } : null,
      payees: (a.payees || []).map((r) => ({ network: r.network, payTo: r.payTo, outcome: r.outcome })),
      ...(a.hint ? { fix: a.hint } : {}),
    } : null,
    proof: p ? {
      status: p.status === 'pass' ? 'verified' : p.status === 'warn' ? 'invalid' : 'unchecked',
      facts: p.proof?.facts ?? [],
      network: p.proof?.network ?? null,
      summary: p.message,
    } : null,
  };
}

async function concordiumSeller(url, { accepts = null, safeFetch, fetchImpl } = {}) {
  let options = accepts;
  if (!options) {
    let badge = null;
    try {
      const res = await safeFetch(`${new URL(url).origin}/.well-known/agent-card.json`, { headers: { accept: 'application/json' } });
      if (res.status === 200) badge = cardBadge(JSON.parse(res.text));
    } catch {}
    if (!badge) return view(url, []);
    const probe = await probe402(url, safeFetch, [], 'GET');
    const challenge = probe ? await checkEnvelope(probe, []) : null;
    options = Array.isArray(challenge?.accepts) ? challenge.accepts : [];
  }
  const checks = [];
  if (options.length) {
    await Promise.all([
      checkConcordiumAgent(options, url, checks, { safeFetch, fetchImpl }),
      checkConcordiumProof(options, url, checks, { safeFetch, fetchImpl }),
    ]);
  }
  return view(url, checks);
}

module.exports = { concordiumSeller, cleanAccepts, view };
