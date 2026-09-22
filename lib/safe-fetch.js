// Outbound HTTP for diagnosing user-submitted URLs.
//
// The doctor fetches arbitrary URLs server-side, so every connection is
// checked against private/reserved address ranges *at connect time* (not in
// a separate DNS lookup beforehand, which DNS rebinding would bypass).
// Redirects are followed manually so each hop is re-checked, responses are
// size-capped, and every request has a timeout.

const dns = require('dns');
const net = require('net');
const { Agent, fetch } = require('undici');

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

const BLOCKED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => [ipv4ToInt(base), bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0]);

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const n = ipv4ToInt(ip);
    return BLOCKED_V4.some(([base, mask]) => (n & mask) === (base & mask));
  }
  if (!net.isIPv6(ip)) return true;
  const lower = ip.toLowerCase();
  // IPv4-mapped/-compatible addresses, dotted (::ffff:127.0.0.1) or as the URL
  // parser normalises them (::ffff:7f00:1).
  const mapped = lower.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIp(mapped[1]);
  const mappedHex = lower.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return (
    lower === '::' ||
    lower === '::1' ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    /^fe[89ab]/.test(lower) || // link-local fe80::/10
    lower.startsWith('ff') || // multicast
    lower.startsWith('64:ff9b:') || // NAT64
    lower.startsWith('2001:db8') // documentation
  );
}

class BlockedAddressError extends Error {
  constructor(message) {
    super(message);
    this.code = 'EBLOCKED';
    this.statusCode = 400;
  }
}

// dns.lookup replacement used by the connection pool: resolves every address
// and refuses the connection if any of them is private.
function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const blocked = addresses.find((a) => isPrivateIp(a.address));
    if (blocked) return callback(new BlockedAddressError(`${hostname} resolves to a private/internal address (${blocked.address}).`));
    if (options && options.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

function createSafeFetch({ allowPrivate = false, timeoutMs = DEFAULT_TIMEOUT_MS, maxBodyBytes = MAX_BODY_BYTES } = {}) {
  const dispatcher = new Agent({
    connect: allowPrivate ? {} : { lookup: guardedLookup },
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  });

  function assertAllowedUrl(url) {
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw Object.assign(new Error('Only http/https URLs are supported.'), { statusCode: 400 });
    }
    if (allowPrivate) return;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
      throw new BlockedAddressError('Cannot diagnose a local/internal address.');
    }
    if (net.isIP(host) && isPrivateIp(host)) throw new BlockedAddressError('Cannot diagnose a local/internal address.');
  }

  // Returns { status, headers, url, text, redirects }. The body is read up to
  // maxBodyBytes; anything beyond is dropped and `truncated` is set.
  async function safeFetch(rawUrl, options = {}) {
    let url = new URL(rawUrl);
    const redirects = [];
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      assertAllowedUrl(url);
      let res;
      try {
        res = await fetch(url, { ...options, dispatcher, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        const cause = err.cause || err;
        if (cause.code === 'EBLOCKED') throw cause;
        if (cause.name === 'TimeoutError' || err.name === 'TimeoutError') throw new Error(`timed out after ${timeoutMs / 1000}s`);
        throw new Error(cause.message || err.message);
      }
      if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) {
        await res.body?.cancel();
        const next = new URL(res.headers.get('location'), url);
        redirects.push({ status: res.status, from: url.href, to: next.href });
        url = next;
        if (res.status === 303) options = { ...options, method: 'GET', body: undefined };
        continue;
      }
      const { text, truncated } = await readCapped(res, maxBodyBytes);
      return { status: res.status, headers: res.headers, url: url.href, text, truncated, redirects };
    }
    throw new Error(`more than ${MAX_REDIRECTS} redirects`);
  }

  return safeFetch;
}

async function readCapped(res, maxBytes) {
  if (!res.body) return { text: '', truncated: false };
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      truncated = true;
      chunks.push(value.subarray(0, value.length - (size - maxBytes)));
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

module.exports = { createSafeFetch, isPrivateIp, guardedLookup, BlockedAddressError };
