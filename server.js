const express = require('express');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const FETCH_TIMEOUT_MS = 8000;
const CHALLENGE_HEADER_NAMES = ['payment-required', 'x-payment-required', 'www-authenticate', 'x402'];

// Basic SSRF guard — this endpoint fetches arbitrary user-submitted URLs
// server-side, so block obviously-internal targets before making any request.
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 0 ||
      (a === 169 && b === 254)
    );
  }
  return ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80');
}

async function assertPublicUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw Object.assign(new Error('Not a valid URL.'), { statusCode: 400 });
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw Object.assign(new Error('Only http/https URLs are supported.'), { statusCode: 400 });
  }
  if (['localhost', '0.0.0.0'].includes(url.hostname)) {
    throw Object.assign(new Error('Cannot diagnose a local/internal address.'), { statusCode: 400 });
  }
  try {
    const { address } = await dns.lookup(url.hostname);
    if (isPrivateIp(address)) {
      throw Object.assign(new Error('Cannot diagnose a local/internal address.'), { statusCode: 400 });
    }
  } catch (err) {
    if (err.statusCode) throw err;
    throw Object.assign(new Error(`Could not resolve host: ${err.message}`), { statusCode: 400 });
  }
  return url;
}

async function fetchWithTimeout(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

function addCheck(checks, id, status, message) {
  checks.push({ id, status, message });
}

async function checkOpenApi(origin, checks) {
  const openapiUrl = `${origin}/openapi.json`;
  try {
    const res = await fetchWithTimeout(openapiUrl);
    if (!res.ok) {
      addCheck(checks, 'openapi-present', 'warn', `No /openapi.json found (HTTP ${res.status}). Optional, but it's how x402scan and similar registries discover your input schemas.`);
      return;
    }
    let json;
    try {
      json = await res.json();
    } catch {
      addCheck(checks, 'openapi-present', 'warn', '/openapi.json exists but is not valid JSON.');
      return;
    }
    addCheck(checks, 'openapi-present', 'pass', '/openapi.json found and parses as valid JSON.');
    if (!json.info || !json.info.title) {
      addCheck(checks, 'openapi-title', 'warn', 'Missing info.title in openapi.json.');
    }
    if (!json.info || !json.info['x-guidance']) {
      addCheck(checks, 'openapi-guidance', 'warn', 'Missing info.x-guidance — this is the field agents read to judge whether your service matches their task.');
    }
  } catch (err) {
    addCheck(checks, 'openapi-present', 'warn', `Could not fetch /openapi.json: ${err.message}`);
  }
}

async function probe402(targetUrl, checks) {
  for (const method of ['POST', 'GET']) {
    try {
      const res = await fetchWithTimeout(targetUrl, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method === 'POST' ? '{}' : undefined
      });
      if (res.status === 402) {
        addCheck(checks, 'returns-402', 'pass', `Endpoint returns 402 Payment Required for ${method}.`);
        return { method, res };
      }
    } catch {
      // try the next method
    }
  }
  addCheck(checks, 'returns-402', 'fail', 'Endpoint did not return 402 Payment Required for POST or GET. Agents and registries will not recognize this as a paid x402 resource.');
  return null;
}

function decodeChallengeValue(value, checks) {
  if (!value || !String(value).trim()) return null;

  const trimmed = String(value).trim();
  const candidates = [];

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    candidates.push(() => JSON.parse(trimmed));
  }

  const isLikelyBase64 = /^[A-Za-z0-9+/=_-]+$/.test(trimmed) && !trimmed.startsWith('{');
  if (isLikelyBase64) {
    candidates.push(() => JSON.parse(Buffer.from(trimmed, 'base64').toString('utf8')));
    candidates.push(() => JSON.parse(Buffer.from(trimmed.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')));
  }

  for (const parseCandidate of candidates) {
    try {
      const parsed = parseCandidate();
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // Try the next decode/parse strategy.
    }
  }

  addCheck(checks, 'protocol-version', 'fail', `Challenge header is present but is not valid JSON or base64-encoded JSON: ${trimmed.slice(0, 80)}`);
  return null;
}

function decodeHeaderChallenge(headerValue, checks) {
  return decodeChallengeValue(headerValue, checks);
}

async function checkEnvelope(probeResult, checks) {
  const { res } = probeResult;
  const headerEntry = Array.from(res.headers.entries()).find(([name]) => CHALLENGE_HEADER_NAMES.includes(name.toLowerCase()));
  const headerChallenge = headerEntry ? headerEntry[1] : null;
  const bodyText = await res.text();
  let bodyJson = null;
  try {
    bodyJson = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    // body just isn't JSON — fine if the header carries the challenge
  }

  let version = null;
  let accepts = null;

  if (headerChallenge) {
    const decoded = decodeHeaderChallenge(headerChallenge, checks);
    if (!decoded) return null;
    const challenge = decoded.challenge || decoded;
    version = challenge.x402Version ?? challenge.version ?? 2;
    accepts = challenge.accepts ?? decoded.accepts ?? null;

    addCheck(checks, 'protocol-version', version === 2 ? 'pass' : 'warn', `Uses x402 protocol v${version} via the challenge header (${headerEntry[0]}).`);

    if (bodyJson && Array.isArray(bodyJson.accepts)) {
      const sameAccepts = JSON.stringify(bodyJson.accepts) === JSON.stringify(accepts);
      if (sameAccepts) {
        addCheck(checks, 'envelope-body-mirror', 'pass', 'Payment requirements are present in both the header and the response body.');
      } else {
        addCheck(checks, 'envelope-body-mirror', 'warn', 'The challenge header and JSON body disagree on accepts[]; clients may observe inconsistent payment requirements.');
      }
    } else {
      addCheck(checks, 'envelope-body-mirror', 'warn', "Payment challenge is delivered only via the challenge header, with no JSON body mirror. Some clients still read the body for accepts[] and may fail to discover the payment requirements.");
    }
  } else if (bodyJson && Array.isArray(bodyJson.accepts)) {
    version = bodyJson.x402Version || 1;
    accepts = bodyJson.accepts;
    if (version === 1) {
      addCheck(checks, 'protocol-version', 'warn', 'Uses x402 protocol v1 (JSON response body, no challenge header). v1 is deprecated by the protocol maintainers and not recognized by the official MCP/x402 registry or x402scan for indexing — consider migrating to v2.');
    } else {
      addCheck(checks, 'protocol-version', 'pass', `Uses x402 protocol v${version} via the JSON response body.`);
    }
  } else {
    addCheck(checks, 'protocol-version', 'fail', "402 response has neither a challenge header nor an accepts[] array in the JSON body — this isn't a valid x402 challenge.");
    return null;
  }

  return accepts;
}

function checkAccepts(accepts, checks) {
  if (!Array.isArray(accepts) || accepts.length === 0) {
    addCheck(checks, 'accepts-present', 'fail', 'No accepts[] entries found in the challenge — clients have nothing to pay against.');
    return;
  }

  accepts.forEach((accept, i) => {
    if (!accept || typeof accept !== 'object') {
      addCheck(checks, `accepts[${i}]`, 'fail', `accepts[${i}] is not an object.`);
      return;
    }

    const p = `accepts[${i}]`;

    if (!accept.network) {
      addCheck(checks, `${p}-network`, 'fail', `${p}: missing "network".`);
    } else if (/^eip155:\d+$/.test(accept.network) || accept.network.startsWith('solana:')) {
      addCheck(checks, `${p}-network`, 'pass', `${p}: network is valid CAIP-2 format (${accept.network}).`);
    } else {
      addCheck(checks, `${p}-network`, 'warn', `${p}: network "${accept.network}" doesn't look like CAIP-2 format (e.g. "eip155:8453" for Base). x402 v2 tooling and registries expect CAIP-2 network ids.`);
    }

    const payTo = accept.payTo;
    if (!payTo || !/^0x[a-fA-F0-9]{40}$/.test(payTo)) {
      addCheck(checks, `${p}-payto`, 'fail', `${p}: "payTo" is missing or not a valid EVM address.`);
    } else {
      addCheck(checks, `${p}-payto`, 'pass', `${p}: payTo is a valid address.`);
    }

    const asset = accept.asset;
    if (!asset || !/^0x[a-fA-F0-9]{40}$/.test(asset)) {
      addCheck(checks, `${p}-asset`, 'warn', `${p}: "asset" is missing or not a valid contract address.`);
    }

    const amount = accept.amount ?? accept.maxAmountRequired;
    if (amount === undefined || amount === null) {
      addCheck(checks, `${p}-amount`, 'fail', `${p}: no "amount" or "maxAmountRequired" field.`);
    } else if (/^\d+\.\d+$/.test(String(amount)) || (!Number.isNaN(Number(amount)) && Number(amount) < 1 && Number(amount) > 0)) {
      addCheck(checks, `${p}-amount`, 'warn', `${p}: amount "${amount}" looks like a decimal dollar value rather than atomic token units. x402 v2 amounts should be integer strings in the asset's smallest unit (e.g. "100000" for $0.10 of 6-decimal USDC) — a value like "0.10" here is a common, costly mistake that makes payments fail or overcharge by orders of magnitude.`);
    } else {
      addCheck(checks, `${p}-amount`, 'pass', `${p}: amount "${amount}" looks like atomic units.`);
    }
  });
}

app.post('/api/diagnose', async (req, res) => {
  const { url: targetUrl } = req.body || {};
  if (!targetUrl) return res.status(400).json({ error: 'url is required' });

  const checks = [];
  try {
    const url = await assertPublicUrl(targetUrl);

    await checkOpenApi(url.origin, checks);

    const probeResult = await probe402(targetUrl, checks);
    if (probeResult) {
      const accepts = await checkEnvelope(probeResult, checks);
      if (accepts) checkAccepts(accepts, checks);
    }

    const hasFail = checks.some((c) => c.status === 'fail');
    const hasWarn = checks.some((c) => c.status === 'warn');
    const overall = hasFail ? 'fail' : hasWarn ? 'warn' : 'pass';

    res.json({ url: targetUrl, overall, checks });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, checks });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`x402 Doctor running on port ${PORT}`);
  });
}

module.exports = {
  app,
  assertPublicUrl,
  checkOpenApi,
  probe402,
  decodeChallengeValue,
  checkEnvelope,
  checkAccepts,
  isPrivateIp,
  PORT
};
