// Stellar (x402 "exact" with a Soroban token transfer, @x402/stellar): network, StrKey addresses with checksum, the
// USDC contract, 7-decimal amounts, sponsored fees, the payout trustline, and preflight pricing.
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkAccepts, checkStellar } = require('../lib/diagnose');
const { isStellarAddress, familyOf, dollarToken } = require('../lib/networks');
const { walletCompatibility } = require('../lib/wallets');

const XLM = 'stellar:pubnet';
const XLM_TEST = 'stellar:testnet';
const USDC = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75';
const USDC_TEST = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const PAY_TO = 'GDNJXCKW7ZM7GEEVP674TWPU26YJNBQ2FI4ZIPRKTPTNUEJMDHFJWWRL'; // a real payout account from the Trust Index
const option = (extra = {}) => ({ scheme: 'exact', network: XLM, asset: USDC, amount: '100000', payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { areFeesSponsored: true }, ...extra });
const horizon = (status, body = {}) => async (url) => { horizon.last = url; return new Response(JSON.stringify(body), { status }); };

test('addresses: StrKey version byte and CRC16 checksum, G/C/M kinds, family from the network id', () => {
  assert.equal(isStellarAddress(PAY_TO), true);
  assert.equal(isStellarAddress(USDC), true);
  assert.equal(isStellarAddress(USDC, 'C'), true);
  assert.equal(isStellarAddress(PAY_TO, 'C'), false, 'an account is not a contract');
  assert.equal(isStellarAddress(PAY_TO.slice(0, 55) + (PAY_TO.endsWith('L') ? 'M' : 'L')), false, 'a changed character breaks the checksum');
  // SEP-23's muxed example; changing the last character only flips padding bits, which must stay zero.
  assert.equal(isStellarAddress('MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK'), true);
  assert.equal(isStellarAddress('MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLL'), false);
  assert.equal(isStellarAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'), false);
  assert.equal(familyOf(XLM), 'stellar');
  assert.equal(familyOf('stellar:futurenet'), 'stellar');
  assert.deepEqual(dollarToken(XLM, USDC), { symbol: 'USDC', decimals: 7 });
});

test('checkAccepts: a valid USDC option passes; asset codes, testnet USDC, amounts and unsponsored fees are caught', () => {
  const ok = [];
  checkAccepts([option()], ok);
  assert.deepEqual(ok.filter((c) => c.status !== 'pass').map((c) => c.id), []);
  assert.match(ok.find((c) => c.id === 'accepts[0]-amount').message, /\$0\.01 USDC, 7 decimals/);
  const bad = [];
  checkAccepts([
    option({ payTo: 'GABC', asset: 'USDC', amount: '0.01', extra: {} }),
    option({ network: XLM_TEST }),
    option({ asset: USDC_TEST }),
    option({ asset: 'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K' }),
  ], bad);
  const by = Object.fromEntries(bad.map((c) => [c.id, c]));
  assert.equal(by['accepts[0]-payto'].status, 'fail');
  assert.equal(by['accepts[0]-asset'].status, 'fail');
  assert.match(by['accepts[0]-asset'].hint, /CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75/);
  assert.equal(by['accepts[0]-amount'].status, 'fail');
  assert.equal(by['accepts[0]-extra'].status, 'fail');
  assert.match(by['accepts[0]-extra'].message, /areFeesSponsored/);
  assert.equal(by['accepts[1]-asset'].status, 'fail', 'mainnet USDC on the testnet is a mismatch');
  assert.equal(by['accepts[2]-asset'].status, 'fail', 'testnet USDC on mainnet is a mismatch');
  assert.equal(by['accepts[3]-asset'].status, 'warn', 'another token contract: clients may not recognise it');
});

test('checkStellar: a USDC trustline passes; none, an unfunded account or an unauthorised line fail; Horizon trouble is info', async () => {
  const pass = [];
  await checkStellar([option()], pass, { fetchImpl: horizon(200, { balances: [{ asset_type: 'native', balance: '5' }, { asset_code: 'USDC', asset_issuer: ISSUER, balance: '1', is_authorized: true }] }) });
  assert.equal(pass[0].status, 'pass');
  assert.equal(horizon.last, `https://horizon.stellar.org/accounts/${PAY_TO}`);
  const none = [];
  await checkStellar([option()], none, { fetchImpl: horizon(200, { balances: [{ asset_code: 'USDC', asset_issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' }] }) });
  assert.equal(none[0].status, 'fail', 'a trustline to another issuer is not USDC');
  assert.match(none[0].message, /no trustline to USDC/);
  const unfunded = [];
  await checkStellar([option()], unfunded, { fetchImpl: horizon(404) });
  assert.match(unfunded[0].message, /does not exist/);
  const frozen = [];
  await checkStellar([option()], frozen, { fetchImpl: horizon(200, { balances: [{ asset_code: 'USDC', asset_issuer: ISSUER, is_authorized: false }] }) });
  assert.equal(frozen[0].status, 'fail');
  const info = [];
  await checkStellar([option()], info, { fetchImpl: async () => { throw new Error('down'); } });
  assert.equal(info[0].status, 'info');
  const contract = [];
  await checkStellar([option({ payTo: USDC })], contract, { fetchImpl: horizon(500) });
  assert.deepEqual(contract, [], 'a contract payTo needs no trustline');
});

test('wallets: x402 agents pay Stellar; nobody when the payout account has no trustline', () => {
  assert.deepEqual(walletCompatibility([option()], []).map((x) => x.wallet), ['x402 agents']);
  const blocked = walletCompatibility([option()], [{ id: 'stellar-payout-trustline', status: 'fail', option: 0 }]);
  assert.ok(blocked.every((x) => x.yes.length === 0));
});
