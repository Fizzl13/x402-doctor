'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { privateKeyToAccount, generatePrivateKey } = require('viem/accounts');
const { verifyPayees, DELEGATION_TYPES, isEoaCode, docUrl } = require('../lib/payee');

const REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const URL_ = 'https://seller.example/api/thing';
const agent = privateKeyToAccount(generatePrivateKey()); // the agent wallet in these tests
const SOL_PAYTO = 'ATWJ82yHqQ3wXrQ3ZVf1Bd7wXLp2Pyc4e2JPxwh6JBH9';
const NOW = Date.UTC(2026, 9, 30, 20, 0, 0);
const OWNER = '0x0000000000000000000000000000000000c0ffee';
const hex = (s) => Buffer.from(s).toString('hex');
const abiString = (s) => `0x${'20'.padStart(64, '0')}${s.length.toString(16).padStart(64, '0')}${hex(s).padEnd(Math.ceil(hex(s).length / 64) * 64, '0')}`;

// A registry on Base: agent 7 has `wallet` as agent wallet (none for agent 8), with `code` at that wallet.
function chain({ wallet = agent.address, code = '0x', fail = null } = {}) {
  return async (network, method, params) => {
    if (fail && fail === method) throw new Error('RPC down');
    if (method === 'eth_blockNumber') return '0x100';
    if (method === 'eth_getCode') return code;
    const data = params[0].data, id = parseInt(data.slice(10, 74), 16);
    if (data.startsWith('0x00339509')) return `0x${(id === 7 ? wallet.slice(2) : '').padStart(64, '0')}`;
    if (data.startsWith('0xc87b56dd')) return abiString('https://seller.example/.well-known/agent-registration.json');
    if (data.startsWith('0x6352211e')) return `0x${OWNER.slice(2).padStart(64, '0')}`;
    throw new Error(`unexpected ${method}`);
  };
}
const DOC = { type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1', name: 'Seller', services: [{ name: 'web', endpoint: 'https://seller.example/' }] };
const file = (doc = DOC, agentId = '7') => [{ chainId: 8453, registry: REGISTRY, agentId, doc }];
const opt = (over) => ({ scheme: 'exact', network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '10000', payTo: agent.address, ...over });
const solOpt = (over) => opt({ network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', payTo: SOL_PAYTO, ...over });

async function delegation(over = {}, signer = agent) {
  const message = {
    chainId: '8453', registry: REGISTRY, agentId: '7', agentWallet: agent.address, network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    payTo: SOL_PAYTO, asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', origin: 'https://seller.example',
    validAfter: String(NOW / 1000 - 60), validUntil: String(NOW / 1000 + 86400 * 30), nonce: `0x${'ab'.repeat(32)}`, ...over,
  };
  const signature = await signer.signTypedData({
    domain: { name: 'x402 Payee Delegation', version: '1', chainId: 8453, verifyingContract: REGISTRY },
    types: DELEGATION_TYPES, primaryType: 'PayeeDelegation',
    message: { ...message, chainId: BigInt(message.chainId), agentId: BigInt(message.agentId), validAfter: BigInt(message.validAfter), validUntil: BigInt(message.validUntil) },
  });
  return { message, signature };
}
const run = (accepts, opts = {}) => verifyPayees(accepts, { url: URL_, fileIdentities: file(), rpc: chain(), fetchDoc: async () => DOC, now: NOW, ...opts });

test('payee verification: the agent wallet as payTo, on the registry chain and (for a key-held wallet) on other EVM chains', async () => {
  const [base, xlayer] = await run([opt(), opt({ network: 'eip155:196' })]);
  assert.equal(base.outcome, 'verified-wallet');
  assert.equal(base.identity.block, 256);
  assert.equal(xlayer.outcome, 'verified-wallet', 'an EOA controls the same address on X Layer');
  const designator = `0xef0100${'63c0c19a282a1b52b07dd5a65b58948a07dae32b'}`;
  assert.equal(isEoaCode(designator), true, 'an EIP-7702 account is still held by its key');
  const [, contract] = await run([opt(), opt({ network: 'eip155:196' })], { rpc: chain({ code: '0x6080604052' }) });
  assert.equal(contract.outcome, 'mismatch', 'a contract wallet on another chain needs a delegation');
});

test('payee verification: a payee delegation signed by the agent wallet, in extra.erc8004 or in the registration file', async () => {
  const d = await delegation();
  const [inExtra] = await run([solOpt({ extra: { erc8004: { registry: `eip155:8453:${REGISTRY}`, agentId: '7', delegation: d } } })]);
  assert.equal(inExtra.outcome, 'verified-delegation');
  const doc = { ...DOC, services: [...DOC.services, { name: 'x402', endpoint: URL_, payees: [{ network: d.message.network, payTo: SOL_PAYTO, delegation: d }] }] };
  const [inFile] = await run([solOpt()], { fileIdentities: file(doc) });
  assert.equal(inFile.outcome, 'verified-delegation');
  const [none] = await run([solOpt()]);
  assert.equal(none.outcome, 'mismatch');
});

test('payee verification: an invalid delegation says which rule it fails', async () => {
  const reason = async (d) => {
    const [r] = await run([solOpt({ extra: { erc8004: { registry: `eip155:8453:${REGISTRY}`, agentId: '7', delegation: d } } })]);
    assert.equal(r.outcome, 'invalid-delegation');
    return r.reason;
  };
  assert.equal(await reason(await delegation({ validUntil: String(NOW / 1000 - 1) })), 'expired');
  assert.equal(await reason(await delegation({ payTo: 'SomeOtherSolanaAddress1111111111111111111111' })), 'it names another payTo');
  assert.equal(await reason(await delegation({ origin: 'https://other.example' })), 'it is for origin https://other.example');
  assert.equal(await reason(await delegation({ validUntil: String(NOW / 1000 + 400 * 86400) })), 'valid for more than 365 days');
  assert.equal(await reason(await delegation({}, privateKeyToAccount(generatePrivateKey()))), "the signature is not the agent wallet's");
  const tampered = await delegation();
  tampered.message.asset = '*'; // widened after signing
  assert.equal(await reason(tampered), "the signature is not the agent wallet's");
  assert.equal(await reason(await delegation({ agentWallet: '0x1111111111111111111111111111111111111111' })), 'it was signed for another agent wallet (rotated since?)');
});

test('payee verification: endpoint-unlisted, no-agent-wallet, not-read and no-identity', async () => {
  const [unlisted] = await run([opt()], { url: 'https://elsewhere.example/x' });
  assert.equal(unlisted.outcome, 'endpoint-unlisted');
  const [noWallet] = await run([opt()], { fileIdentities: file(DOC, '8') });
  assert.equal(noWallet.outcome, 'no-agent-wallet');
  const [down] = await run([opt()], { rpc: chain({ fail: 'eth_call' }) });
  assert.equal(down.outcome, 'not-read', 'a failed read is never a pass or a fail');
  assert.match(down.reason, /agent wallet/);
  const [ownerOnly] = await run([opt({ payTo: OWNER })], { fileIdentities: file(DOC, '8') });
  assert.equal(ownerOnly.outcome, 'owner-only', 'no agent wallet, payTo is the owner: reported, never verified');
  const [ownerElsewhere] = await run([opt({ payTo: OWNER, network: 'eip155:196' })], { fileIdentities: file(DOC, '8') });
  assert.equal(ownerElsewhere.outcome, 'no-agent-wallet', 'owner-only holds on the registry\'s chain only');
  const [ownerDown] = await run([opt({ payTo: OWNER })], { fileIdentities: file(DOC, '8'), rpc: async (n, m, params) => { if (m === 'eth_call' && params[0].data.startsWith('0x6352211e')) throw new Error('RPC down'); return chain()(n, m, params); } });
  assert.equal(ownerDown.outcome, 'not-read');
  assert.match(ownerDown.reason, /owner/);
  const [anon] = await run([opt()], { fileIdentities: [] });
  assert.equal(anon.outcome, 'no-identity');
  const named = await run([opt({ extra: { erc8004: { registry: `eip155:8453:${REGISTRY}`, agentId: '7' } } })], { fileIdentities: [] });
  assert.equal(named[0].outcome, 'verified-wallet', 'an identity named in extra.erc8004 is read from the registry and its tokenURI');
});

test('payee verification: an ipfs:// tokenURI is read through a public gateway', () => {
  assert.equal(docUrl('ipfs://bafkreien3ak5'), 'https://gateway.pinata.cloud/ipfs/bafkreien3ak5');
  assert.equal(docUrl('ipfs://ipfs/bafy/agent.json'), 'https://gateway.pinata.cloud/ipfs/bafy/agent.json');
  assert.equal(docUrl('https://seller.example/agent.json'), 'https://seller.example/agent.json');
});
