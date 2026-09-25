// One-off: run presign-guard's real check (no payment) on 4 public test cases for a comparison with TAT Risk.
import { execSync } from 'child_process';
execSync('git clone -q --depth 1 https://github.com/Fizzl13/presign-guard /tmp/pg && cd /tmp/pg && npm ci --omit=dev --silent', { stdio: 'inherit' });
const { createCheckRouter } = await import('/tmp/pg/src/presign-guard.js');
const express = (await import('/tmp/pg/node_modules/express/index.js')).default;
const app = express();
app.use(createCheckRouter());
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // USDC on Base
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const EOA = '0x1234567890123456789012345678901234567890'; // an address with no code
const now = Math.floor(Date.now() / 1000);
const MAX256 = (2n ** 256n - 1n).toString();
const MAX160 = (2n ** 160n - 1n).toString();

// The real payTo of a live x402 endpoint (Ichimoku /scan, Base).
const r402 = await fetch('https://ichimoku-signal.onrender.com/scan?interval=4h');
const ch = JSON.parse(Buffer.from(r402.headers.get('payment-required'), 'base64').toString());
const baseOpt = ch.accepts.find((a) => a.network === 'eip155:8453');

const cases = [
  ['1. x402 payment: $0.25 USDC to a live x402 endpoint (EIP-3009)', { type: 'signature', chainId: 8453, typedData: {
    types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
      TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] },
    primaryType: 'TransferWithAuthorization',
    domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC },
    message: { from: EOA, to: baseOpt.payTo, value: baseOpt.amount, validAfter: '0', validBefore: String(now + 300), nonce: '0x' + '11'.repeat(32) } } }],
  ['2. Unlimited USDC approval to the canonical Permit2 contract', { type: 'approval', chainId: 8453, token: USDC, spender: PERMIT2, amount: MAX256 }],
  ['3. Permit2 signature: unlimited USDC for 1 year to a plain wallet', { type: 'signature', chainId: 8453, typedData: {
    types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
      PermitSingle: [{ name: 'details', type: 'PermitDetails' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }],
      PermitDetails: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }] },
    primaryType: 'PermitSingle',
    domain: { name: 'Permit2', chainId: 8453, verifyingContract: PERMIT2 },
    message: { details: { token: USDC, amount: MAX160, expiration: String(now + 365 * 86400), nonce: '0' }, spender: EOA, sigDeadline: String(now + 1800) } } }],
  ['4. Revoking an approval (amount 0)', { type: 'approval', chainId: 8453, token: USDC, spender: EOA, amount: '0' }],
];
console.log(`live x402 payTo (Ichimoku /scan, Base): ${baseOpt.payTo}, amount ${baseOpt.amount}`);
for (const [label, body] of cases) {
  const res = await fetch(`${base}/v1/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json();
  console.log(`\n### ${label}\nHTTP ${res.status} verdict=${j.verdict}`);
  for (const x of j.reasons || []) console.log(`  ${x.severity.padEnd(6)} ${x.code}  ${x.subject || ''} ${x.details ? JSON.stringify(x.details) : ''}`);
  if (j.error) console.log('  ', j.error, j.message);
  console.log('  kind:', j.subject && j.subject.kind);
}
server.close();
