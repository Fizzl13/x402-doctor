'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyPayees } = require('../lib/payee');
const V = require('./fixtures/erc8478-vectors.json');

// The 18 test vectors of ERC-8478 (ethereum/ERCs#2132, assets/erc-8478/vectors.json as of the 27 Nov 2026 editor
// review), run through x402 Doctor's payee check with the reads the vectors give.
const hex64 = (n) => BigInt(n).toString(16).padStart(64, '0');
const abiString = (s) => { const h = Buffer.from(s).toString('hex'); return `0x${hex64(32)}${hex64(s.length)}${h.padEnd(Math.ceil(h.length / 64) * 64, '0')}`; };
// abi.encode(string "agentWallet", bytes value): the MetadataSet event's data.
const eventData = (value) => {
  const key = Buffer.from('agentWallet').toString('hex');
  const v = value && !/^0x0{40}$/i.test(value) ? value.slice(2).toLowerCase() : '';
  return `0x${hex64(64)}${hex64(128)}${hex64(11)}${key.padEnd(64, '0')}${hex64(v.length / 2)}${v.padEnd(64, '0').slice(0, v ? 64 : 64)}`;
};

for (const v of V.vectors) {
  test(`ERC-8478 vector: ${v.name}`, async () => {
    const id = V.identity;
    const wallet = v.agentWallet !== undefined ? v.agentWallet : V.agentWallet;
    const block = Number(V.block);
    const rpc = async (network, method, params) => {
      assert.equal(network, `eip155:${id.chainId}`);
      if (method === 'eth_blockNumber') return `0x${block.toString(16)}`;
      if (method === 'eth_getCode') return v.agentWalletCode ?? '0x';
      const data = params[0].data;
      if (data.startsWith('0x00339509')) return `0x${(wallet || '0x0').slice(2).padStart(64, '0')}`;
      if (data.startsWith('0x6352211e')) return `0x${V.owner.slice(2).padStart(64, '0')}`;
      if (data.startsWith('0xc87b56dd')) return abiString('https://seller.example/.well-known/agent-registration.json');
      throw new Error(`unexpected ${method}`);
    };
    const ev = v.walletEvent || { block: V.walletSetAt, value: wallet };
    const walletEvent = async (identity, from) => (Number(ev.block) >= from && Number(ev.block) <= block ? { block: Number(ev.block), data: eventData(ev.value) } : null);
    const accept = {
      scheme: 'exact', amount: '10000', ...v.requirement,
      extra: { erc8004: { registry: `eip155:${id.chainId}:${id.registry}`, agentId: id.agentId, delegation: v.delegation || null } },
    };
    const [r] = await verifyPayees([accept], { url: v.requirement.resource, rpc, fetchDoc: async () => v.registration, walletEvent, now: v.t * 1000 });
    assert.equal(r.outcome, v.expect.outcome, r.reason);
    assert.equal(r.delegationRule, v.expect.delegationRule);
    assert.deepEqual(r.notes, v.expect.notes);
    if (v.expect.notRead) assert.equal(r.notRead, v.expect.notRead);
  });
}
