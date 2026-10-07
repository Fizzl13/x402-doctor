// The diagnostic checks. Every check pushes { id, group, status, message, hint }
// where status is pass | warn | fail | info and hint says how to fix it.
//
// Most checks trace back to a real bug: v1/v2 confusion, header-only
// envelopes and decimal amounts (PlainText), plus an http:// resource URL
// behind a TLS proxy, a missing Solana fee payer, a payout wallet without a
// USDC account, a testnet paywall on mainnet and Phantom payments rejected by
// PayAI (Ichimoku Signal).

const { validateDiscoveryExtension } = require('@x402/extensions/bazaar');
const { NETWORKS, V1_NAMES, CAIP2_RE, isSolanaAddress, isEvmAddress, isXrplAddress, isXrplCurrency, isAlgorandAddress, isAsaId, familyOf, sameAsset } = require('./networks');
const { walletCompatibility, summaryCheck } = require('./wallets');
const { checkMcp } = require('./mcp-check');
const { checkSiteScan } = require('./site-scan');

// Schemes the standard x402 clients know; anything else needs its own client.
const isCustomScheme = (scheme) => scheme !== undefined && scheme !== 'exact' && scheme !== 'upto';

const CHALLENGE_HEADER_NAMES = ['payment-required', 'x-payment-required', 'x402'];
const { checkMpp } = require('./mpp');
const { checkL402 } = require('./l402');
const { describeCheck } = require('./jev-describe');
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

// XRPL options: r-address payTo (with its checksum), "XRP" priced in drops (an integer) or a currency code with
// extra.issuer priced in decimals. RLUSD from another issuer than Ripple's is flagged: it is not the stablecoin.
function checkXrplOption(accept, p, checks, group, known) {
  if (!isXrplAddress(accept.payTo)) {
    addCheck(checks, `${p}-payto`, 'fail', `${p}: "payTo" is missing or not a valid XRPL address (r…, with a valid checksum).`, { group });
  } else {
    addCheck(checks, `${p}-payto`, 'pass', `${p}: payTo ${accept.payTo} is a valid XRPL address.`, { group });
  }
  const xrp = String(accept.asset ?? 'XRP').toUpperCase() === 'XRP';
  if (accept.asset !== undefined && !isXrplCurrency(accept.asset)) {
    addCheck(checks, `${p}-asset`, 'warn', `${p}: asset "${accept.asset}" is not an XRPL currency code (3 characters or 40 hex).`, { group });
  } else if (!xrp && !isXrplAddress(accept.extra?.issuer)) {
    addCheck(checks, `${p}-asset`, 'warn', `${p}: issued currency without a valid extra.issuer; wallets cannot tell which token to send.`, { group });
  } else if (!xrp && known?.rlusd && String(accept.asset).toUpperCase() === known.rlusd.currency && accept.extra.issuer !== known.rlusd.issuer) {
    addCheck(checks, `${p}-asset`, 'warn', `${p}: asset is called RLUSD but its issuer ${accept.extra.issuer} is not Ripple's (${known.rlusd.issuer}) on ${known.name}: it is not the RLUSD stablecoin.`, { group, hint: `Ripple's RLUSD on ${known.name} is issued by ${known.rlusd.issuer}.` });
  }
  const amount = accept.amount ?? accept.maxAmountRequired;
  if (amount === undefined || amount === null || !/^\d+(\.\d+)?$/.test(String(amount)) || Number(amount) <= 0) {
    addCheck(checks, `${p}-amount`, 'fail', `${p}: amount ${JSON.stringify(amount)} is not a positive number.`, { group });
  } else if (xrp && !/^\d+$/.test(String(amount))) {
    addCheck(checks, `${p}-amount`, 'fail', `${p}: an XRP amount is in drops, a whole number; "${amount}" has decimals.`, { group, hint: '1 XRP is 1,000,000 drops: "15000" is 0.015 XRP.' });
  } else {
    addCheck(checks, `${p}-amount`, 'pass', xrp ? `${p}: amount ${amount} drops (${Number(amount) / 1e6} XRP).` : `${p}: amount "${amount}" (issued currencies are priced in decimals).`, { group });
  }
  // Agents built on t54's SDK (x402-xrpl, Xrpl.X402; most of the XRPL AI Hub) refuse an option without
  // extra.invoiceId, and t54's facilitator wants the x402 SourceTag 804681468 in the payment. Every XRPL option
  // in the CDP Bazaar carries both (Oct 2026); @x402/xrpl's server adds neither by default.
  const extra = accept.extra || {};
  if (typeof extra.invoiceId !== 'string' || !extra.invoiceId) {
    addCheck(checks, `${p}-invoice`, 'warn', `${p}: no extra.invoiceId. Agents built on t54's SDK (most of the XRPL AI Hub) refuse to pay an XRPL option without one, and t54's facilitator answers missing_invoice_id.`, { group, hint: 'Add extra.invoiceId, e.g. "<your host> <route>" (a fixed string per route is fine); the payer binds it into the payment as InvoiceID.' });
  } else if (extra.sourceTag === undefined) {
    addCheck(checks, `${p}-invoice`, 'info', `${p}: extra.invoiceId is set, but no extra.sourceTag. Payers built on t54's SDK then sign without the x402 SourceTag, and t54's facilitator rejects that (source_tag_mismatch).`, { group, hint: 'Add extra.sourceTag: 804681468, the XRPL SourceTag for x402 payments.' });
  } else {
    addCheck(checks, `${p}-invoice`, 'pass', `${p}: extra.invoiceId and extra.sourceTag are set, so payers built on @x402/xrpl and on t54's SDK can both pay.`, { group });
  }
}

// Algorand options: a 58-character payTo, an ASA id as asset (USDC = 31566704), atomic integer amounts, and the
// facilitator's fee payer in extra.feePayer (it pays the network fee of the payment group).
function checkAlgorandOption(accept, p, checks, group, known) {
  if (!isAlgorandAddress(accept.payTo)) {
    addCheck(checks, `${p}-payto`, 'fail', `${p}: "payTo" is missing or not a valid Algorand address (58 characters with a valid checksum).`, { group });
  } else {
    addCheck(checks, `${p}-payto`, 'pass', `${p}: payTo ${accept.payTo} is a valid Algorand address.`, { group });
  }
  if (!isAsaId(accept.asset)) {
    addCheck(checks, `${p}-asset`, 'warn', `${p}: asset ${JSON.stringify(accept.asset)} is not an Algorand asset id (ASA, a number such as 31566704 for USDC).`, { group });
  } else if (known && String(accept.asset) !== known.usdc) {
    const other = Object.values(NETWORKS).find((n) => n.family === 'algorand' && n.usdc === String(accept.asset));
    addCheck(checks, `${p}-asset`, other ? 'fail' : 'warn', other ? `${p}: asset is USDC on ${other.name}, but the network is ${known.name}.` : `${p}: asset ${accept.asset} is not USDC on ${known.name}; clients may not recognise it.`, { group, hint: `USDC on ${known.name} is ASA ${known.usdc}.` });
  }
  const amount = accept.amount ?? accept.maxAmountRequired;
  if (amount === undefined || amount === null || !/^\d+$/.test(String(amount)) || BigInt(amount) === 0n) {
    addCheck(checks, `${p}-amount`, 'fail', `${p}: amount ${JSON.stringify(amount)} is not a positive integer in atomic units.`, { group, hint: 'USDC on Algorand has 6 decimals: "10000" is $0.01.' });
  } else {
    const usd = known && String(accept.asset) === known.usdc ? ` ($${(Number(amount) / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')} USDC)` : '';
    addCheck(checks, `${p}-amount`, 'pass', `${p}: amount "${amount}" is in atomic units${usd}.`, { group });
  }
  if (accept.extra?.feePayer !== undefined && !isAlgorandAddress(accept.extra.feePayer)) {
    addCheck(checks, `${p}-feepayer`, 'fail', `${p}: extra.feePayer ${JSON.stringify(accept.extra.feePayer)} is not a valid Algorand address; clients cannot build the payment group.`, { group });
  }
  checkDescriptionLength(accept.description, `${p}-description-length`, `${p}.description`, checks, group);
}

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
      addCheck(checks, `${p}-scheme`, 'warn', `${p}: unknown scheme "${accept.scheme}". Standard x402 clients and wallets pay "exact" (some also "upto"), so only clients built for this scheme can pay this option.`, { group, hint: 'Offer an "exact" option next to it if you want standard x402 clients to pay.' });
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
    if (family === 'xrpl') {
      checkXrplOption(accept, p, checks, group, known);
      return;
    }
    if (family === 'algorand') {
      checkAlgorandOption(accept, p, checks, group, known);
      return;
    }
    if (!family && CAIP2_RE.test(String(network))) {
      // A well-formed id for a chain the doctor can't validate (not EVM, Solana or XRPL): don't judge its addresses or amounts.
      addCheck(checks, `${p}-payto`, 'info', `${p}: address, asset and amount checks skipped for ${network}.`, { group });
      return;
    }
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
    } else if (known && !sameAsset(accept.asset, known.usdc)) {
      const otherNetwork = Object.entries(NETWORKS).find(([, n]) => sameAsset(n.usdc, accept.asset));
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
      const usd = known && sameAsset(accept.asset, known.usdc) ? ` ($${(Number(amount) / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')} USDC)` : '';
      addCheck(checks, `${p}-amount`, 'pass', `${p}: amount "${amount}" is in atomic units${usd}.`, { group });
    }

    checkDescriptionLength(accept.description, `${p}-description-length`, `${p}.description`, checks, group);

    const timeout = accept.maxTimeoutSeconds;
    if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600)) {
      addCheck(checks, `${p}-timeout`, 'warn', `${p}: maxTimeoutSeconds ${JSON.stringify(timeout)} is outside 1..3600.`, { group });
    }

    // extra.feePayer is the facilitator signer of the standard Solana schemes;
    // a custom scheme (e.g. the payer sends the transfer and proves it) has none.
    if (isSolana && !isCustomScheme(accept.scheme)) {
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
    } else if (family === 'evm' && accept.scheme === 'upto') {
      // "upto" on EVM (@x402/evm/upto): the buyer signs a Permit2 transfer up to `amount` to the x402
      // upto proxy; the facilitator settles what the call really cost. Clients refuse without
      // extra.facilitatorAddress, and only wallets with a Permit2 allowance can pay.
      const fa = accept.extra?.facilitatorAddress;
      const method = accept.extra?.assetTransferMethod;
      if (!fa) {
        addCheck(checks, `${p}-extra`, 'fail', `${p}: "upto" needs extra.facilitatorAddress (the facilitator that settles the Permit2 transfer); x402 upto clients refuse to pay without it.`, { group, hint: 'Configure the server with an upto facilitator (getExtra() adds facilitatorAddress), or use the "exact" scheme.' });
      } else if (!isEvmAddress(fa)) {
        addCheck(checks, `${p}-extra`, 'fail', `${p}: extra.facilitatorAddress "${fa}" is not an EVM address.`, { group });
      } else if (method && method !== 'permit2') {
        addCheck(checks, `${p}-extra`, 'warn', `${p}: "upto" with assetTransferMethod "${method}"; the standard x402 upto scheme on EVM uses "permit2", so standard clients may not pay this.`, { group, hint: 'Set extra.assetTransferMethod to "permit2".' });
      } else {
        addCheck(checks, `${p}-extra`, 'pass', `${p}: "upto" via Permit2, settled by facilitator ${fa}.`, { group });
      }
      addCheck(checks, `${p}-upto`, 'info', `${p}: "upto" charges at most ${accept.amount ?? '?'} (base units); the real charge is settled after the call and can be lower. Buyers need a one-time Permit2 approval for this token, so wallets that only sign EIP-3009 (most x402 clients today) can't pay this option.`, { group, hint: 'Offer an "exact" option next to it so every x402 client can pay.' });
    }
    // "upto" on Solana (@x402/svm/upto) also needs the facilitator's receiverAuthorizer, next to feePayer.
    if (isSolana && accept.scheme === 'upto') {
      const ra = accept.extra?.receiverAuthorizer;
      if (!ra || !isSolanaAddress(ra)) {
        addCheck(checks, `${p}-upto`, 'fail', `${p}: "upto" on Solana needs extra.receiverAuthorizer (a Solana address); x402 upto clients can't build the payment without it.`, { group, hint: 'Configure the server with an upto facilitator that advertises receiverAuthorizer.' });
      } else {
        addCheck(checks, `${p}-upto`, 'info', `${p}: "upto" charges at most ${accept.amount ?? '?'} (base units); the real charge is settled after the call and can be lower.`, { group });
      }
    }
  });
}

// ---------------------------------------------------------------- resource

// The CDP facilitator validates payments against its API schema, where the resource
// description (v2 resource.description, v1 accepts[].description) has maxLength 500.
// Longer and the payment is rejected at verify as an invalid paymentPayload.
const CDP_DESCRIPTION_MAX = 500;
const DESCRIPTION_NEAR = 450;

function checkDescriptionLength(description, id, where, checks, group) {
  if (typeof description !== 'string') return;
  const length = [...description].length;
  if (length > CDP_DESCRIPTION_MAX) {
    addCheck(checks, id, 'warn', `${where} is ${length} characters; the CDP facilitator accepts at most ${CDP_DESCRIPTION_MAX} and rejects the payment at verify (invalid paymentPayload), so buyers get a second 402.`, {
      group,
      hint: `Trim the description to ${CDP_DESCRIPTION_MAX} characters or fewer. Other facilitators may accept it, but CDP (and the Bazaar listing that depends on it) will not.`,
    });
  } else if (length > DESCRIPTION_NEAR) {
    addCheck(checks, id, 'info', `${where} is ${length} characters, close to the CDP limit of ${CDP_DESCRIPTION_MAX}.`, { group });
  }
}

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
  checkDescriptionLength(resource.description, 'resource-description-length', 'resource.description', checks, group);
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

// Short-lived cache: the trust scan checks the same payout wallets for many
// endpoints, and repeated diagnoses of one endpoint need no second lookup.
const rpcCache = new Map();
async function solanaRpc(rpcUrl, method, params) {
  const key = JSON.stringify([rpcUrl, method, params]);
  const hit = rpcCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.result;
  const result = await solanaRpcUncached(rpcUrl, method, params);
  if (rpcCache.size > 5000) rpcCache.clear();
  rpcCache.set(key, { at: Date.now(), result });
  return result;
}

async function solanaRpcUncached(rpcUrl, method, params) {
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
    // Which accepts[] entry this is, so the wallet summary can tell options apart.
    const index = accepts.indexOf(option);
    const rpc = net.testnet ? 'https://api.devnet.solana.com' : rpcUrl;
    try {
      const result = await solanaRpc(rpc, 'getTokenAccountsByOwner', [option.payTo, { mint: option.asset }, { encoding: 'jsonParsed' }]);
      if ((result?.value || []).length > 0) {
        addCheck(checks, 'solana-payout-account', 'pass', `payTo ${option.payTo} has a token account for the asset on ${net.name}.`, { group, option: index });
      } else if (isCustomScheme(option.scheme)) {
        // The payer sends the transfer itself: wallets that create the recipient
        // account (the payer pays its rent) still work, plain transfers fail.
        addCheck(checks, 'solana-payout-account', 'warn', `payTo ${option.payTo} has no token account for ${option.asset} on ${net.name}. With the "${option.scheme}" scheme the payer sends the transfer, so it only goes through if the payer's wallet also creates that account (about 0.002 SOL, paid by the payer); plain token transfers fail.`, {
          group,
          option: index,
          hint: 'Send a small amount of the token (e.g. 0.01 USDC) to the payout wallet once, so every payer can send a plain transfer.',
        });
      } else {
        addCheck(checks, 'solana-payout-account', 'fail', `payTo ${option.payTo} has no token account for ${option.asset} on ${net.name}. Every settlement fails on-chain until it exists.`, {
          group,
          option: index,
          hint: 'x402 Solana clients do not create the recipient token account. Send a small amount of the token (e.g. 0.01 USDC) to the payout wallet once.',
        });
      }
    } catch (err) {
      addCheck(checks, 'solana-payout-account', 'info', `Could not check the payout token account (${err.message}).`, { group, option: index });
    }

    const feePayer = option.extra?.feePayer;
    if (!walletCompat || !feePayer || net.testnet) continue;
    try {
      const payai = await payaiFeePayers();
      if (payai.has(feePayer)) {
        addCheck(checks, 'solana-wallets', 'warn', 'Solana payments are settled by PayAI, which rejects Phantom: Phantom inserts Lighthouse instructions before the transfer (invalid_exact_svm_smart_wallet_program_not_allowed). Agents, MetaMask, Solflare and Backpack work.', {
          group,
          option: index,
          hint: 'To accept Phantom, verify and settle Solana yourself with the x402 reference facilitator in smart-wallet mode (allow Token and Lighthouse programs).',
        });
      } else {
        addCheck(checks, 'solana-wallets', 'info', `Fee payer ${feePayer} is not a PayAI signer (self-hosted or another facilitator).`, { group, option: index });
      }
    } catch {
      // PayAI unreachable: nothing to say about wallet compatibility
    }
  }
}

// --------------------------------------------------- Algorand payout opt-in

// An Algorand account can only receive an ASA it has opted in to: a payout address without the USDC opt-in makes
// every payment fail. One algod lookup per Algorand option (public AlgoNode endpoints, no key).
async function checkAlgorand(accepts, checks, { fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const group = 'settlement';
  for (const option of (accepts || []).filter((a) => NETWORKS[a?.network]?.family === 'algorand' && isAlgorandAddress(a.payTo) && isAsaId(a.asset))) {
    const net = NETWORKS[option.network];
    const index = accepts.indexOf(option);
    try {
      const res = await fetchImpl(`${net.algod}/v2/accounts/${option.payTo}/assets/${option.asset}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 200) {
        addCheck(checks, 'algorand-payout-optin', 'pass', `payTo ${option.payTo} has opted in to ASA ${option.asset} on ${net.name}, so it can receive the payment.`, { group, option: index });
      } else if (res.status === 404) {
        addCheck(checks, 'algorand-payout-optin', 'fail', `payTo ${option.payTo} has not opted in to ASA ${option.asset} on ${net.name} (or the account does not exist). Every payment to it fails until it does.`, {
          group,
          option: index,
          hint: 'Opt the payout address in to the asset once (a 0-amount transfer of the ASA to itself, from the wallet), keeping 0.1 ALGO extra minimum balance for it.',
        });
      } else {
        addCheck(checks, 'algorand-payout-optin', 'info', `Could not check the payout opt-in (algod HTTP ${res.status}).`, { group, option: index });
      }
    } catch (err) {
      addCheck(checks, 'algorand-payout-optin', 'info', `Could not check the payout opt-in (${err.message}).`, { group, option: index });
    }
  }
}

// --------------------------------------------------- XRPL payout account

// What the XRP Ledger itself says about an XRPL option's payout account (public JSON-RPC, no key): it must exist
// (be activated with the XRP reserve), must not refuse payments (DepositAuth) or demand a destination tag the
// option doesn't give (RequireDestTag), and for an issued token like RLUSD must have a trust line to the issuer.
// Each of those makes every payment fail.
const LSF_REQUIRE_DEST_TAG = 0x00020000;
const LSF_DEPOSIT_AUTH = 0x01000000;
// The daily scan checks hundreds of XRPL endpoints from a handful of sellers: ledger answers are reused for 15
// minutes per (node, method, account, peer), so the public node is asked once per payout account, not per endpoint.
const xrplCache = new Map();
const XRPL_CACHE_MS = 15 * 60 * 1000;
async function checkXrpl(accepts, checks, { fetchImpl = globalThis.fetch, timeoutMs = 8000, cache = fetchImpl === globalThis.fetch } = {}) {
  const group = 'settlement';
  for (const option of (accepts || []).filter((a) => NETWORKS[a?.network]?.family === 'xrpl' && isXrplAddress(a.payTo))) {
    const net = NETWORKS[option.network];
    const index = accepts.indexOf(option);
    const rpc = async (method, params) => {
      const key = `${net.rpc}|${method}|${params.account}|${params.peer || ''}`;
      const hit = cache && xrplCache.get(key);
      if (hit && Date.now() - hit.at < XRPL_CACHE_MS) return hit.result;
      const res = await fetchImpl(net.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params: [{ ...params, ledger_index: 'validated' }] }), signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`XRPL node HTTP ${res.status}`);
      const result = (await res.json())?.result ?? {};
      if (cache) {
        if (xrplCache.size > 2000) xrplCache.clear();
        xrplCache.set(key, { at: Date.now(), result });
      }
      return result;
    };
    try {
      const info = await rpc('account_info', { account: option.payTo });
      if (info.error === 'actNotFound') {
        addCheck(checks, 'xrpl-payout-account', 'fail', `payTo ${option.payTo} does not exist on ${net.name}: the account was never activated, so every payment to it fails.`, {
          group, option: index, hint: 'Activate the payout account by sending it the XRP base reserve (currently 1 XRP) once.',
        });
        continue;
      }
      if (info.error || !info.account_data) { addCheck(checks, 'xrpl-payout-account', 'info', `Could not check the payout account (${info.error_message || info.error || 'no account data'}).`, { group, option: index }); continue; }
      const flags = Number(info.account_data.Flags) || 0;
      const tag = option.extra?.destinationTag ?? option.extra?.destination_tag;
      if (flags & LSF_DEPOSIT_AUTH) {
        addCheck(checks, 'xrpl-payout-account', 'fail', `payTo ${option.payTo} has Deposit Authorization on: it only accepts payments from accounts it pre-authorised, so buyers' payments are refused.`, { group, option: index, hint: 'Turn off DepositAuth on the payout account, or use another account for x402.' });
      } else if (flags & LSF_REQUIRE_DEST_TAG && (tag === undefined || tag === null)) {
        addCheck(checks, 'xrpl-payout-account', 'fail', `payTo ${option.payTo} requires a destination tag, but the option gives none (extra.destinationTag): payments without one are refused.`, { group, option: index, hint: 'Add extra.destinationTag to the option, or turn off RequireDest on the payout account.' });
      } else {
        addCheck(checks, 'xrpl-payout-account', 'pass', `payTo ${option.payTo} is an active ${net.name} account that accepts payments.`, { group, option: index });
      }
      const xrp = String(option.asset ?? 'XRP').toUpperCase() === 'XRP';
      if (!xrp && isXrplAddress(option.extra?.issuer)) {
        const lines = await rpc('account_lines', { account: option.payTo, peer: option.extra.issuer });
        const currency = String(option.asset).toUpperCase();
        const line = (lines.lines || []).find((l) => String(l.currency).toUpperCase() === currency);
        const name = net.rlusd && currency === net.rlusd.currency ? 'RLUSD' : option.asset;
        if (!line) {
          addCheck(checks, 'xrpl-payout-trustline', 'fail', `payTo ${option.payTo} has no trust line for ${name} from ${option.extra.issuer} on ${net.name}, so it cannot receive the payment.`, {
            group, option: index, hint: `Set a trust line for ${name} (issuer ${option.extra.issuer}) on the payout account, from its wallet (Xaman, Crossmark).`,
          });
        } else if (line.freeze || line.freeze_peer) {
          addCheck(checks, 'xrpl-payout-trustline', 'fail', `The ${name} trust line of payTo ${option.payTo} is frozen, so it cannot receive the payment.`, { group, option: index });
        } else {
          addCheck(checks, 'xrpl-payout-trustline', 'pass', `payTo ${option.payTo} has a trust line for ${name}, so it can receive the payment.`, { group, option: index });
        }
      }
    } catch (err) {
      addCheck(checks, 'xrpl-payout-account', 'info', `Could not check the payout account (${err.message}).`, { group, option: index });
    }
  }
}

// ------------------------------------------------------ EVM payout wallet

// MetaMask's security check (Blockaid) flags an x402 payment signature to an
// unknown regular wallet as "a deceptive request" ("the spender ... is an
// untrusted EOA"). Seen on our own services; browser buyers stop there.
// Agents are not affected. One eth_getCode per EVM mainnet option.
function evmRpcFor(network, evmRpcUrls) {
  if (evmRpcUrls && evmRpcUrls[network]) return evmRpcUrls[network];
  if (network === 'eip155:8453' && process.env.BASE_RPC_URL) return process.env.BASE_RPC_URL;
  return NETWORKS[network]?.rpc || null;
}

async function checkEvmPayTo(accepts, checks, { evmRpcUrls } = {}) {
  const group = 'wallets';
  const seen = new Set();
  for (const [index, option] of (accepts || []).entries()) {
    const net = NETWORKS[option?.network];
    if (!net || net.family !== 'evm' || net.testnet || !isEvmAddress(option.payTo)) continue;
    const rpc = evmRpcFor(option.network, evmRpcUrls);
    const key = `${option.network}:${option.payTo.toLowerCase()}`;
    if (!rpc || seen.has(key)) continue;
    seen.add(key);
    let code;
    try {
      code = await solanaRpc(rpc, 'eth_getCode', [option.payTo, 'latest']);
    } catch {
      continue; // RPC unreachable: nothing to say
    }
    // No code = a plain EOA. 0xef0100 + address = an EOA upgraded to a smart
    // account (EIP-7702, e.g. MetaMask's) - Blockaid still calls it an EOA.
    const plain = typeof code === 'string' && /^0x0*$/.test(code);
    const delegated = typeof code === 'string' && /^0xef0100[0-9a-f]{40}$/i.test(code);
    if (plain || delegated) {
      const kind = delegated ? 'a regular wallet (EOA, upgraded to a smart account with EIP-7702)' : 'a regular wallet (EOA)';
      addCheck(checks, 'evm-payto-eoa', 'info', `payTo ${option.payTo} on ${net.name} is ${kind}. MetaMask's security check (Blockaid) may flag the payment signature as "a deceptive request" because it doesn't know this wallet, which can scare off browser buyers. Agents are not affected.`, {
        group,
        option: index,
        hint: 'Report the payout wallet to Blockaid as a false positive: the "Report an issue" link in the MetaMask warning, "Developer" option, one report per domain. Until it is cleared, tell browser buyers before they sign what the warning means and what to check (To and Value).',
      });
    }
  }
}

// The x402 upto proxy (@x402/evm/upto, same address on every chain): without its code on the
// option's network, every upto payment fails at verify (permit2_proxy_not_deployed).
const X402_UPTO_PROXY = '0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002';
async function checkUptoProxy(accepts, checks, { evmRpcUrls } = {}) {
  const seen = new Set();
  for (const [index, option] of (accepts || []).entries()) {
    const net = NETWORKS[option?.network];
    if (option?.scheme !== 'upto' || !net || net.family !== 'evm' || seen.has(option.network)) continue;
    seen.add(option.network);
    const rpc = evmRpcFor(option.network, evmRpcUrls);
    if (!rpc) continue;
    let code;
    try { code = await solanaRpc(rpc, 'eth_getCode', [X402_UPTO_PROXY, 'latest']); } catch { continue; }
    if (typeof code !== 'string') continue; // no answer from the RPC: nothing to say
    if (/^0x0*$/.test(code)) {
      addCheck(checks, 'upto-proxy', 'fail', `The x402 upto proxy (${X402_UPTO_PROXY}) is not deployed on ${net.name}, so every "upto" payment on it fails at verify.`, { group: 'accepts', option: index, hint: 'Use the "exact" scheme on this network.' });
    } else {
      addCheck(checks, 'upto-proxy', 'pass', `The x402 upto proxy is deployed on ${net.name}.`, { group: 'accepts', option: index });
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
  // Inside window.x402 = {...}: a JS object (testnet: true) or JSON ("testnet": true,
  // as the Python x402 package writes it). Not the bundled wallet code further on.
  const config = html.slice(html.indexOf('window.x402'), html.indexOf('window.x402') + 20000);
  const testnetFlag = /["']?testnet["']?\s*:\s*(true|false)/.exec(config)?.[1];
  const mainnet = (accepts || []).some((a) => NETWORKS[a?.network] && !NETWORKS[a.network].testnet);
  if (mainnet && testnetFlag === 'true') {
    addCheck(checks, 'paywall', 'fail', 'The browser paywall runs in testnet mode while the endpoint charges on mainnet.', {
      group,
      hint: '@x402/paywall defaults to testnet: true; pass { testnet: false } in the paywall config.',
    });
  } else {
    addCheck(checks, 'paywall', 'pass', `Browser paywall present${testnetFlag ? ` (${testnetFlag === 'false' ? 'mainnet' : 'testnet'} mode)` : ''}.`, { group });
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
    if (res.truncated) {
      const mb = (Buffer.byteLength(res.text) / 1048576).toFixed(1);
      addCheck(checks, 'openapi-present', 'warn', `/openapi.json is too large to read (over ${mb} MB), so the doctor could not check it; crawlers and agents may give up on it too.`, {
        group,
        hint: 'Keep the root spec small: list the paid routes there and move the rest to per-family files.',
      });
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

// ------------------------------------------------------------ domain move

// Default hosts of hosting platforms: a service there usually also has its own domain.
const PLATFORM_HOST = /\.(onrender\.com|vercel\.app|netlify\.app|fly\.dev|railway\.app|herokuapp\.com|workers\.dev|pages\.dev|run\.app|azurewebsites\.net|replit\.app|deno\.dev)$/i;
const hostOf = (origin) => {
  try {
    return new URL(origin).hostname;
  } catch {
    return '';
  }
};

// /.well-known/x402 is what crawlers (x402scan and others) read to find the
// paid routes. Built from the request Host header, it can name another domain
// than the one being checked, and crawlers then index that one.
async function checkWellKnown(origin, safeFetch, checks) {
  const group = 'discovery';
  const hint = 'Build the URLs from a fixed public origin (for example a PUBLIC_URL setting), not from the request Host header.';
  let res;
  try {
    res = await safeFetch(`${origin}/.well-known/x402`);
  } catch (err) {
    addCheck(checks, 'well-known', 'info', `Could not fetch /.well-known/x402: ${err.message}`, { group });
    return;
  }
  if (res.status !== 200) {
    addCheck(checks, 'well-known', 'info', `No /.well-known/x402 (HTTP ${res.status}). Optional: crawlers such as x402scan read it to find your paid routes.`, {
      group,
      hint: 'Serve {"version": 1, "resources": ["https://your-domain/your/route"]} there.',
    });
    return;
  }
  let doc;
  try {
    doc = JSON.parse(res.text);
  } catch {
    doc = null;
  }
  // Resources as URL strings, or as objects with a url (the richer
  // {"x402Version": 2, "kind": "resource-server"} form some servers publish).
  const resources = doc && Array.isArray(doc.resources) ? doc.resources.map((r) => (typeof r === 'string' ? r : r && typeof r.url === 'string' ? r.url : null)).filter(Boolean) : [];
  if (!resources.length) {
    addCheck(checks, 'well-known', 'warn', '/.well-known/x402 has no resources list (URLs, or objects with a url), so crawlers cannot read it.', {
      group,
      hint: 'Serve {"version": 1, "resources": ["https://your-domain/your/route"]}.',
    });
    return;
  }
  const others = [...new Set(resources.map((r) => {
    try {
      return new URL(r).origin;
    } catch {
      return 'an invalid URL';
    }
  }))].filter((o) => o !== origin);
  if (!others.length) {
    addCheck(checks, 'well-known', 'pass', `/.well-known/x402 lists ${resources.length} resource(s), all on this origin.`, { group });
  } else if (PLATFORM_HOST.test(hostOf(origin)) && others.every((o) => hostOf(o) && !PLATFORM_HOST.test(hostOf(o)))) {
    addCheck(checks, 'well-known', 'info', `This is a hosting platform address; /.well-known/x402 points crawlers at ${others.join(', ')}. Good if that is your main domain.`, { group });
  } else {
    addCheck(checks, 'well-known', 'warn', `/.well-known/x402 lists resources on ${others.join(', ')}, not on ${origin}. Crawlers index the URLs listed there; after a domain move this keeps sending agents to the old host.`, { group, hint });
  }
}

// ERC-8004 (on-chain identity for agents): /.well-known/agent-registration.json says who the
// service is and where it is registered. For a registration in the ERC-8004 Identity Registry on
// an EVM chain we check on-chain that the agent id exists and that its tokenURI points back to
// this domain (the "domain verification" of ERC-8004). Read-only: two eth_calls, nothing paid.
const ERC8004_IDENTITY = new Set(['0x8004a169fb4a3325136eb29fa0ceb6d2e539a432']); // the same CREATE2 address on every chain
function decodeAbiString(hex) {
  const h = String(hex || '').replace(/^0x/, '');
  if (h.length < 128) return null;
  const len = parseInt(h.slice(64, 128), 16);
  if (!(len >= 0) || len > 4096 || h.length < 128 + len * 2) return null;
  return Buffer.from(h.slice(128, 128 + len * 2), 'hex').toString('utf8');
}
async function checkAgentIdentity(origin, safeFetch, checks, { evmRpcUrls } = {}) {
  const group = 'discovery';
  const where = `${origin}/.well-known/agent-registration.json`;
  let res;
  try {
    res = await safeFetch(where);
  } catch {
    return; // unreachable: other checks say so
  }
  if (res.status !== 200) {
    addCheck(checks, 'agent-identity', 'info', 'No ERC-8004 registration file (/.well-known/agent-registration.json). Optional: it gives your service an on-chain identity agents can verify, in the ERC-8004 Identity Registry on Base and other chains.', {
      group,
      hint: 'Serve {"type": "https://eips.ethereum.org/EIPS/eip-8004#registration-v1", "name": ..., "description": ..., "services": [{"name": "web", "endpoint": "https://your-domain/"}], "x402Support": true, "registrations": []} there, register it in the Identity Registry (0x8004A169FB4a3325136EB29fA0ceB6D2e539a432), then add {"agentId": <id>, "agentRegistry": "eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432"} to registrations.',
    });
    return;
  }
  let doc;
  try {
    doc = JSON.parse(res.text);
  } catch {
    doc = null;
  }
  if (!doc || typeof doc !== 'object' || !String(doc.type || '').includes('eip-8004') || typeof doc.name !== 'string') {
    addCheck(checks, 'agent-identity', 'warn', '/.well-known/agent-registration.json is not an ERC-8004 registration file (it needs "type": "https://eips.ethereum.org/EIPS/eip-8004#registration-v1" and a name).', { group });
    return;
  }
  const regs = Array.isArray(doc.registrations) ? doc.registrations.filter((r) => r && typeof r.agentRegistry === 'string' && r.agentId !== undefined) : [];
  const host = hostOf(origin);
  const verified = [], notes = [];
  for (const r of regs.slice(0, 5)) {
    const m = /^eip155:(\d+):(0x[0-9a-fA-F]{40})$/.exec(r.agentRegistry);
    if (!m) {
      const [ns, ref] = r.agentRegistry.split(':');
      notes.push(`${ns === 'solana' ? 'Solana' : ns} registry${ref ? ` (${r.agentRegistry})` : ''}, agent ${String(r.agentId).slice(0, 12)}…`);
      continue;
    }
    const network = `eip155:${m[1]}`, registry = m[2], net = NETWORKS[network];
    const rpc = evmRpcFor(network, evmRpcUrls);
    if (!ERC8004_IDENTITY.has(registry.toLowerCase()) || !rpc || !/^\d{1,30}$/.test(String(r.agentId))) {
      notes.push(`agent ${r.agentId} in ${r.agentRegistry} (not checked)`);
      continue;
    }
    const id = BigInt(r.agentId).toString(16).padStart(64, '0');
    let uri;
    try {
      uri = decodeAbiString(await solanaRpc(rpc, 'eth_call', [{ to: registry, data: `0xc87b56dd${id}` }, 'latest'])); // tokenURI(uint256)
    } catch (err) {
      if (!/revert|nonexistent|invalid token|ERC721/i.test(String(err?.message))) return; // RPC trouble, not an answer: say nothing
      addCheck(checks, 'agent-identity', 'warn', `The registration file says agent #${r.agentId} in the ERC-8004 Identity Registry on ${net?.name || network}, but that agent id doesn't exist there.`, {
        group,
        hint: 'Register the service first, then put the agentId the registry gave you in registrations.',
      });
      return;
    }
    let pointsHere = false;
    try {
      pointsHere = !!uri && hostOf(new URL(uri).origin) === host;
    } catch {
      pointsHere = false;
    }
    if (pointsHere) verified.push(`agent #${r.agentId} on ${net?.name || network}`);
    else {
      addCheck(checks, 'agent-identity', 'warn', `Agent #${r.agentId} in the ERC-8004 Identity Registry on ${net?.name || network} points to ${uri ? uri.slice(0, 120) : 'nothing'}, not to ${host}. Anyone can claim a registration in their file; only one whose tokenURI points back here proves it.`, {
        group,
        hint: `Set the agent's tokenURI to ${where} (setAgentURI in the Identity Registry), or remove the registration from the file.`,
      });
      return;
    }
  }
  if (verified.length) {
    addCheck(checks, 'agent-identity', 'pass', `ERC-8004 identity verified: ${verified.join(', ')}, and its registration points back to ${host}.${notes.length ? ` Also listed: ${notes.join('; ')}.` : ''}`, { group });
  } else if (notes.length) {
    addCheck(checks, 'agent-identity', 'info', `ERC-8004 registration file found ("${doc.name.slice(0, 60)}"), listed in: ${notes.join('; ')}. Not in the Identity Registry on an EVM chain yet, so agents can't verify it on-chain there.`, {
      group,
      hint: 'Register it in the Identity Registry on Base (0x8004A169FB4a3325136EB29fA0ceB6D2e539a432) with this file as tokenURI, then add the agentId to registrations.',
    });
  } else {
    addCheck(checks, 'agent-identity', 'info', `ERC-8004 registration file found ("${doc.name.slice(0, 60)}"), but it isn't registered anywhere yet (empty registrations).`, {
      group,
      hint: 'Register it in the Identity Registry on Base (0x8004A169FB4a3325136EB29fA0ceB6D2e539a432) with this file as tokenURI, then add the agentId to registrations.',
    });
  }
}

// Under which origin the CDP Bazaar lists this route (same path, same payTo).
// The Bazaar keeps the URL the payer used, so after a domain move a route can
// stay listed only under the old host until someone pays through the new one.
async function checkBazaarListing(targetUrl, challenge, bazaarIndex, checks) {
  const group = 'discovery';
  const payTos = (Array.isArray(challenge.accepts) ? challenge.accepts : []).map((a) => a && a.payTo).filter((p) => typeof p === 'string' && p);
  if (!payTos.length) return;
  let found;
  try {
    found = await bazaarIndex.listings(targetUrl, payTos);
  } catch {
    return;
  }
  if (!found) return; // index not loaded yet: say nothing rather than guess
  const origin = new URL(targetUrl).origin;
  if (found.here) {
    addCheck(checks, 'bazaar-listing', 'pass', 'Listed in the CDP Bazaar under this origin.', { group });
  } else if (found.elsewhere.length) {
    addCheck(checks, 'bazaar-listing', 'warn', `The CDP Bazaar lists this route (same payTo) only under ${found.elsewhere.join(', ')}, not under ${origin}. Agents and indexes that read the Bazaar send buyers there.`, {
      group,
      hint: 'The Bazaar lists a route under the URL the payer used. One settled payment through this URL adds it; keep the old host answering until then.',
    });
  } else {
    addCheck(checks, 'bazaar-listing', 'info', 'Not listed in the CDP Bazaar yet. The CDP facilitator adds a route with a Bazaar declaration after its first settled payment.', { group });
  }
}

// ------------------------------------------------------------------- probe

// Response headers that say what runs the endpoint (see lib/stack.js).
const FINGERPRINT_HEADERS = ['x-powered-by', 'server', 'via', 'x-vercel-id', 'x-render-origin-server', 'cf-ray', 'x-nextjs-cache', 'x-matched-path', 'content-type', 'access-control-allow-headers', 'access-control-expose-headers'];
function fingerprintOf(res) {
  const out = {};
  for (const name of FINGERPRINT_HEADERS) {
    const value = res.headers && typeof res.headers.get === 'function' ? res.headers.get(name) : undefined;
    if (value) out[name] = String(value).slice(0, 200);
  }
  return out;
}

// `method`: only that one. `prefer`: try it first, then the other (a seller's declared method is a hint:
// some listings say GET but only answer 402 on POST, and the other way round).
async function probe402(targetUrl, safeFetch, checks, method, attempts = [], prefer = null) {
  const group = 'challenge';
  const methods = method ? [method] : prefer === 'POST' ? ['POST', 'GET'] : ['GET', 'POST'];
  const seen = [];
  for (const m of methods) {
    try {
      const res = await safeFetch(targetUrl, {
        method: m,
        headers: m === 'GET' ? {} : { 'content-type': 'application/json' },
        body: m === 'GET' ? undefined : '{}',
      });
      seen.push(`${m} ${res.status}`);
      attempts.push({ method: m, status: res.status, headers: fingerprintOf(res) });
      if (res.status === 402) {
        addCheck(checks, 'returns-402', 'pass', `Endpoint returns 402 Payment Required for ${m}.`, { group });
        return { method: m, res };
      }
    } catch (err) {
      if (err.code === 'EBLOCKED') throw err;
      seen.push(`${m} error: ${err.message}`);
      attempts.push({ method: m, status: null, error: err.message, headers: {} });
    }
  }
  addCheck(checks, 'returns-402', 'fail', `Endpoint did not return 402 Payment Required (${seen.join(', ')}). Agents and registries will not recognise it as a paid x402 resource.`, {
    group,
    hint: 'Check the route and method; a 400/404 here often means the example input is invalid.',
  });
  return null;
}

// ------------------------------------------------------------------ runner

async function diagnose(targetUrl, { safeFetch, method, rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_SOLANA_RPC, evmRpcUrls, siteScan = process.env.METAMASK_SCAN === 'on', bazaarIndex, describe, poison } = {}) {
  const url = new URL(targetUrl);
  const checks = [];

  const attempts = [];
  const probe = await probe402(url.href, safeFetch, checks, method, attempts);
  let challenge = null;
  if (probe) {
    challenge = await checkEnvelope(probe, checks);
    if (challenge) {
      checkAccepts(challenge.accepts, checks);
      checkResource(challenge, probe.res.url || url.href, checks);
    }
  }

  // MPP (Stripe + Tempo): the other 402 standard, in WWW-Authenticate: Payment. An endpoint may speak either or both.
  let mpp = null;
  if (probe) {
    mpp = await checkMpp({ res: probe.res, url: probe.res.url || url.href, method: probe.method, safeFetch }, checks);
    if (mpp && !challenge) {
      const i = checks.findIndex((c) => c.id === 'protocol-version' && c.status === 'fail');
      if (i >= 0) {
        checks[i] = { id: 'protocol-version', status: 'info', group: 'challenge', message: "No x402 challenge: this is an MPP endpoint (see MPP below). Agents that only speak x402, like most of the x402 Bazaar, can't pay it.", hint: 'Serve an x402 PAYMENT-REQUIRED challenge next to MPP (mppx and the x402 SDKs can run side by side) to reach x402 agents too.' };
      }
    } else if (mpp?.challenges?.length && challenge) {
      checks.push({ id: 'protocols', status: 'pass', group: 'mpp', message: `Speaks both x402 and MPP (${mpp.challenges.map((c) => c.method).join(', ')}): agents of either kind can pay.` });
    }
  }

  // L402 (Lightning Labs): HTTP 402 paid in bitcoin over Lightning, in WWW-Authenticate: L402 (or LSAT).
  let l402 = null;
  if (probe) {
    l402 = await checkL402({ res: probe.res, url: probe.res.url || url.href, method: probe.method, safeFetch }, checks);
    if (l402 && !challenge) {
      const i = checks.findIndex((c) => c.id === 'protocol-version' && (c.status === 'fail' || mpp));
      if (i >= 0) {
        checks[i] = { id: 'protocol-version', status: 'info', group: 'challenge', message: `No x402 challenge: this is an L402 (Lightning) endpoint${mpp?.challenges?.length ? ' that also speaks MPP' : ''} (see L402 below). Agents that only speak x402 can't pay it.`, hint: 'Serve an x402 PAYMENT-REQUIRED challenge next to L402 to reach x402 agents too (stablecoins on Base or Solana).' };
      }
    } else if (l402?.challenges?.length && challenge) {
      checks.push({ id: 'protocols-l402', status: 'pass', group: 'l402', message: 'Speaks both x402 and L402: x402 agents and Lightning agents can pay.' });
    }
  }

  // No 402 on the URL: it may be an MCP server, which takes payment inside a tool call.
  let mcp = null;
  if (!probe) {
    const found = await checkMcp(url.href, safeFetch, checks, { poison });
    if (found) {
      mcp = found.mcp;
      const i = checks.findIndex((c) => c.id === 'returns-402');
      if (i >= 0) {
        checks[i] = { id: 'returns-402', status: 'info', group: 'challenge', message: 'No 402 on the URL itself: expected for an MCP server, which asks for payment inside each paid tool call (see MCP).' };
      }
      challenge = found.challenge;
      if (challenge) checkAccepts(challenge.accepts, checks);
    }
  }

  const origin = new URL(probe?.res.url || url.href).origin;
  await Promise.all([
    mcp ? null : checkOpenApi(origin, safeFetch, checks),
    mcp ? null : checkWellKnown(origin, safeFetch, checks),
    checkAgentIdentity(origin, safeFetch, checks, { evmRpcUrls }),
    challenge && probe && typeof bazaarIndex?.listings === 'function' ? checkBazaarListing(probe.res.url || url.href, challenge, bazaarIndex, checks) : null,
    challenge && probe ? checkBazaar(challenge, origin, safeFetch, checks) : null,
    challenge ? checkSolana(challenge.accepts, checks, { rpcUrl }) : null,
    challenge ? checkAlgorand(challenge.accepts, checks) : null,
    challenge ? checkXrpl(challenge.accepts, checks) : null,
    challenge ? checkEvmPayTo(challenge.accepts, checks, { evmRpcUrls }) : null,
    challenge ? checkUptoProxy(challenge.accepts, checks, { evmRpcUrls }) : null,
    challenge && probe ? checkPaywall(url.href, probe.method, challenge.accepts, safeFetch, checks) : null,
    challenge && siteScan ? checkSiteScan(url.href, checks, siteScan === true ? {} : siteScan) : null,
  ]);

  // How clear the description is to an agent picking a service (opt-in, TypeSafe Jev; an info line at most).
  if (challenge && describe?.enabled) {
    const v2 = typeof challenge.resource?.description === 'string' && challenge.resource.description.trim();
    const where = v2 ? 'resource.description' : 'accepts[0].description';
    const line = describeCheck(await describe.rate(v2 || challenge.accepts?.[0]?.description), where);
    if (line) checks.push(line);
  }

  // Who can pay, from everything above (an info line; it never changes the verdict).
  const wallets = challenge ? walletCompatibility(challenge.accepts, checks) : [];
  if (challenge) checks.push(summaryCheck(challenge.accepts, wallets));

  const order = ['challenge', 'mpp', 'l402', 'mcp', 'accepts', 'resource', 'settlement', 'wallets', 'discovery', 'browser'];
  checks.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
  const overall = checks.some((c) => c.status === 'fail') ? 'fail' : checks.some((c) => c.status === 'warn') ? 'warn' : 'pass';
  return { url: url.href, method: probe?.method || (mcp ? 'MCP' : null), overall, checks, wallets, challenge, probes: attempts, ...(mcp ? { mcp } : {}), ...(mpp?.challenges?.length ? { mpp: mpp.challenges } : {}), ...(l402?.challenges?.length ? { l402: l402.challenges } : {}) };
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
  checkAlgorand,
  checkXrpl,
  checkEvmPayTo,
  checkUptoProxy,
  checkPaywall,
  checkOpenApi,
  checkWellKnown,
  checkAgentIdentity,
  checkBazaarListing,
  schemaErrors,
  declaredRequest,
};
