// Unit tests for the "who can pay" summary.

const test = require('node:test');
const assert = require('node:assert/strict');
const { walletCompatibility, summaryCheck } = require('../lib/wallets');

const BASE = { scheme: 'exact', network: 'eip155:8453' };
const SOLANA = { scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' };
const find = (wallets, name) => wallets.find((w) => w.wallet === name);

test('Base only: EVM wallets and agents pay, the hint suggests Solana', () => {
  const wallets = walletCompatibility([BASE], []);
  assert.deepEqual(wallets.map((w) => w.wallet), ['MetaMask', 'Coinbase Wallet', 'Rabby', 'Phantom', 'x402 agents']);
  assert.ok(wallets.every((w) => w.yes.includes('Base') && w.no.length === 0));
  const check = summaryCheck([BASE], wallets);
  assert.match(check.message, /^Who can pay: MetaMask ✓ Base/);
  assert.match(check.hint, /Solana option would reach Solflare and Backpack/);
});

test('a Solana payout wallet without a USDC account blocks every Solana wallet', () => {
  const checks = [{ id: 'solana-payout-account', status: 'fail', option: 1 }];
  const wallets = walletCompatibility([BASE, SOLANA], checks);
  assert.deepEqual(find(wallets, 'Solflare'), { wallet: 'Solflare', agent: false, yes: [], no: [{ network: 'Solana', reason: 'the payout wallet has no USDC account' }] });
  assert.deepEqual(find(wallets, 'x402 agents').yes, ['Base']);
  assert.equal(summaryCheck([BASE, SOLANA], wallets).hint, undefined);
});

test('an option with a failed check is unpayable; the PayAI warning only affects Phantom on that option', () => {
  const checks = [
    { id: 'accepts[0]-extra', status: 'fail' },
    { id: 'solana-wallets', status: 'warn', option: 1 },
  ];
  const wallets = walletCompatibility([BASE, SOLANA], checks);
  assert.deepEqual(find(wallets, 'MetaMask').no, [{ network: 'Base', reason: 'the option has errors (see above)' }]);
  assert.deepEqual(find(wallets, 'Phantom').no.map((n) => n.reason), ['the option has errors (see above)', 'PayAI rejects Phantom transactions']);
  assert.deepEqual(find(wallets, 'Backpack').yes, ['Solana']);
});

test('testnet options are labelled, and Phantom EVM is limited to Base and Polygon', () => {
  const wallets = walletCompatibility([{ scheme: 'exact', network: 'eip155:84532' }, { scheme: 'exact', network: 'eip155:43114' }], []);
  assert.deepEqual(find(wallets, 'MetaMask').yes, ['Base Sepolia (testnet)', 'Avalanche']);
  assert.equal(find(wallets, 'Phantom'), undefined);
});

test('no usable wallet at all', () => {
  assert.deepEqual(walletCompatibility([{ scheme: 'exact', network: 'cosmos:hub' }], []), []);
  assert.match(summaryCheck([], []).message, /No payment option/);
});
