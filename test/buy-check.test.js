const test = require('node:test');
const assert = require('node:assert');
const { needsFor, basePrice, NEEDS, USER_AGENT } = require('../scripts/buy-check');

test('buy-check: reads the Base price from the 402 and rotates the needs by day', () => {
  const header = Buffer.from(JSON.stringify({ accepts: [
    { network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', scheme: 'exact', amount: '20000' },
    { network: 'eip155:8453', scheme: 'exact', amount: '20000' },
  ] })).toString('base64');
  assert.strictEqual(basePrice(header), 20000);
  assert.strictEqual(basePrice(Buffer.from(JSON.stringify({ accepts: [{ network: 'xrpl:0', scheme: 'exact', amount: '0.02' }] })).toString('base64')), null);
  const day = 864e5;
  assert.deepStrictEqual(needsFor(2, 0), NEEDS.slice(0, 2));
  assert.deepStrictEqual(needsFor(2, day), NEEDS.slice(1, 3));
  assert.strictEqual(needsFor(NEEDS.length + 1, 0).length, NEEDS.length + 1);
  // The user agent is what the public counts leave out (lib/public-stats.js).
  assert.match(USER_AGENT, /^x402-doctor-buy-check\//);
});
