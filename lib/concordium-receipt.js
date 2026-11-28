'use strict';

// A Concordium payment's provable receipt, checked against the chain. The Concordium x402 facilitator
// (Fizzl13/x402-examples, concordium-facilitator/src/receipt.js) puts "x402r:" + the SHA-256 of a receipt in the memo
// of every sponsor-first payment: the network, the asset and amount, the payTo, the paid resource's URL and the
// payment's random ticket. The chain shows only that hash; the buyer's wallet keeps the receipt. With the receipt and
// the transaction hash anyone can check that this account paid this seller this amount for exactly this resource,
// without trusting the facilitator, the seller or the wallet. This is the same canonical form and the same check as
// the facilitator's (test/concordium-receipt.test.js keeps them equal).
//
// How the transaction is read, read-only:
//   CCD    the network's wallet proxy (/v0/submissionStatus/<tx>): status, outcome, sender, sponsor, to, amount, memo.
//   tokens (such as USDR) a Concordium x402 facilitator's POST /receipt, which reads its own node: Fizzl's own
//          (CONCORDIUM_FACILITATOR_URL, the one Doctor's paid routes use), never the seller's.
// Used by the free check (POST/GET /api/v1/concordium/receipt) and by outcome reports (lib/outcomes.js): a report that
// carries a receipt counts as a real payment to that seller for that route, by the paying (identity-verified) account.
const crypto = require('node:crypto');

const RECEIPT_PREFIX = 'x402r:';
const RECEIPT_KIND = 'x402-concordium-receipt';
const FIELDS = ['kind', 'v', 'network', 'asset', 'amount', 'payTo', 'resource', 'ticket'];
const MAX_RESOURCE = 2048;
const NETWORKS = {
  'ccd:9dd9ca4d19e9393877d2c44b70f89acb': { id: 'mainnet', walletProxy: 'https://wallet-proxy.mainnet.concordium.software', facilitatorEnv: 'CONCORDIUM_FACILITATOR_URL' },
  'ccd:4221332d34e1694168c2a0c0b3fd0f27': { id: 'testnet', walletProxy: 'https://wallet-proxy.testnet.concordium.com', facilitatorEnv: 'CONCORDIUM_TESTNET_FACILITATOR_URL' },
};
const TIMEOUT_MS = 8000;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// The bytes the memo commits to: the fields in this order, nothing else.
const canonicalReceipt = (r) => JSON.stringify(Object.fromEntries(FIELDS.map((k) => [k, r?.[k] ?? null])));
const receiptMemo = (r) => `${RECEIPT_PREFIX}${sha256(canonicalReceipt(r))}`;

// What is wrong with a receipt's shape, or null.
function receiptProblem(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'no receipt';
  if (r.kind !== RECEIPT_KIND || r.v !== 1) return `not an ${RECEIPT_KIND} v1`;
  if (!/^ccd:[0-9a-f]{32}$/.test(String(r.network))) return 'network is not a Concordium network (ccd:<genesis>)';
  if (!/^[A-Za-z0-9.\-_]{1,64}$/.test(String(r.asset))) return 'asset is not CCD or a token id';
  if (!/^\d{1,30}$/.test(String(r.amount))) return 'amount is not a whole number of the smallest unit';
  if (!/^[1-9A-HJ-NP-Za-km-z]{50}$/.test(String(r.payTo))) return 'payTo is not a Concordium account';
  if (r.resource !== null && !(typeof r.resource === 'string' && /^https?:\/\//.test(r.resource) && r.resource.length <= MAX_RESOURCE)) return 'resource is not a URL';
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(String(r.ticket))) return 'ticket is missing';
  return null;
}

// Does this transaction ({ finalized, success, sender, sponsor, time, transfers: [{ asset, to, amount, memo }] }) pay
// exactly what the receipt says? { valid: true, payer, sponsor, time } or { valid: false, reason }.
function checkReceipt(receipt, o) {
  const problem = receiptProblem(receipt);
  if (problem) return { valid: false, reason: problem };
  if (!o) return { valid: false, reason: 'the chain does not know this transaction' };
  if (!o.finalized) return { valid: false, reason: 'the transaction is not finalized' };
  if (!o.success) return { valid: false, reason: 'the transaction was rejected on chain' };
  if (!Array.isArray(o.transfers) || o.transfers.length !== 1) return { valid: false, reason: 'the transaction is not exactly one transfer' };
  const t = o.transfers[0];
  if (t.to !== receipt.payTo) return { valid: false, reason: 'the transfer went to another account than the receipt names' };
  const ccd = receipt.asset.toUpperCase() === 'CCD';
  if (ccd ? t.asset !== 'CCD' : t.asset !== receipt.asset) return { valid: false, reason: 'the transfer is in another asset' };
  if (BigInt(t.amount) !== BigInt(receipt.amount)) return { valid: false, reason: 'the transfer is for another amount' };
  if (t.memo !== receiptMemo(receipt)) return { valid: false, reason: "the transaction's memo is not this receipt's (another purchase, or a changed receipt)" };
  return { valid: true, payer: o.sender, sponsor: o.sponsor ?? null, time: o.time ?? null };
}

// A memo's text: Concordium wallets and the facilitator write CBOR, a text string, sometimes wrapped as an embedded
// CBOR item (tag 24 around a byte string). null when it is something else.
function memoText(hex) {
  if (typeof hex !== 'string' || !/^([0-9a-f]{2})*$/i.test(hex)) return null;
  let b = Buffer.from(hex, 'hex');
  const head = (buf) => {
    if (!buf.length) return null;
    const major = buf[0] >> 5;
    const info = buf[0] & 31;
    let len;
    let at;
    if (info < 24) { len = info; at = 1; } else if (info === 24 && buf.length > 1) { len = buf[1]; at = 2; } else if (info === 25 && buf.length > 2) { len = buf.readUInt16BE(1); at = 3; } else return null;
    return { major, info, len, at };
  };
  // tag 24 (0xd8 0x18) around a byte string: decode what the bytes hold
  if (b[0] === 0xd8 && b[1] === 0x18) {
    const h = head(b.subarray(2));
    if (!h || h.major !== 2) return null;
    b = b.subarray(2 + h.at, 2 + h.at + h.len);
  }
  const h = head(b);
  if (!h || h.major !== 3 || b.length !== h.at + h.len) return null;
  return b.subarray(h.at).toString('utf8');
}

// A CCD transaction as the wallet proxy shows it, in checkReceipt's form. { outcome } or { notRead, reason }.
async function readCcdTransaction(net, tx, fetchImpl) {
  let j;
  try {
    const res = await fetchImpl(`${net.walletProxy}/v0/submissionStatus/${tx}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status !== 200) return { notRead: true, reason: `Concordium's wallet proxy answered ${res.status}` };
    j = await res.json();
  } catch (err) {
    return { notRead: true, reason: `Concordium's wallet proxy could not be reached (${err?.message || err})` };
  }
  if (!j || j.status === 'absent') return { outcome: null };
  if (j.status !== 'finalized') return { outcome: { finalized: false } };
  if (j.outcome !== 'success') return { outcome: { finalized: true, success: false } };
  // A CCD transfer names `to` and `amount`; anything else (a token update, a contract call) is not one CCD transfer.
  const transfers = typeof j.to === 'string' && /^\d+$/.test(String(j.amount)) ? [{ asset: 'CCD', to: j.to, amount: String(j.amount), memo: memoText(j.memo) }] : [];
  return { outcome: { finalized: true, success: true, sender: j.sender ?? null, sponsor: j.sponsor?.sponsor ?? null, time: null, transfers } };
}

// A token payment through a Concordium x402 facilitator's POST /receipt (Fizzl's own, never the seller's).
async function askFacilitator(base, receipt, tx, fetchImpl) {
  try {
    const res = await fetchImpl(`${base.replace(/\/+$/, '')}/receipt`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ receipt, tx }), signal: AbortSignal.timeout(TIMEOUT_MS) });
    const j = await res.json().catch(() => null);
    if (res.status === 200 && j && typeof j.valid === 'boolean') return j.valid ? { valid: true, payer: j.payer ?? null, sponsor: j.sponsor ?? null, time: j.time ?? null, via: 'facilitator' } : { valid: false, reason: String(j.reason || 'not valid'), via: 'facilitator' };
    return { valid: false, notRead: true, reason: `the facilitator that reads token payments answered ${res.status}${j?.reason ? ` (${j.reason})` : ''}` };
  } catch (err) {
    return { valid: false, notRead: true, reason: `the facilitator that reads token payments could not be reached (${err?.message || err})` };
  }
}

// Does transaction `tx` pay exactly what `receipt` says? { valid: true, payer, sponsor, time, network, via } or
// { valid: false, reason, notRead? } (notRead: the chain could not be read; not a verdict about the receipt).
async function checkReceiptTx(receipt, tx, { fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const problem = receiptProblem(receipt);
  if (problem) return { valid: false, reason: problem };
  const hash = String(tx ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) return { valid: false, reason: 'tx is not a transaction hash (64 hex characters)' };
  const net = NETWORKS[receipt.network];
  if (!net) return { valid: false, reason: `${receipt.network} is not Concordium mainnet or testnet` };
  if (receipt.asset.toUpperCase() !== 'CCD') {
    const base = String(env[net.facilitatorEnv] || '').trim();
    if (!/^https:\/\//.test(base)) return { valid: false, notRead: true, reason: `a token payment (${receipt.asset}) is read through a Concordium x402 facilitator, and none is configured for ${net.id}; POST { receipt, tx } to the seller's facilitator's /receipt instead` };
    return { ...(await askFacilitator(base, receipt, hash, fetchImpl)), network: net.id };
  }
  const read = await readCcdTransaction(net, hash, fetchImpl);
  if (read.notRead) return { valid: false, notRead: true, reason: read.reason, network: net.id };
  return { ...checkReceipt(receipt, read.outcome), network: net.id, via: 'wallet-proxy' };
}

// Does this receipt back an outcome report about `url`? The transaction pays what the receipt says (above), the payer
// is not the payTo, and the payTo is one the endpoint's own 402 offers on that network for that asset: so the receipt
// is a real payment to this seller for this route, not one a reporter sent to itself. readAccepts(url): the 402's
// accepts, or null when it gives none. Same answer shape as checkReceiptTx.
async function receiptBacksReport(receipt, tx, url, { readAccepts, ...opts } = {}) {
  const c = await checkReceiptTx(receipt, tx, opts);
  if (!c.valid) return c;
  if (c.payer && c.payer === receipt.payTo) return { valid: false, reason: 'the payer paid its own account' };
  let accepts;
  try { accepts = await readAccepts(url); } catch (err) { return { valid: false, notRead: true, reason: `the endpoint's 402 could not be read (${err?.message || err})` }; }
  if (!Array.isArray(accepts) || !accepts.length) return { valid: false, notRead: true, reason: "the endpoint gave no 402, so its payTo could not be compared with the receipt's" };
  const offered = accepts.some((a) => a?.network === receipt.network && a?.payTo === receipt.payTo && String(a?.asset ?? '') === receipt.asset);
  if (!offered) return { valid: false, reason: "the receipt pays an account this endpoint's 402 doesn't offer for that network and asset, so it is not a payment to this seller" };
  return c;
}

// A receipt as the wallet's link carries it: base64url JSON. null when it isn't one.
function decodeReceiptParam(s) {
  if (typeof s !== 'string' || !s || s.length > 8000 || !/^[A-Za-z0-9_-]+={0,2}$/.test(s)) return null;
  try { return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')); } catch { return null; }
}

// The free check's answer: { status, body }.
async function receiptCheckAnswer(receipt, tx, opts = {}) {
  const r = await checkReceiptTx(receipt, tx, opts);
  const status = r.notRead ? 503 : r.valid || r.network ? 200 : 400;
  const body = {
    valid: r.valid === true,
    ...(r.valid ? {
      payer: r.payer, sponsor: r.sponsor ?? null, time: r.time ?? null,
      paid: { network: receipt.network, asset: receipt.asset, amount: receipt.amount, payTo: receipt.payTo, resource: receipt.resource },
      summary: `Account ${r.payer} paid ${amountText(receipt.amount, receipt.asset)} to ${receipt.payTo}${receipt.resource ? ` for ${receipt.resource}` : ''}: the transaction's memo is this receipt's fingerprint.`,
    } : { reason: r.reason, ...(r.notRead ? { not_read: true } : {}) }),
    tx: String(tx ?? '').toLowerCase(),
    ...(r.network ? { network: r.network } : {}),
    ...(r.via ? { read_via: r.via } : {}),
    how: 'The memo is "x402r:" + SHA-256 of the receipt\'s fields as JSON in this order: kind, v, network, asset, amount, payTo, resource, ticket. Anyone can recompute it and compare it with the transaction on any Concordium node or explorer.',
  };
  return { status, body };
}

// An amount as a person reads it. CCD has 6 decimals: "16000000" is "16 CCD (16000000 microCCD)". A
// PLT keeps its own decimals, which Doctor doesn't read here, so its amount stays in the token's smallest unit.
function amountText(amount, asset) {
  const a = String(amount ?? '');
  const name = String(asset || '');
  if (name.toUpperCase() !== 'CCD' || !/^\d+$/.test(a)) return `${a} in ${name || 'the token'}'s smallest unit`;
  const digits = a.replace(/^0+(?=\d)/, '').padStart(7, '0');
  const whole = digits.slice(0, -6).replace(/^0+(?=\d)/, '');
  const frac = digits.slice(-6).replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''} CCD (${a} microCCD)`;
}

module.exports = { RECEIPT_PREFIX, RECEIPT_KIND, canonicalReceipt, receiptMemo, receiptProblem, checkReceipt, checkReceiptTx, readCcdTransaction, receiptBacksReport, memoText, decodeReceiptParam, receiptCheckAnswer, amountText, NETWORKS };
