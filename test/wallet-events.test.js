'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWalletEvents } = require('../lib/wallet-events');

// A node whose eth_getLogs serves at most `max` blocks per call, with setting events at the given blocks.
function node({ events, max = 10, wallets = {} }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    calls.push(method);
    if (method === 'eth_getLogs') {
      const from = parseInt(params[0].fromBlock, 16), to = parseInt(params[0].toBlock, 16);
      if (to - from + 1 > max) return { json: async () => ({ error: { message: 'range too large' } }) };
      const logs = events.filter((b) => b >= from && b <= to).map((b) => ({ blockNumber: `0x${b.toString(16)}`, logIndex: '0x0', data: `0xset${b}` }));
      return { json: async () => ({ result: logs }) };
    }
    if (method === 'eth_call') {
      const b = parseInt(params[1], 16);
      const at = Object.keys(wallets).map(Number).filter((k) => k <= b).sort((x, y) => y - x)[0];
      return { json: async () => ({ result: `0x${'0'.repeat(24)}${(at === undefined ? '0'.repeat(40) : wallets[at].slice(2))}` }) };
    }
    throw new Error(method);
  };
  return { fetchImpl, calls };
}
const ID = { network: 'eip155:8453', chainId: 8453, registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432', agentId: '7', block: 100 };

test('wallet events: reads the log in chunks from walletSetAt, and keeps what it read', async () => {
  const n = node({ events: [40, 75] });
  const walletEvent = createWalletEvents({ rpcUrlFor: () => 'x', fetchImpl: n.fetchImpl, chunk: 10, budget: 20 });
  assert.deepEqual(await walletEvent(ID, 40), { block: 75, data: '0xset75' }, 'the latest setting from 40 on is the one in 75');
  const before = n.calls.length;
  assert.deepEqual(await walletEvent({ ...ID, block: 105 }, 75), { block: 75, data: '0xset75' });
  assert.equal(n.calls.length - before, 1, 'only the 5 new blocks are read');
  assert.equal(await walletEvent({ ...ID, block: 105 }, 80), null, 'nothing set from 80 on: the setting is earlier');
});

test('wallet events: a long history is read in the background; the check is not-read until then', async () => {
  const n = node({ events: [5] });
  const walletEvent = createWalletEvents({ rpcUrlFor: () => 'x', fetchImpl: n.fetchImpl, chunk: 10, budget: 3, log: { warn() {} } });
  await assert.rejects(walletEvent(ID, 1), /still reading/);
  for (let i = 0; i < 50 && n.calls.length < 10; i++) await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(await walletEvent(ID, 1), { block: 5, data: '0xset5' });
});

test('wallet events: walletSetAt finds the block the current wallet was set, also after a rotation away and back', async () => {
  const A = '0x' + 'aa'.repeat(20), B = '0x' + 'bb'.repeat(20);
  const n = node({ events: [20, 50, 80], wallets: { 20: A, 50: B, 80: A } });
  const walletEvent = createWalletEvents({ rpcUrlFor: () => 'x', fetchImpl: n.fetchImpl, chunk: 10, budget: 20 });
  // A binary search alone could stop at 20; the log from there on shows the later setting in 80.
  assert.equal(await walletEvent.walletSetAt({ ...ID, agentWallet: A }), 80);
});

test('wallet events: a seed saves reading the old history again', async () => {
  const n = node({ events: [] });
  const key = `eip155:8453:${ID.registry.toLowerCase()}:7`;
  const walletEvent = createWalletEvents({ rpcUrlFor: () => 'x', fetchImpl: n.fetchImpl, chunk: 10, budget: 2, seed: { [key]: { from: 1, to: 95, latest: { block: 30, data: '0xset30' } } } });
  assert.deepEqual(await walletEvent(ID, 30), { block: 30, data: '0xset30' });
  assert.equal(n.calls.length, 1, 'only blocks 96 to 100');
});
