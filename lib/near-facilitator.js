// A self-hosted x402 facilitator for USDC on NEAR (near:mainnet, scheme exact), with the official @x402/near: the
// buyer signs a NEP-366 SignedDelegate for one ft_transfer to the seller's payTo, and our relayer account submits it
// and pays the NEAR gas, so neither buyer nor seller needs NEAR. No public facilitator listed near:mainnet when this
// was written (19 Nov 2026), so sellers had to run their own relayer; lib/facilitator-service.js puts credits, a free
// tier, the sanctions screen and a daily cap in front of this one.
//
// Two things the library leaves to its caller:
// - its settle is idempotent (the same signed delegate again returns the cached success, spec §10), which would let
//   a seller deliver twice for one payment: each signed delegate settles once here, a failed settle frees it;
// - the relayer's transaction nonce is read from the chain per settle, so two settles at the same moment would take
//   the same nonce: settles go one at a time. The relayer key must not be used by another service at the same time
//   (presign-guard has its own relayer).
//
// The relayer is a dedicated account with a little NEAR for gas, never a wallet that holds anything else. When its
// NEAR runs low (MIN_NEAR) settles are refused before anything is sent.
'use strict';

// @x402/near and the near-js libraries load only when a relayer is set (createNearFacilitator): Doctor keeps its memory.
const NEAR_MAINNET = 'near:mainnet';
const FASTNEAR_RPC = 'https://rpc.mainnet.fastnear.com';
const NEAR_USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const SECRET_KEY = /^(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]+$/;
const DAY_MS = 24 * 3600 * 1000;
const MIN_NEAR = 0.02; // below this the relayer stops settling (a settle burns well under 0.001 NEAR)
const BALANCE_TTL_MS = 5 * 60 * 1000;

// { accountId, secretKey, rpcUrl } from NEAR_FACILITATOR_ACCOUNT / NEAR_FACILITATOR_KEY (NEAR_FACILITATOR_RPC_URL
// optional); null when either is missing. Throws on a malformed account id or key, so a typo shows at start.
function nearConfig(env = process.env) {
  const accountId = (env.NEAR_FACILITATOR_ACCOUNT || '').trim();
  const secretKey = (env.NEAR_FACILITATOR_KEY || '').trim();
  if (!accountId || !secretKey) return null;
  if (!ACCOUNT.test(accountId)) throw new Error('NEAR_FACILITATOR_ACCOUNT is not a NEAR account id');
  if (!SECRET_KEY.test(secretKey)) throw new Error('NEAR_FACILITATOR_KEY must be a secret key like ed25519:…');
  return { accountId, secretKey, rpcUrl: (env.NEAR_FACILITATOR_RPC_URL || '').trim() || FASTNEAR_RPC };
}

const yoctoToNear = (yocto) => Number(BigInt(yocto) / 10n ** 20n) / 10_000; // 4 decimals

// A FacilitatorClient (getSupported/verify/settle) for near:mainnet, plus the relayer's id and NEAR balance.
// `scheme` replaces the real one in tests.
function createNearFacilitator({ accountId, secretKey, rpcUrl = FASTNEAR_RPC, scheme = null, fetchImpl = globalThis.fetch, now = () => Date.now(), minNear = MIN_NEAR, log = console }) {
  const { x402Facilitator } = require('@x402/core/facilitator');
  const { createFacilitatorNearSigner } = require('@x402/near');
  const { ExactNearScheme } = require('@x402/near/exact/facilitator');
  const facilitator = new x402Facilitator().register(NEAR_MAINNET, scheme || new ExactNearScheme(createFacilitatorNearSigner({
    relayers: [{ accountId, secretKey }],
    rpcUrls: { [NEAR_MAINNET]: rpcUrl },
  })));
  log.log(`[facilitator] NEAR facilitator on, relayer ${accountId}`);

  // The relayer's NEAR, read at most every 5 minutes: { near } or { error }.
  let cached = null;
  async function balance({ fresh = false } = {}) {
    if (!fresh && cached && now() - cached.at < BALANCE_TTL_MS) return cached.value;
    let value;
    try {
      const res = await fetchImpl(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: accountId } }),
        signal: AbortSignal.timeout(5000),
      });
      const j = await res.json();
      if (j.error || !j.result?.amount) throw new Error(j.error?.message || j.error?.cause?.name || 'no amount in the RPC answer');
      value = { account: accountId, near: yoctoToNear(j.result.amount) };
    } catch (err) {
      value = { account: accountId, near: null, error: err.message };
    }
    cached = { at: now(), value };
    return value;
  }

  const settled = new Map(); // signedDelegateAction -> expiry
  const prune = (t) => { for (const [k, until] of settled) if (until <= t) settled.delete(k); };
  let queue = Promise.resolve();

  async function settleOne(payload, requirements) {
    const network = requirements?.network || NEAR_MAINNET;
    const key = String(payload?.payload?.signedDelegateAction || '');
    const t = now();
    prune(t);
    if (!key) return { success: false, errorReason: 'invalid_payload', errorMessage: 'payload.signedDelegateAction is missing.', transaction: '', network, payer: '' };
    if (settled.has(key)) return { success: false, errorReason: 'duplicate_settlement', errorMessage: 'This payment was settled already.', transaction: '', network, payer: '' };
    const b = await balance();
    if (typeof b.near === 'number' && b.near < minNear) {
      return { success: false, errorReason: 'facilitator_relayer_low', errorMessage: `The relayer has too little NEAR for gas (${b.near}); try again later.`, transaction: '', network, payer: '' };
    }
    settled.set(key, t + DAY_MS);
    try {
      const out = await facilitator.settle(payload, requirements);
      if (!out?.success) settled.delete(key);
      cached = null; // gas was spent: read the balance again next time
      return out;
    } catch (err) {
      settled.delete(key);
      throw err;
    }
  }

  return {
    network: NEAR_MAINNET,
    asset: NEAR_USDC,
    relayer: async () => accountId,
    balance,
    getSupported: async () => facilitator.getSupported(),
    verify: (payload, requirements) => facilitator.verify(payload, requirements),
    // One at a time (the relayer's nonce); a settle that throws does not stop the next.
    settle(payload, requirements) {
      const run = queue.then(() => settleOne(payload, requirements));
      queue = run.catch(() => {});
      return run;
    },
  };
}

module.exports = { createNearFacilitator, nearConfig, NEAR_MAINNET, NEAR_USDC, MIN_NEAR };
