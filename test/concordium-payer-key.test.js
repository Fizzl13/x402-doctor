// The payer's key for a cross-network buyer proof (lib/concordium-payer-key.js): Solana from the address, EVM from a
// signature by the paying wallet, then whether the CIS-8 registry binds it (owner_of_key), and the two routes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { privateKeyToAccount } = require('viem/accounts');
const { payerKey, keyOf, keyMessage } = require('../lib/concordium-payer-key');

const BASE = 'eip155:8453';
const SOL = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const wallet = privateKeyToAccount(`0x${'11'.repeat(32)}`); // a test key, not a real wallet
const OWNER = '45R4vB9JnXDUkYVNBrQE8yyg6o2qH32g7fX5N7i9yWxHxnFP7J';
const sign = (address = wallet.address, network = BASE) => wallet.signMessage({ message: keyMessage(network, address) });

test('EVM: the key is recovered from the paying wallet\'s signature, and must be that address\'s', async () => {
  const k = await keyOf({ payerNetwork: BASE, address: wallet.address, signature: await sign() });
  assert.deepEqual(k.key, { namespace: BASE, key_type: 'secp256k1-uncompressed', public_key_hex: wallet.publicKey.slice(4).toLowerCase() });
  const other = '0x' + '22'.repeat(20);
  assert.match((await keyOf({ payerNetwork: BASE, address: other, signature: await sign(other) })).error, /not from this address/);
  assert.match((await keyOf({ payerNetwork: BASE, address: wallet.address })).error, /signature/);
  assert.match((await keyOf({ payerNetwork: BASE, address: wallet.address, signature: await sign(wallet.address, 'eip155:1') })).error, /not from this address/, 'signed for another network');
});

test('Solana: the address is the key; other chains are not offered yet', async () => {
  const k = await keyOf({ payerNetwork: SOL, address: '11111111111111111111111111111111' });
  assert.deepEqual(k.key, { namespace: SOL, key_type: 'ed25519', public_key_hex: '00'.repeat(32) });
  assert.match((await keyOf({ payerNetwork: SOL, address: 'nope' })).error, /Solana address/);
  assert.match((await keyOf({ payerNetwork: 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k', address: 'X' })).error, /only EVM/);
});

test('bound: the registry\'s owner, trying the paying network and then the EVM family\'s usual namespaces', async () => {
  const asked = [];
  const call = async (tool, args) => { asked.push([tool, args.external_key.namespace, args.external_key.public_key_hex.slice(0, 2), args.network, args.external_key.public_key_hex.length]); return args.external_key.namespace === 'eip155:1' ? { owner_account: OWNER, status: 'Active' } : null; };
  const out = await payerKey({ network: 'mainnet', payerNetwork: BASE, address: wallet.address, signature: await sign() }, { call });
  assert.equal(out.status, 200);
  assert.deepEqual([out.body.bound, out.body.account, out.body.key.namespace], [true, OWNER, 'eip155:1']);
  assert.deepEqual(asked.map((a) => a[1]), [BASE, 'eip155:1']);
  assert.ok(asked.every((a) => a[0] === 'owner_of_key' && a[2] === '04' && a[3] === 'mainnet' && a[4] === 130), 'the registry gets the 65-byte, 04-prefixed key');
});

test('not bound, revoked, unreadable, bad input', async () => {
  const sig = await sign();
  const none = await payerKey({ network: 'testnet', payerNetwork: BASE, address: wallet.address, signature: sig }, { call: async () => null });
  assert.deepEqual([none.body.bound, none.body.key.namespace], [false, BASE]);
  assert.match(none.body.reason, /no active binding/);
  assert.equal((await payerKey({ network: 'testnet', payerNetwork: BASE, address: wallet.address, signature: sig }, { call: async () => ({ owner_account: OWNER, status: 'Revoked' }) })).body.bound, false);
  const down = await payerKey({ network: 'testnet', payerNetwork: SOL, address: '11111111111111111111111111111111' }, { call: async () => { throw new Error('registry HTTP 503'); } });
  assert.equal(down.body.bound, null);
  assert.equal((await payerKey({ network: 'devnet', payerNetwork: BASE, address: wallet.address, signature: sig })).status, 400);
  assert.equal((await payerKey({ network: 'testnet', payerNetwork: BASE, address: 'x', signature: sig })).status, 400);
});

test('the routes: GET gives the message to sign, POST checks it', async () => {
  const { createApp } = require('../server');
  const app = createApp({ env: { USAGE_LOG_TOKEN: '' }, usageReader: { load: async () => ({ events: [] }) } });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/v1/concordium/payer-key`;
  try {
    const m = await (await fetch(`${base}?payerNetwork=${encodeURIComponent(BASE)}&address=${wallet.address}`)).json();
    assert.equal(m.message, keyMessage(BASE, wallet.address));
    assert.equal((await fetch(base)).status, 400);
    const bad = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ network: 'testnet', payerNetwork: BASE, address: wallet.address, signature: '0x' + '00'.repeat(65) }) });
    assert.equal(bad.status, 400);
  } finally { server.close(); }
});
