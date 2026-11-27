'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { recoverTypedDataAddress } = require('viem');
const { DELEGATION_TYPES } = require('../lib/payee');
const PAYEES = require('../lib/payee-delegations.json');
const BUY_PAYEES = require('../lib/buy-payee-delegations.json');

// The delegations x402 Doctor (agent #97519) and Fizzl Buy (agent #988891) publish in their registration files: each
// signed by that agent's wallet, for its own origin. Version 2 (ERC-8478 after 27 Nov 2026: walletSetAt, at most 90
// days); the version 1 files signed before that (365 days) are checked as what they are until they are re-signed.
for (const [name, payees, agentId, origin] of [['x402 Doctor', PAYEES, '97519', 'https://x402-doctor.fizzl.eu'], ['Fizzl Buy', BUY_PAYEES, '988891', 'https://buy.fizzl.eu']]) test(`published payee delegations (${name}): signed by the agent wallet, for agent #${agentId} on ${origin}, within the version's window`, async () => {
  assert.ok(payees.length >= 4);
  for (const p of payees) {
    const m = p.delegation.message;
    assert.deepEqual([m.network, m.payTo, m.agentId, m.origin], [p.network, p.payTo, agentId, origin]);
    const v2 = m.walletSetAt !== undefined;
    assert.ok(BigInt(m.validUntil) - BigInt(m.validAfter) <= (v2 ? 7776000n : 31536000n));
    const signer = await recoverTypedDataAddress({
      domain: { name: 'x402 Payee Delegation', version: v2 ? '2' : '1', chainId: Number(m.chainId), verifyingContract: m.registry },
      types: v2 ? DELEGATION_TYPES : { PayeeDelegation: DELEGATION_TYPES.PayeeDelegation.filter((f) => f.name !== 'walletSetAt') }, primaryType: 'PayeeDelegation',
      message: { ...m, chainId: BigInt(m.chainId), agentId: BigInt(m.agentId), validAfter: BigInt(m.validAfter), validUntil: BigInt(m.validUntil), ...(v2 ? { walletSetAt: BigInt(m.walletSetAt) } : {}) },
      signature: p.delegation.signature,
    });
    assert.equal(signer.toLowerCase(), m.agentWallet.toLowerCase(), p.network);
  }
});
