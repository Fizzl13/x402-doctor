const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decodeChallengeValue,
  checkEnvelope,
  checkAccepts,
} = require('../server.js');

test('decodeChallengeValue accepts raw JSON', () => {
  const challenge = { x402Version: 2, accepts: [{ network: 'eip155:8453', payTo: '0x1111111111111111111111111111111111111111', asset: '0x2222222222222222222222222222222222222222', amount: '100000' }] };
  const checks = [];
  const decoded = decodeChallengeValue(JSON.stringify(challenge), checks);

  assert.deepEqual(decoded, challenge);
  assert.equal(checks.length, 0);
});

test('decodeChallengeValue accepts base64-encoded JSON', () => {
  const challenge = { x402Version: 2, accepts: [{ network: 'solana:mainnet', payTo: '0x1111111111111111111111111111111111111111', asset: '0x2222222222222222222222222222222222222222', amount: '100000' }] };
  const checks = [];
  const encoded = Buffer.from(JSON.stringify(challenge)).toString('base64');
  const decoded = decodeChallengeValue(encoded, checks);

  assert.deepEqual(decoded, challenge);
  assert.equal(checks.length, 0);
});

test('checkEnvelope reads header-based v2 challenge and body mirror', async () => {
  const challenge = { x402Version: 2, accepts: [{ network: 'eip155:8453', payTo: '0x1111111111111111111111111111111111111111', asset: '0x2222222222222222222222222222222222222222', amount: '100000' }] };
  const checks = [];
  const res = {
    headers: new Map([['payment-required', Buffer.from(JSON.stringify(challenge)).toString('base64')]]),
    async text() {
      return JSON.stringify(challenge);
    },
  };

  const accepts = await checkEnvelope({ res }, checks);

  assert.ok(Array.isArray(accepts));
  assert.equal(accepts.length, 1);
  assert.equal(checks.some((check) => check.id === 'protocol-version' && check.status === 'pass'), true);
  assert.equal(checks.some((check) => check.id === 'envelope-body-mirror' && check.status === 'pass'), true);
});

test('checkAccepts flags malformed accepts entries and accepts valid CAIP-2 network ids', () => {
  const checks = [];
  const accepts = [
    { network: 'eip155:8453', payTo: '0x1111111111111111111111111111111111111111', asset: '0x2222222222222222222222222222222222222222', amount: '100000' },
    { network: 'mainnet', payTo: 'invalid', asset: 'not-address', amount: '0.10' },
  ];

  checkAccepts(accepts, checks);

  assert.equal(checks.some((check) => check.id === 'accepts[0]-network' && check.status === 'pass'), true);
  assert.equal(checks.some((check) => check.id === 'accepts[1]-network' && check.status === 'warn'), true);
  assert.equal(checks.some((check) => check.id === 'accepts[1]-payto' && check.status === 'fail'), true);
  assert.equal(checks.some((check) => check.id === 'accepts[1]-amount' && check.status === 'warn'), true);
});

test('checkAccepts validates payTo/asset as base58 for Solana entries, not EVM hex', () => {
  const checks = [];
  const accepts = [
    {
      network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      payTo: 'ATWJ82T8nRdQwZnaysB68N5EpaSvLRsQP4h6eWmaJBH9',
      asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      amount: '20000',
    },
  ];

  checkAccepts(accepts, checks);

  assert.equal(checks.some((check) => check.id === 'accepts[0]-network' && check.status === 'pass'), true);
  assert.equal(checks.some((check) => check.id === 'accepts[0]-payto' && check.status === 'pass'), true);
  assert.equal(checks.some((check) => check.id === 'accepts[0]-asset' && check.status === 'warn'), false);
});
