// The diagnostic checks. Every check pushes { id, group, status, message, hint }
// where status is pass | warn | fail | info and hint says how to fix it.
//
// Most checks trace back to a real bug: v1/v2 confusion, header-only
// envelopes and decimal amounts (PlainText), plus an http:// resource URL
// behind a TLS proxy, a missing Solana fee payer, a payout wallet without a
// USDC account, a testnet paywall on mainnet and Phantom payments rejected by
// PayAI (Ichimoku Signal).

const { validateDiscoveryExtension } = require('@x402/extensions/bazaar');
const { NETWORKS, V1_NAMES, CAIP2_RE, isSolanaAddress, isEvmAddress, familyOf } = require('./networks');

const CHALLENGE_HEADER_NAMES = ['payment-required', 'x-payment-required', 'x402'];
const PAYAI_SUPPORTED_URL = 'https://facilitator.payai.network/supported';
const DEFAULT_SOLANA_RPC = 'https://api.mainnet-beta.solana.com';

function addCheck(checks, id, status, message, extra = {}) {
  checks.push({ id, status, message, ...extra });
}

// ---------------------------------------------------------------- decoding

function decodeChallengeValue(value, checks) {
  if (!value || !String(value).trim()) return null;
  const trimmed = String(value).trim();
  const candidates = [];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) candidates.push(() => JSON.parse(trimmed));
  if (/^[A-Za-z0-9+/=_-]+$/.test(trimmed)) {
    candidates.push(() => JSON.parse(Buffer.from(trimmed, 'base64').toString('utf8')));
    candidates.push(() => JSON.parse(Buffer.from(trimmed.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')));
  }
  for (const parse of candidates) {
    try {
      const parsed = parse();
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // try the next strategy
    }
  }
  addCheck(checks, 'protocol-version', 'fail', `Challenge header is present but is not valid JSON or base64-encoded JSON: ${trimmed.slice(0, 80)}`, {
    group: 'challenge',
    hint: 'x402 v2 sends the PaymentRequired object as base64-encoded JSON in the PAYMENT-REQUIRED header.',
  });
  return null;
}

const headerEntries = (headers) => (typeof headers.entries === 'function' ? Array.from(headers.entries()) : Object.entries(headers || {}));

// Reads the 402 response: which envelope carries the challenge, which
// version, and whether header and body agree. Returns the challenge object.
async function checkEnvelope(probeResult, checks) {
  const { res } = probeResult;
  const headerEntry = headerEntries(res.headers).find(([name]) => CHALLENGE_HEADER_NAMES.includes(name.toLowerCase()));
  const bodyText = typeof res.text === 'function' ? await res.text() : res.text;
  let bodyJson = null;
  try {
    bodyJson = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    // not JSON; fine when the header carries the challenge
  }
  const group = 'challenge';

  if (headerEntry) {
    const decoded = decodeChallengeValue(headerEntry[1], checks);
    if (!decoded) return null;
    const challenge = decoded.challenge || decoded;
    const version = challenge.x402Version ?? challenge.version;
    if (version === undefined) {
      addCheck(checks, 'protocol-version', 'fail', `Challenge in the ${headerEntry[0]} header has no x402Version.`, {
        group,
        hint: 'Set "x402Version": 2 in the PaymentRequired object.',
      });
    } else if (version === 2) {
      addCheck(checks, 'protocol-version', 'pass', `x402 v2 challenge in the ${headerEntry[0]} header.`, { group });
      if (headerEntry[0].toLowerCase() !== 'payment-required') {
        addCheck(checks, 'challenge-header', 'warn', `v2 challenge sent in "${headerEntry[0]}" instead of "PAYMENT-REQUIRED".`, {
          group,
          hint: 'x402 v2 clients read the PAYMENT-REQUIRED header.',
        });
      }
    } else {
      addCheck(checks, 'protocol-version', 'warn', `Challenge header declares x402Version ${version}; v2 is current.`, { group, hint: 'Migrate to x402 v2.' });
    }

    const accepts = challenge.accepts ?? decoded.accepts ?? null;
    if (bodyJson && Array.isArray(bodyJson.accepts)) {
      if (JSON.stringify(bodyJson.accepts) === JSON.stringify(accepts)) {
        addCheck(checks, 'envelope-body-mirror', 'pass', 'Payment requirements are present in both the header and the response body.', { group });
      } else {
        addCheck(checks, 'envelope-body-mirror', 'warn', 'The challenge header and JSON body disagree on accepts[]; clients may see different payment requirements.', {
          group,
          hint: 'Mirror the decoded header challenge into the 402 body, or leave accepts[] out of the body.',
        });
      }
    } else {
      addCheck(checks, 'envelope-body-mirror', 'warn', 'Payment challenge is delivered only via the header, with no JSON body mirror. Some clients still read the body for accepts[].', {
        group,
        hint: '@x402/express sends an empty {} body; add a small middleware that copies the decoded PAYMENT-REQUIRED challenge into the 402 JSON body.',
      });
    }
    return { ...challenge, x402Version: version, accepts };
  }

  if (bodyJson && Array.isArray(bodyJson.accepts)) {
    const version = bodyJson.x402Version || 1;
    if (version === 1) {
      addCheck(checks, 'protocol-version', 'warn', 'Uses x402 v1 (JSON body, no challenge header). v1 is deprecated and not indexed by the x402 Bazaar or x402scan.', {
        group,
        hint: 'Migrate to v2: @x402/express (or another v2 SDK) sends the PAYMENT-REQUIRED header with CAIP-2 networks.',
      });
    } else {
      addCheck(checks, 'protocol-version', 'warn', `x402 v${version} challenge only in the JSON body; v2 clients read the PAYMENT-REQUIRED header.`, {
        group,
        hint: 'Send the challenge base64-encoded in the PAYMENT-REQUIRED header.',
      });
    }
    return { ...bodyJson, x402Version: version };
  }

  addCheck(checks, 'protocol-version', 'fail', "The 402 response has neither a challenge header nor an accepts[] array in the JSON body; this isn't a valid x402 challenge.", {
    group,
    hint: 'Return the PaymentRequired object base64-encoded in the PAYMENT-REQUIRED header.',
  });
  return null;
}

// ----------------------------------------------------------------- accepts

function checkAccepts(accepts, checks) {
  const group = 'accepts';
  if (!Array.isArray(accepts) || accepts.length === 0) {
    addCheck(checks, 'accepts-present', 'fail', 'No accepts[] entries in the challenge; clients have nothing to pay against.', {
      group,
      hint: 'List at least one payment option (scheme, network, asset, amount, payTo).',
    });
    return;
  }

  accepts.forEach((accept, i) => {
    const p = `accepts[${i}]`;
    if (!accept || typeof accept !== 'object') {
      addCheck(checks, p, 'fail', `${p} is not an object.`, { group });
      return;
    }

    if (accept.scheme !== undefined && accept.scheme !== 'exact' && accept.scheme !== 'upto') {
      addCheck(checks, `${p}-scheme`, 'warn', `${p}: unknown scheme "${accept.scheme}".`, { group, hint: 'Most clients support "exact".' });
    } else if (accept.scheme === undefined) {
      addCheck(checks, `${p}-scheme`, 'fail', `${p}: missing "scheme".`, { group, hint: 'Set "scheme": "exact".' });
    }

    const network = accept.network;
    const known = NETWORKS[network];
    if (!network) {
      addCheck(checks, `${p}-network`, 'fail', `${p}: missing "network".`, { group });
    } else if (known) {
      addCheck(checks, `${p}-network`, 'pass', `${p}: ${known.name} (${network}).`, { group });
    } else if (V1_NAMES[network]) {
      addCheck(checks, `${p}-network`, 'warn', `${p}: network "${network}" is a v1/legacy name, not a CAIP-2 id.`, {
        group,
        hint: `Use "${V1_NAMES[network]}".`,
      });
    } else if (CAIP2_RE.test(network)) {
      addCheck(checks, `${p}-network`, 'warn', `${p}: ${network} is CAIP-2 but not a network the doctor knows; asset checks are skipped.`, { group });
    } else {
      addCheck(checks, `${p}-network`, 'warn', `${p}: network "${network}" doesn't look like CAIP-2 (e.g. "eip155:8453" for Base).`, {
        group,
        hint: 'x402 v2 tooling and registries expect CAIP-2 network ids.',
      });
    }

    const family = familyOf(network);
    const isSolana = family === 'solana';
    const addressOk = isSolana ? isSolanaAddress : isEvmAddress;
    const kind = isSolana ? 'Solana' : 'EVM';

    if (!accept.payTo || !addressOk(accept.payTo)) {
      addCheck(checks, `${p}-payto`, 'fail', `${p}: "payTo" is missing or not a valid ${kind} address.`, { group });
    } else {
      addCheck(checks, `${p}-payto`, 'pass', `${p}: payTo ${accept.payTo} is a valid ${kind} address.`, { group });
    }

    if (!accept.asset || !addressOk(accept.asset)) {
      addCheck(checks, `${p}-asset`, 'warn', `${p}: "asset" is missing or not a valid ${isSolana ? 'token mint' : 'contract'} address.`, { group });
    } else if (known && accept.asset !== known.usdc) {
      const otherNetwork = Object.entries(NETWORKS).find(([, n]) => n.usdc === accept.asset);
      addCheck(
        checks,
        `${p}-asset`,
        otherNetwork ? 'fail' : 'warn',
        otherNetwork
          ? `${p}: asset is USDC on ${otherNetwork[1].name}, but the network is ${known.name}.`
          : `${p}: asset ${accept.asset} is not USDC on ${known.name}; clients may not recognise it.`,
        { group, hint: `USDC on ${known.name} is ${known.usdc}.` }
      );
    }

    const amount = accept.amount ?? accept.maxAmountRequired;
    if (amount === undefined || amount === null) {
      addCheck(checks, `${p}-amount`, 'fail', `${p}: no "amount" (v2) or "maxAmountRequired" (v1).`, { group });
    } else if (/^\d+\.\d+$/.test(String(amount)) || (Number(amount) > 0 && Number(amount) < 1)) {
      addCheck(checks, `${p}-amount`, 'warn', `${p}: amount "${amount}" looks like a decimal dollar value, not atomic token units.`, {
        group,
        hint: 'Amounts are integer strings in the smallest unit: "20000" is $0.02 of 6-decimal USDC. A decimal here makes payments fail or overcharge by orders of magnitude.',
      });
    } else if (!/^\d+$/.test(String(amount)) || BigInt(amount) === 0n) {
      addCheck(checks, `${p}-amount`, 'fail', `${p}: amount "${amount}" is not a positive integer.`, { group });
    } else {
      const usd = known && accept.asset === known.usdc ? ` ($${(Number(amount) / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')} USDC)` : '';
      addCheck(checks, `${p}-amount`, 'pass', `${p}: amount "${amount}" is in atomic units${usd}.`, { group });
    }

    const timeout = accept.maxTimeoutSeconds;
    if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600)) {
      addCheck(checks, `${p}-timeout`, 'warn', `${p}: maxTimeoutSeconds ${JSON.stringify(timeout)} is outside 1..3600.`, { group });
    }

    if (isSolana) {
      const feePayer = accept.extra?.feePayer;
      if (!feePayer) {
        addCheck(checks, `${p}-extra`, 'fail', `${p}: no extra.feePayer. Solana clients cannot build the transaction without it ("feePayer is required").`, {
          group,
          hint: 'The facilitator provides the fee payer; with @x402 SDKs it is filled in from the facilitator /supported response. Check that the facilitator supports this network.',
        });
      } else if (!isSolanaAddress(feePayer)) {
        addCheck(checks, `${p}-extra`, 'fail', `${p}: extra.feePayer is not a Solana address.`, { group });
      } else if (feePayer === accept.payTo) {
        addCheck(checks, `${p}-extra`, 'fail', `${p}: extra.feePayer equals payTo.`, { group, hint: 'The fee payer is the facilitator wallet, not the payout wallet.' });
      } else {
        addCheck(checks, `${p}-extra`, 'pass', `${p}: fee payer ${feePayer}.`, { group });
      }
    } else if (family === 'evm' && accept.scheme === 'exact') {
      if (!accept.extra?.name || !accept.extra?.version) {
        addCheck(checks, `${p}-extra`, 'fail', `${p}: extra.name/extra.version (the token's EIP-712 domain) is missing; EIP-3009 signatures cannot be built.`, {
          group,
          hint: 'For USDC on Base: { "name": "USD Coin", "version": "2" }.',
        });
      } else {
        addCheck(checks, `${p}-extra`, 'pass', `${p}: EIP-712 domain ${accept.extra.name} v${accept.extra.version}.`, { group });
      }
    }
  });
}

// ---------------------------------------------------------------- resource

function checkResource(challenge, finalUrl, checks) {
  const group = 'resource';
  if (challenge.x402Version !== 2) return;
  const resource = challenge.resource;
  if (!resource || !resource.url) {
    addCheck(checks, 'resource-url', 'warn', 'The challenge has no resource.url.', { group, hint: 'x402 v2 challenges describe the resource being paid for.' });
    return;
  }
  let declared;
  try {
    declared = new URL(resource.url);
  } catch {
    addCheck(checks, 'resource-url', 'fail', `resource.url "${resource.url}" is not a URL.`, { group });
    return;
  }
  const requested = new URL(finalUrl);
  if (requested.protocol === 'https:' && declared.protocol === 'http:') {
    addCheck(checks, 'resource-url', 'fail', `resource.url is ${resource.url} but the endpoint is served over https.`, {
      group,
      hint: 'Typical behind a TLS-terminating proxy (Render, Heroku, Fly): Express sees http. Set app.set("trust proxy", 1). Browser paywalls retry the payment at this URL and browsers block http from an https page.',
    });
  } else if (declared.host !== requested.host || declared.pathname !== requested.pathname) {
    addCheck(checks, 'resource-url', 'warn', `resource.url ${resource.url} differs from the requested URL ${requested.origin}${requested.pathname}.`, { group });
  } else {
    addCheck(checks, 'resource-url', 'pass', `resource.url matches the endpoint (${declared.protocol}//${declared.host}${declared.pathname}).`, { group });
  }

  const missing = ['description', 'mimeType'].filter((k) => !resource[k]);
  if (missing.length) {
    addCheck(checks, 'resource-metadata', 'warn', `resource is missing ${missing.join(' and ')}.`, {
      group,
      hint: 'Agents and the Bazaar show the description and mimeType; set them in the route config.',
    });
  } else {
    const extras = [resource.serviceName && `service "${resource.serviceName}"`, Array.isArray(resource.tags) && resource.tags.length && `tags ${resource.tags.join(', ')}`].filter(Boolean);
    addCheck(checks, 'resource-metadata', 'pass', `description and mimeType (${resource.mimeType}) set${extras.length ? `; ${extras.join('; ')}` : ''}.`, { group });
  }
}

// ------------------------------------------------------------------ bazaar

function schemaErrors(schema, value) {
  const errors = [];
  if (!schema || typeof schema !== 'object' || !value || typeof value !== 'object') return errors;
  for (const key of schema.required || []) if (!(key in value)) errors.push(`missing ${key}`);
  for (const [key, prop] of Object.entries(schema.properties || {})) {
    if (!(key in value) || !prop) continue;
    const v = value[key];
    if (prop.type === 'number' && typeof v !== 'number') errors.push(`${key} is not a number`);
    if (prop.type === 'string' && typeof v !== 'string') errors.push(`${key} is not a string`);
    if (Array.isArray(prop.enum) && !prop.enum.includes(v)) errors.push(`${key}=${JSON.stringify(v)} not in ${prop.enum.join('|')}`);
  }
  return errors;
}

function declaredRequest(origin, bazaar) {
  const input = bazaar?.info?.input || {};
  let path = bazaar.routeTemplate;
  for (const [k, v] of Object.entries(input.pathParams || {})) path = path.replace(`:${k}`, encodeURIComponent(String(v)));
  const query = new URLSearchParams(Object.entries(input.queryParams || {}).map(([k, v]) => [k, String(v)])).toString();
  const method = input.method || 'GET';
  const request = { url: `${origin}${path}${query ? `?${query}` : ''}`, method };
  if (input.body !== undefined && method !== 'GET') {
    request.headers = { 'content-type': 'application/json' };
    request.body = JSON.stringify(input.body);
  }
  return request;
}

async function checkBazaar(challenge, origin, safeFetch, checks) {
  const group = 'discovery';
  const bazaar = challenge.extensions?.bazaar;
  if (!bazaar) {
    addCheck(checks, 'bazaar', 'warn', 'No Bazaar discovery extension; agents cannot find this resource through the x402 Bazaar.', {
      group,
      hint: 'Declare it with declareDiscoveryExtension() from @x402/extensions/bazaar in the route config.',
    });
    return;
  }
  const result = validateDiscoveryExtension(bazaar);
  if (!result.valid) {
    addCheck(checks, 'bazaar', 'fail', `Bazaar declaration is invalid: ${(result.errors || []).join('; ')}`, { group });
    return;
  }
  addCheck(checks, 'bazaar', 'pass', `Bazaar declaration is valid${bazaar.routeTemplate ? ` (route ${bazaar.routeTemplate})` : ''}.`, { group });

  const exampleSchema = bazaar.schema?.properties?.output?.properties?.example;
  const example = bazaar.info?.output?.example;
  if (example !== undefined && exampleSchema && exampleSchema.properties) {
    const errors = schemaErrors(exampleSchema, example);
    if (errors.length) addCheck(checks, 'bazaar-output', 'warn', `Output example does not match its schema: ${errors.join('; ')}.`, { group });
    else addCheck(checks, 'bazaar-output', 'pass', 'Output example matches the declared output schema.', { group });
  } else if (example !== undefined) {
    addCheck(checks, 'bazaar-output', 'info', 'Output example declared without an output schema.', {
      group,
      hint: 'Pass output.schema to declareDiscoveryExtension so agents know the response shape and enums.',
    });
  }

  if (!bazaar.routeTemplate) return;
  const request = declaredRequest(origin, bazaar);
  try {
    const replay = await safeFetch(request.url, { method: request.method, headers: request.headers, body: request.body });
    if (replay.status === 402) {
      addCheck(checks, 'bazaar-replay', 'pass', `The declared example request (${request.method} ${request.url.slice(origin.length)}) answers 402.`, { group });
    } else {
      addCheck(checks, 'bazaar-replay', 'warn', `The declared example request (${request.method} ${request.url.slice(origin.length)}) answers HTTP ${replay.status}, not 402. The Bazaar cannot index a resource whose example does not reach the paywall.`, {
        group,
        hint: 'Make the example pathParams/queryParams a request that is valid (e.g. a supported pair).',
      });
    }
  } catch (err) {
    addCheck(checks, 'bazaar-replay', 'warn', `Could not replay the declared example request: ${err.message}`, { group });
  }
}

// ------------------------------------------------------------------ solana

async function solanaRpc(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || JSON.stringify(body.error));
  return body.result;
}

let payaiCache = { at: 0, feePayers: null };
async function payaiFeePayers() {
  if (payaiCache.feePayers && Date.now() - payaiCache.at < 10 * 60 * 1000) return payaiCache.feePayers;
  const res = await fetch(process.env.PAYAI_SUPPORTED_URL || PAYAI_SUPPORTED_URL, { signal: AbortSignal.timeout(8000) });
  const supported = await res.json();
  const feePayers = new Set();
  for (const kind of supported.kinds || []) if (kind.extra?.feePayer) feePayers.add(kind.extra.feePayer);
  for (const list of Object.values(supported.signers || {})) for (const s of list || []) feePayers.add(s);
  payaiCache = { at: Date.now(), feePayers };
  return feePayers;
}

async function checkSolana(accepts, checks, { rpcUrl, walletCompat = true }) {
  const group = 'settlement';
  const options = (accepts || []).filter((a) => NETWORKS[a?.network]?.family === 'solana' && isSolanaAddress(a.payTo) && isSolanaAddress(a.asset));
  for (const option of options) {
    const net = NETWORKS[option.network];
    const rpc = net.testnet ? 'https://api.devnet.solana.com' : rpcUrl;
    try {
      const result = await solanaRpc(rpc, 'getTokenAccountsByOwner', [option.payTo, { mint: option.asset }, { encoding: 'jsonParsed' }]);
      if ((result?.value || []).length > 0) {
        addCheck(checks, 'solana-payout-account', 'pass', `payTo ${option.payTo} has a token account for the asset on ${net.name}.`, { group });
      } else {
        addCheck(checks, 'solana-payout-account', 'fail', `payTo ${option.payTo} has no token account for ${option.asset} on ${net.name}. Every settlement fails on-chain until it exists.`, {
          group,
          hint: 'x402 Solana clients do not create the recipient token account. Send a small amount of the token (e.g. 0.01 USDC) to the payout wallet once.',
        });
      }
    } catch (err) {
      addCheck(checks, 'solana-payout-account', 'info', `Could not check the payout token account (${err.message}).`, { group });
    }

    const feePayer = option.extra?.feePayer;
    if (!walletCompat || !feePayer || net.testnet) continue;
    try {
      const payai = await payaiFeePayers();
      if (payai.has(feePayer)) {
        addCheck(checks, 'solana-wallets', 'warn', 'Solana payments are settled by PayAI, which rejects Phantom: Phantom inserts Lighthouse instructions before the transfer (invalid_exact_svm_smart_wallet_program_not_allowed). Agents, MetaMask, Solflare and Backpack work.', {
          group,
          hint: 'To accept Phantom, verify and settle Solana yourself with the x402 reference facilitator in smart-wallet mode (allow Token and Lighthouse programs).',
        });
      } else {
        addCheck(checks, 'solana-wallets', 'info', `Fee payer ${feePayer} is not a PayAI signer (self-hosted or another facilitator).`, { group });
      }
    } catch {
      // PayAI unreachable: nothing to say about wallet compatibility
    }
  }
}

// ----------------------------------------------------------------- paywall

async function checkPaywall(targetUrl, method, accepts, safeFetch, checks) {
  const group = 'browser';
  if (method !== 'GET') return;
  let res;
  try {
    res = await safeFetch(targetUrl, { headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'Mozilla/5.0 (x402-doctor)' } });
  } catch {
    return;
  }
  const html = res.text || '';
  if (!html.includes('window.x402')) {
    addCheck(checks, 'paywall', 'info', 'No browser paywall: people opening the URL in a browser see the raw 402.', {
      group,
      hint: 'Optional. With @x402/express, install @x402/paywall and pass a paywall provider.',
    });
    return;
  }
  const testnetFlag = /testnet:\s*(true|false)/.exec(html)?.[1];
  const mainnet = (accepts || []).some((a) => NETWORKS[a?.network] && !NETWORKS[a.network].testnet);
  if (mainnet && testnetFlag === 'true') {
    addCheck(checks, 'paywall', 'fail', 'The browser paywall runs in testnet mode while the endpoint charges on mainnet.', {
      group,
      hint: '@x402/paywall defaults to testnet: true; pass { testnet: false } in the paywall config.',
    });
  } else {
    addCheck(checks, 'paywall', 'pass', `Browser paywall present (${testnetFlag === 'false' ? 'mainnet' : 'testnet'} mode).`, { group });
  }
}

// ----------------------------------------------------------------- openapi

async function checkOpenApi(origin, safeFetch, checks) {
  const group = 'discovery';
  try {
    const res = await safeFetch(`${origin}/openapi.json`);
    if (res.status !== 200) {
      addCheck(checks, 'openapi-present', 'warn', `No /openapi.json (HTTP ${res.status}). Optional, but registries such as x402scan use it to discover input schemas.`, { group });
      return;
    }
    let json;
    try {
      json = JSON.parse(res.text);
    } catch {
      addCheck(checks, 'openapi-present', 'warn', '/openapi.json exists but is not valid JSON.', { group });
      return;
    }
    addCheck(checks, 'openapi-present', 'pass', '/openapi.json found and parses.', { group });
    if (!json.info?.title) addCheck(checks, 'openapi-title', 'warn', 'Missing info.title in openapi.json.', { group });
    if (!json.info?.['x-guidance']) {
      addCheck(checks, 'openapi-guidance', 'warn', 'Missing info.x-guidance, the field agents read to judge whether your service fits their task.', { group });
    }
  } catch (err) {
    addCheck(checks, 'openapi-present', 'warn', `Could not fetch /openapi.json: ${err.message}`, { group });
  }
}

// ------------------------------------------------------------------- probe

async function probe402(targetUrl, safeFetch, checks, method) {
  const group = 'challenge';
  const methods = method ? [method] : ['GET', 'POST'];
  const seen = [];
  for (const m of methods) {
    try {
      const res = await safeFetch(targetUrl, {
        method: m,
        headers: m === 'GET' ? {} : { 'content-type': 'application/json' },
        body: m === 'GET' ? undefined : '{}',
      });
      seen.push(`${m} ${res.status}`);
      if (res.status === 402) {
        addCheck(checks, 'returns-402', 'pass', `Endpoint returns 402 Payment Required for ${m}.`, { group });
        return { method: m, res };
      }
    } catch (err) {
      if (err.code === 'EBLOCKED') throw err;
      seen.push(`${m} error: ${err.message}`);
    }
  }
  addCheck(checks, 'returns-402', 'fail', `Endpoint did not return 402 Payment Required (${seen.join(', ')}). Agents and registries will not recognise it as a paid x402 resource.`, {
    group,
    hint: 'Check the route and method; a 400/404 here often means the example input is invalid.',
  });
  return null;
}

// ------------------------------------------------------------------ runner

async function diagnose(targetUrl, { safeFetch, method, rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_SOLANA_RPC } = {}) {
  const url = new URL(targetUrl);
  const checks = [];

  const probe = await probe402(url.href, safeFetch, checks, method);
  let challenge = null;
  if (probe) {
    challenge = await checkEnvelope(probe, checks);
    if (challenge) {
      checkAccepts(challenge.accepts, checks);
      checkResource(challenge, probe.res.url || url.href, checks);
    }
  }

  const origin = new URL(probe?.res.url || url.href).origin;
  await Promise.all([
    checkOpenApi(origin, safeFetch, checks),
    challenge ? checkBazaar(challenge, origin, safeFetch, checks) : null,
    challenge ? checkSolana(challenge.accepts, checks, { rpcUrl }) : null,
    challenge ? checkPaywall(url.href, probe.method, challenge.accepts, safeFetch, checks) : null,
  ]);

  const order = ['challenge', 'accepts', 'resource', 'settlement', 'discovery', 'browser'];
  checks.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
  const overall = checks.some((c) => c.status === 'fail') ? 'fail' : checks.some((c) => c.status === 'warn') ? 'warn' : 'pass';
  return { url: url.href, method: probe?.method || null, overall, checks, challenge };
}

module.exports = {
  diagnose,
  probe402,
  decodeChallengeValue,
  checkEnvelope,
  checkAccepts,
  checkResource,
  checkBazaar,
  checkSolana,
  checkPaywall,
  checkOpenApi,
  schemaErrors,
  declaredRequest,
};
