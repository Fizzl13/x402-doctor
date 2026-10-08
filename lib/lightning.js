'use strict';

// x402 `exact` on Bitcoin Lightning (`lnbtc`, x402-foundation/x402 specs/schemes/exact/scheme_exact_lnbtc.md,
// merged September 2026 with Block): the seller puts a fresh BOLT11 invoice in extra.invoice, the buyer pays it
// and sends back the preimage. The invoice must match the option exactly (amount in millisatoshis, currency,
// expiry = maxTimeoutSeconds, signed by payTo) and its description hash must be the request hash, which binds
// the payment to this exact request. Clients are told to refuse anything that doesn't, so every mismatch is a fail.
const { createHash } = require('node:crypto');
const { decode } = require('./bolt11');

const PROFILES = new Set(['http:1', 'mcp:1']);
const HEX64 = /^[0-9a-f]{64}$/;
const NODE_KEY = /^0[23][0-9a-f]{64}$/;
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

// JCS (RFC 8785) for the binding objects, which hold only strings, arrays and objects: sorted keys, JSON strings.
function jcs(value) {
  if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${jcs(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

// The http:1 request hash: method, absolute URL, sha256 of the body bytes and the bound headers (absent = 0x00).
function httpRequestHash({ method, url, body = '', headers = {} }, boundHeaders = []) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const binding = {
    domain: 'x402:exact:lnbtc:bolt11:http:1',
    method,
    url,
    bodyHash: sha256(Buffer.from(body, 'utf8')),
    headers: boundHeaders.map((name) => ({ name, valueHash: lower[name] === undefined ? sha256(Buffer.from([0])) : sha256(Buffer.concat([Buffer.from([1]), Buffer.from(String(lower[name]).trim(), 'ascii')])) })),
  };
  return sha256(Buffer.from(jcs(binding), 'utf8'));
}

// The field checks that need no invoice decoding (part of checkAccepts).
function checkLightningOption(accept, p, checks, group, known, addCheck) {
  if (!NODE_KEY.test(String(accept.payTo))) {
    addCheck(checks, `${p}-payto`, 'fail', `${p}: "payTo" must be the receiving node's public key: 66 lowercase hex characters starting with 02 or 03.`, { group });
  } else {
    addCheck(checks, `${p}-payto`, 'pass', `${p}: payTo is a Lightning node key (${accept.payTo.slice(0, 10)}…).`, { group });
  }
  if (accept.asset !== 'BTC') addCheck(checks, `${p}-asset`, 'fail', `${p}: asset must be "BTC" on lnbtc, not ${JSON.stringify(accept.asset)}.`, { group });
  const amount = accept.amount;
  if (typeof amount !== 'string' || !/^[1-9]\d*$/.test(amount)) {
    addCheck(checks, `${p}-amount`, 'fail', `${p}: amount ${JSON.stringify(amount)} must be a positive whole number of millisatoshis, as a string.`, { group, hint: '1 satoshi is "1000"; 21 sats is "21000".' });
  } else {
    addCheck(checks, `${p}-amount`, 'pass', `${p}: amount ${amount} msat (${Number(amount) / 1000} sat).`, { group });
  }
  const extra = accept.extra || {};
  const problems = [];
  if (extra.paymentFlow !== 'upfront') problems.push(`extra.paymentFlow must be "upfront" (is ${JSON.stringify(extra.paymentFlow)})`);
  if (extra.assetTransferMethod !== undefined && extra.assetTransferMethod !== 'bolt11') problems.push(`extra.assetTransferMethod must be "bolt11" or absent`);
  if (typeof extra.invoice !== 'string' || !extra.invoice) problems.push('extra.invoice (a fresh BOLT11 invoice) is missing');
  if (!HEX64.test(String(extra.requestHash))) problems.push('extra.requestHash must be 64 lowercase hex characters');
  if (!PROFILES.has(extra.requestBindingProfile)) problems.push(`extra.requestBindingProfile must be "http:1" or "mcp:1" (is ${JSON.stringify(extra.requestBindingProfile)})`);
  else if (extra.requestBindingProfile === 'http:1') {
    const params = extra.requestBindingParams;
    const h = params?.headers;
    if (!params || Object.keys(params).join() !== 'headers' || !Array.isArray(h)) problems.push('extra.requestBindingParams must be exactly { headers: [...] } for http:1');
    else if (h.some((n) => typeof n !== 'string' || n !== n.toLowerCase()) || h.join() !== [...h].sort().join() || new Set(h).size !== h.length) problems.push('the bound header names must be lowercase, sorted and without duplicates');
    else if (h.includes('payment-signature')) problems.push('payment-signature must not be a bound header');
  } else {
    const params = extra.requestBindingParams;
    if (!params || Object.keys(params).sort().join() !== 'metadata,server' || !Array.isArray(params.metadata) || typeof params.server !== 'string') problems.push('extra.requestBindingParams must be exactly { server, metadata: [...] } for mcp:1');
  }
  if (!Number.isInteger(accept.maxTimeoutSeconds) || accept.maxTimeoutSeconds <= 0) problems.push('maxTimeoutSeconds must be a positive integer (it must equal the invoice expiry)');
  if (problems.length) {
    addCheck(checks, `${p}-lightning`, 'fail', `${p}: ${problems.join('; ')}. Lightning x402 clients refuse this option.`, { group, hint: 'See the lnbtc exact scheme in the x402 spec (specs/schemes/exact/scheme_exact_lnbtc.md).' });
  } else {
    addCheck(checks, `${p}-lightning`, 'pass', `${p}: upfront BOLT11 payment with request binding ${extra.requestBindingProfile}.`, { group });
  }
}

// Decodes each invoice and checks it against its option and, for http:1, against the request the doctor sent.
// request: { method, url, body, headers } of the probe that got the 402 (null: skip the request hash).
async function checkLightning(accepts, checks, { networks, request = null, now = Date.now(), addCheck } = {}) {
  const group = 'settlement';
  for (const [index, option] of (accepts || []).entries()) {
    const net = networks[option?.network];
    if (net?.family !== 'lightning' || typeof option.extra?.invoice !== 'string') continue;
    const id = 'lightning-invoice';
    let inv;
    try {
      inv = await decode(option.extra.invoice);
    } catch (err) {
      addCheck(checks, id, 'fail', `accepts[${index}]: extra.invoice is not a valid BOLT11 invoice (${err.message}).`, { group, option: index });
      continue;
    }
    const bad = [];
    if (inv.currency !== net.bolt11) bad.push(`it is for "${inv.currency}", not ${net.name} ("${net.bolt11}")`);
    if (inv.amountMsat === null) bad.push('it has no amount (an "any amount" invoice)');
    else if (String(inv.amountMsat) !== String(option.amount)) bad.push(`its amount is ${inv.amountMsat} msat, the option says ${option.amount}`);
    if (inv.expiry !== option.maxTimeoutSeconds) bad.push(`its expiry is ${inv.expiry} s, maxTimeoutSeconds is ${option.maxTimeoutSeconds}`);
    if (inv.signer !== String(option.payTo).toLowerCase()) bad.push(`it is signed by ${inv.signer.slice(0, 10)}…, not by payTo`);
    if (inv.payee && inv.payee !== inv.signer) bad.push('its payee field (n) does not match its signature');
    if (!inv.paymentHash) bad.push('it has no payment hash');
    if (inv.descriptionHash !== option.extra.requestHash) bad.push(inv.descriptionHash ? 'its description hash is not extra.requestHash' : 'it has no description hash (it must commit to the request hash)');
    const nowS = Math.floor(now / 1000);
    if (inv.timestamp > nowS + 60) bad.push('it was created in the future');
    if (inv.timestamp + inv.expiry < nowS) bad.push(`it expired ${nowS - inv.timestamp - inv.expiry} s ago`);
    if (bad.length) {
      addCheck(checks, id, 'fail', `accepts[${index}]: the Lightning invoice doesn't match the option: ${bad.join('; ')}. Clients must refuse it.`, { group, option: index, hint: 'Issue a fresh invoice per challenge for exactly the option\'s amount, with expiry = maxTimeoutSeconds and the request hash as description hash, from the node in payTo.' });
      continue;
    }
    addCheck(checks, id, 'pass', `accepts[${index}]: the BOLT11 invoice matches the option (${option.amount} msat, signed by payTo, expires in ${inv.timestamp + inv.expiry - nowS} s, bound to the request hash).`, { group, option: index });

    // http:1: recompute the request hash for the doctor's own request. Only the headers the doctor knows it sent.
    const extra = option.extra;
    if (request && extra.requestBindingProfile === 'http:1') {
      const bound = extra.requestBindingParams.headers;
      const knownNames = new Set(['content-type', ...Object.keys(request.headers || {}).map((k) => k.toLowerCase())]);
      if (bound.every((n) => knownNames.has(n))) {
        const expected = httpRequestHash(request, bound);
        if (expected === extra.requestHash) {
          addCheck(checks, 'lightning-request-hash', 'pass', `accepts[${index}]: extra.requestHash matches this request (${request.method} ${request.url}), so a client can verify the binding.`, { group, option: index });
        } else {
          addCheck(checks, 'lightning-request-hash', 'fail', `accepts[${index}]: extra.requestHash is not the http:1 hash of this request (${request.method} ${request.url}); clients compute it themselves and will refuse to pay.`, { group, option: index, hint: 'Hash JCS({domain, method, url, bodyHash, headers}) of the request as received (public URL with query, raw body bytes), per the lnbtc spec.' });
        }
      } else {
        addCheck(checks, 'lightning-request-hash', 'info', `accepts[${index}]: the request hash binds headers the doctor can't reproduce (${bound.join(', ')}); not recomputed.`, { group, option: index });
      }
    }
  }
}

module.exports = { checkLightningOption, checkLightning, httpRequestHash, jcs };
