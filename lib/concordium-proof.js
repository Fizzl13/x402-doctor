// A seller's zero-knowledge proof about the person behind its Concordium payTo (made with /concordium-proof.html,
// served by the seller at /.well-known/concordium-proof.json). The owner's Concordium wallet proves facts about the
// identity a regulated identity provider verified ("18 or older", "lives in the EU") without revealing them, for a
// challenge that ties the proof to one network, one site and one payTo:
//   sha256("concordium-x402-seller-proof:v1|<network>|<origin>|<payTo>")
// x402 Doctor checks, read-only and without paying:
//   1. the file is for this site, a Concordium payTo the 402 offers and that payTo's network, and the presentation
//      was made for that challenge (a copied proof fails on another site or payTo);
//   2. the zero-knowledge proofs verify, with Concordium's own verifier service (web3id-verifier.<network>);
//   3. the credential that proved it is the payTo account's own: an account's encryption key ends with the
//      registration id of its first credential (the wallet proxy's /v0/accEncryptionKey);
//   4. which facts the verified statements establish (adult, eu-residence, eu-nationality, id-document-valid), never
//      what the file claims.
// The same rules as the Concordium x402 facilitator in Fizzl13/x402-examples (src/proof.js), which verifies against
// its own node.
const crypto = require('node:crypto');
const { NETWORKS, isConcordiumNetwork, isConcordiumAccount } = require('./concordium-agent');

const PROOF_PATH = '/.well-known/concordium-proof.json';
const VERIFIER = {
  mainnet: process.env.CONCORDIUM_VERIFIER_MAINNET || 'https://web3id-verifier.mainnet.concordium.software/v0/verify',
  testnet: process.env.CONCORDIUM_VERIFIER_TESTNET || 'https://web3id-verifier.testnet.concordium.com/v0/verify',
};
const WALLET_PROXY = {
  mainnet: 'https://wallet-proxy.mainnet.concordium.software',
  testnet: 'https://wallet-proxy.testnet.concordium.com',
};
const EU = new Set(['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK']);
const FACT_TEXT = { adult: 'an adult (18 or older)', 'eu-residence': 'lives in the EU', 'eu-nationality': 'an EU national', 'id-document-valid': 'holds a valid identity document' };
const TIMEOUT_MS = 8000;

const challengeFor = (network, origin, payTo) => crypto.createHash('sha256').update(`concordium-x402-seller-proof:v1|${network}|${origin}|${payTo}`).digest('hex');
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');

// The facts a set of verified account-credential statements establishes, as of `now`.
function factsOf(statements, now = Date.now()) {
  const facts = new Set();
  const adultBy = new Date(now);
  adultBy.setUTCFullYear(adultBy.getUTCFullYear() - 18);
  adultBy.setUTCDate(adultBy.getUTCDate() + 1);
  for (const s of statements || []) {
    if (s?.type === 'AttributeInRange' && s.attributeTag === 'dob' && /^\d{8}$/.test(String(s.upper)) && String(s.upper) <= ymd(adultBy)) facts.add('adult');
    if (s?.type === 'AttributeInSet' && Array.isArray(s.set) && s.set.length && s.set.every((c) => EU.has(String(c).toUpperCase()))) {
      if (s.attributeTag === 'countryOfResidence') facts.add('eu-residence');
      if (s.attributeTag === 'nationality') facts.add('eu-nationality');
    }
    if (s?.type === 'AttributeInRange' && s.attributeTag === 'idDocExpiresAt' && String(s.lower) >= ymd(new Date(now))) facts.add('id-document-valid');
  }
  return [...facts].sort();
}

// The proof the seller of `url` serves, checked against the 402's Concordium payTos. null when no proof is served or
// the 402 has no Concordium payTo; otherwise { status: 'verified', network, payTo, facts, issuer, credential, created }
// or { status: 'invalid', reason } (or 'not-read' when Concordium's services can't be reached).
async function checkSellerProof(accepts, { url, safeFetch, fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const payTos = (accepts || []).filter((a) => isConcordiumNetwork(a?.network) && NETWORKS[a.network] && isConcordiumAccount(a?.payTo)).map((a) => ({ network: NETWORKS[a.network].id, payTo: a.payTo }));
  if (!payTos.length || !url) return null;
  let origin;
  try { origin = new URL(url).origin.toLowerCase(); } catch { return null; }
  let text;
  try {
    const res = await safeFetch(`${origin}${PROOF_PATH}`, { headers: { accept: 'application/json' } });
    if (res.status !== 200) return null;
    text = res.text;
  } catch { return null; }
  let file;
  try { file = JSON.parse(text); } catch { return { status: 'invalid', reason: 'the proof file is not JSON' }; }
  if (file?.type !== 'concordium-x402-seller-proof' || file.version !== 1) return { status: 'invalid', reason: 'not a concordium-x402-seller-proof v1 file' };
  const target = payTos.find((p) => p.payTo === file.payTo && p.network === file.network);
  if (!target) return { status: 'invalid', reason: `the proof is for ${file.network} payTo ${String(file.payTo).slice(0, 8)}…, which this 402 doesn't offer` };
  if (String(file.origin).toLowerCase() !== origin) return { status: 'invalid', reason: `the proof is tied to ${file.origin}, not ${origin}` };
  const challenge = challengeFor(target.network, origin, target.payTo);
  const vp = file.presentation;
  if (String(vp?.presentationContext || '').toLowerCase() !== challenge) return { status: 'invalid', reason: 'the presentation was not made for this site and payTo' };
  const creds = vp.verifiableCredential || [];
  if (creds.length !== 1 || !String(creds[0]?.credentialSubject?.id || '').includes(':cred:')) return { status: 'invalid', reason: 'expected one account credential' };
  const credential = String(creds[0].credentialSubject.id).split(':cred:')[1].toLowerCase();

  let verified;
  try {
    const res = await fetchImpl(VERIFIER[target.network], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(vp), signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await res.text();
    if (res.status === 400) return { status: 'invalid', reason: `the zero-knowledge proof does not verify (${body.slice(0, 120)})` };
    if (res.status === 404) return { status: 'invalid', reason: 'the credential is not on chain' };
    if (res.status !== 200) return { status: 'not-read', reason: `Concordium's verifier answered ${res.status}` };
    verified = JSON.parse(body);
  } catch (err) { return { status: 'not-read', reason: `Concordium's verifier could not be reached (${err?.message || err})` }; }
  const echoed = verified?.challenge ?? verified?.request?.challenge;
  if (String(echoed || '').toLowerCase() !== challenge) return { status: 'invalid', reason: 'verified for another challenge' };

  let key;
  try {
    const res = await fetchImpl(`${WALLET_PROXY[target.network]}/v0/accEncryptionKey/${target.payTo}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    key = String((await res.json())?.accountEncryptionKey || '').toLowerCase();
  } catch { return { status: 'not-read', reason: 'the payTo account could not be read' }; }
  if (!key || !key.endsWith(credential)) return { status: 'invalid', reason: 'the proof comes from a credential that is not the payTo account\'s' };

  const statements = (verified.credentialStatements || verified.request?.credentialStatements || []).flatMap((c) => c?.statement || []);
  const facts = factsOf(statements, now);
  const issuer = String(creds[0].issuer || '').split(':idp:')[1];
  return { status: 'verified', network: target.network, payTo: target.payTo, facts, issuer: issuer !== undefined ? Number(issuer) : null, credential, created: vp.proof?.created ?? file.created ?? null };
}

module.exports = { checkSellerProof, challengeFor, factsOf, FACT_TEXT, PROOF_PATH };
