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

  const { accepts } = await checkEnvelope({ res }, checks);

  assert.ok(Array.isArray(accepts));
  assert.equal(accepts.length, 1);
  assert.equal(checks.some((check) => check.id === 'protocol-version' && check.status === 'pass'), true);
  assert.equal(checks.some((check) => check.id === 'envelope-body-mirror' && check.status === 'pass'), true);
});

test('checkEnvelope: a v1-shaped body with plain network names is the same payment as the v2 header (t0ll.xyz)', async () => {
  const opt = (network, asset) => ({ scheme: 'exact', network, payTo: '0xdC36D51963d08862c525045ccFD39FAe6a0C7F40', asset, amount: '50000' });
  const header = { x402Version: 2, accepts: [opt('eip155:4663', '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'), opt('eip155:8453', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')] };
  const v1 = (o, network) => ({ scheme: o.scheme, network, payTo: o.payTo, asset: o.asset, maxAmountRequired: o.amount });
  const run = async (body) => {
    const checks = [];
    await checkEnvelope({ res: { headers: new Map([['payment-required', Buffer.from(JSON.stringify(header)).toString('base64')]]), async text() { return JSON.stringify(body); } } }, checks);
    return checks.find((c) => c.id === 'envelope-body-mirror');
  };
  const same = await run({ x402Version: 1, accepts: [v1(header.accepts[0], 'robinhood'), v1(header.accepts[1], 'base')] });
  assert.equal(same.mirror, 'version', 'the same payment in the older format, not a different one');
  // An unknown plain name with the same terms is not another payment either; another payTo is.
  assert.equal((await run({ x402Version: 1, accepts: [v1(header.accepts[1], 'base-mainnet')] })).mirror, 'version');
  const other = await run({ x402Version: 1, accepts: [{ ...v1(header.accepts[1], 'base'), payTo: '0x1111111111111111111111111111111111111111' }] });
  assert.equal(other.mirror, 'terms');
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
  // Not CAIP-2, not a known name, no EVM payTo: unpayable for that reason; its amount isn't judged as EVM base units.
  assert.match(checks.find((check) => check.id === 'accepts[1]-payto').message, /no x402 client pays network "mainnet"/);
  assert.equal(checks.some((check) => check.id === 'accepts[1]-amount'), false);
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
