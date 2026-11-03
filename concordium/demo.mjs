// Concordium Trusted Agents demo: before an agent pays an x402 endpoint, is the payTo really the wallet of the
// identity-backed agent the seller claims to be?
//
//   node concordium/demo.mjs
//
// Read-only and nothing is paid. Every case reads Concordium's Agent Registry on testnet live (through Concordium's
// hosted registry service) and fetches the agent's card from its on-chain agent_uri:
// 1. x402 Doctor itself (agent #993): its real 402, its real Agent Card.
// 2. A copycat: Doctor's card, badge and all, copied to another server that wants to be paid.
// 3. A swapped payTo: Doctor's own origin and card, but the 402 asks to pay someone else.
// 4. A revoked agent: a card that shows the badge of an agent its owner revoked.
// Each case also prints what x402 Doctor's paid preflight adds to its verdict (info or caution, with its code).
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const { verifyConcordiumPayees } = require('../lib/concordium-agent');
const { concordiumReasons } = require('../lib/preflight');
const { base58Decode } = require('../lib/networks');

const DOCTOR = 'https://x402-doctor.fizzl.eu';
const PAID = `${DOCTOR}/api/v1/diagnose?url=https://example.com`;
const ATTACKER = '0xBAD0000000000000000000000000000000000BAD';
const c = { green: '\x1b[32m', orange: '\x1b[33m', red: '\x1b[31m', dim: '\x1b[2m', bold: '\x1b[1m', off: '\x1b[0m' };

// safeFetch as x402 Doctor uses it: { status, text }.
const realFetch = async (url, init) => { const r = await fetch(url, init); return { status: r.status, text: await r.text() }; };
// The same, with some URLs answered by an attacker's server.
const withPages = (pages) => async (url, init) => (url in pages ? { status: 200, text: pages[url] } : realFetch(url, init));

// A CIS-2 token address in the registry contract <12802,0> (testnet): Base58Check of 2, LEB128 index, subindex, id.
function badgeOf(tokenId, index = 12802) {
  const leb = [];
  let n = index;
  do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; leb.push(b); } while (n);
  const id = Buffer.alloc(8); id.writeBigUInt64LE(BigInt(tokenId));
  const payload = Buffer.from([2, ...leb, 0, ...id]);
  const sum = crypto.createHash('sha256').update(crypto.createHash('sha256').update(payload).digest()).digest().subarray(0, 4);
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let x = BigInt(`0x${Buffer.concat([payload, sum]).toString('hex')}`);
  let s = '';
  while (x > 0n) { s = ALPHABET[Number(x % 58n)] + s; x /= 58n; }
  if (!base58Decode(s)) throw new Error('bad badge');
  return s;
}

async function accepts(url) {
  const res = await fetch(url);
  const header = res.headers.get('payment-required');
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8')).accepts;
}

const short = (a) => (String(a).length > 14 ? `${String(a).slice(0, 6)}…${String(a).slice(-4)}` : String(a));
const color = (o) => (o.startsWith('verified-') ? c.green : ['mismatch', 'revoked', 'card-mismatch', 'endpoint-unlisted'].includes(o) ? c.red : c.dim);

async function show(title, accepted, opts) {
  console.log(`\n${c.bold}${title}${c.off}`);
  const found = await verifyConcordiumPayees(accepted, opts);
  const { agent, results } = found;
  if (!agent) { console.log(`  ${c.dim}no Concordium badge on this server${c.off}`); return 'none'; }
  if (agent.network) console.log(`  ${c.dim}badge ${agent.tokenAddress} → agent #${agent.tokenId} on ${agent.network}, owner ${short(agent.owner)} (identity-verified account), status ${agent.status}${c.off}`);
  for (const r of results) console.log(`  ${(r.network || '').padEnd(42)} ${short(r.payTo).padEnd(14)} ${color(r.outcome)}${r.outcome}${c.off}${r.reason && !r.outcome.startsWith('verified-') ? ` ${c.dim}(${r.reason})${c.off}` : ''}`);
  const bad = results.some((r) => ['mismatch', 'revoked', 'card-mismatch', 'endpoint-unlisted'].includes(r.outcome));
  const ok = results.filter((r) => r.outcome.startsWith('verified-'));
  const verdict = bad ? `${c.red}refuses to pay${c.off}` : ok.length ? `${c.green}pays on ${ok.map((r) => r.network).join(' or ')}${c.off}` : `${c.orange}asks its owner first${c.off}`;
  console.log(`  agent: ${verdict}`);
  // What x402 Doctor's paid preflight adds to its verdict for this (lib/preflight.js).
  for (const r of concordiumReasons(found, accepted.map((a) => ({ network: a.network })))) {
    console.log(`  ${c.dim}preflight:${c.off} ${r.level === 'info' ? c.green : c.orange}${r.level} ${r.code}${c.off} ${c.dim}${r.message}${c.off}`);
  }
  return bad ? 'refused' : ok.length ? 'paid' : 'asked';
}

const doctorAccepts = await accepts(PAID);
const card = (await realFetch(`${DOCTOR}/.well-known/agent-card.json`)).text;
console.log(`x402 Doctor's paid route answers 402 with ${doctorAccepts.length} payment options. Nothing is paid.`);

const out = [];
out.push(await show('1. x402 Doctor itself (Concordium agent #993)', doctorAccepts, { url: PAID, safeFetch: realFetch }));
out.push(await show('2. A copycat server shows the same card and badge', doctorAccepts.map((a) => ({ ...a, payTo: a.network.startsWith('eip155:') ? ATTACKER : a.payTo })), {
  url: 'https://x402-doct0r.example/api/v1/diagnose',
  safeFetch: withPages({ 'https://x402-doct0r.example/.well-known/agent-card.json': card }),
}));
out.push(await show("3. Doctor's own card, but the 402 asks to pay someone else on Base", doctorAccepts.filter((a) => a.network === 'eip155:8453').map((a) => ({ ...a, payTo: ATTACKER })), { url: PAID, safeFetch: realFetch }));
const revokedBadge = badgeOf(15);
const revokedCard = JSON.stringify({ name: 'Old agent', url: 'https://old-agent.example', capabilities: { extensions: [{ uri: 'https://docs.concordium.com/a2a-extensions/concordium-badge/v1', params: { tokenAddress: `ccd:4221332d34e1694168c2a0c0b3fd0f27/cis-2:${revokedBadge}` } }] } });
out.push(await show('4. A card that shows the badge of a revoked agent', [{ network: 'eip155:8453', payTo: ATTACKER }], {
  url: 'https://old-agent.example/paid',
  safeFetch: withPages({ 'https://old-agent.example/.well-known/agent-card.json': revokedCard }),
}));

console.log(`\nPaid ${out.filter((o) => o === 'paid').length} of ${out.length}; refused ${out.filter((o) => o === 'refused').length}.`);
