'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { recoverTypedDataAddress } = require('viem');
const { DELEGATION_TYPES } = require('../lib/payee');
const PAYEES = require('../lib/payee-delegations.json');
const BUY_PAYEES = require('../lib/buy-payee-delegations.json');

// The delegations x402 Doctor (agent #97519) and Fizzl Buy (agent #988891) publish in their registration files: each
// signed by that agent's wallet, for its own origin.
for (const [name, payees, agentId, origin] of [['x402 Doctor', PAYEES, '97519', 'https://x402-doctor.fizzl.eu'], ['Fizzl Buy', BUY_PAYEES, '988891', 'https://buy.fizzl.eu']]) test(`published payee delegations (${name}): signed by the agent wallet, for agent #${agentId} on ${origin}, at most 365 days`, async () => {
  assert.ok(payees.length >= 4);
  for (const p of payees) {
    const m = p.delegation.message;
    assert.deepEqual([m.network, m.payTo, m.agentId, m.origin], [p.network, p.payTo, agentId, origin]);
    assert.ok(BigInt(m.validUntil) - BigInt(m.validAfter) <= 31536000n);
    const signer = await recoverTypedDataAddress({
      domain: { name: 'x402 Payee Delegation', version: '1', chainId: Number(m.chainId), verifyingContract: m.registry },
      types: DELEGATION_TYPES, primaryType: 'PayeeDelegation',
      message: { ...m, chainId: BigInt(m.chainId), agentId: BigInt(m.agentId), validAfter: BigInt(m.validAfter), validUntil: BigInt(m.validUntil) },
      signature: p.delegation.signature,
    });
    assert.equal(signer.toLowerCase(), m.agentWallet.toLowerCase(), p.network);
  }
});
