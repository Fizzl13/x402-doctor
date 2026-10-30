'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { recoverTypedDataAddress } = require('viem');
const { DELEGATION_TYPES } = require('../lib/payee');
const PAYEES = require('../lib/payee-delegations.json');

// The delegations x402 Doctor publishes in its registration file: each signed by its agent wallet for agent #97519.
test('published payee delegations: signed by the agent wallet, for agent #97519 on this origin, at most 365 days', async () => {
  assert.ok(PAYEES.length >= 4);
  for (const p of PAYEES) {
    const m = p.delegation.message;
    assert.deepEqual([m.network, m.payTo, m.agentId, m.origin], [p.network, p.payTo, '97519', 'https://x402-doctor.fizzl.eu']);
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
