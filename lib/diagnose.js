// The diagnostic checks. Every check pushes { id, group, status, message, hint }
// where status is pass | warn | fail | info and hint says how to fix it.
//
// Most checks trace back to a real bug: v1/v2 confusion, header-only
// envelopes and decimal amounts (PlainText), plus an http:// resource URL
// behind a TLS proxy, a missing Solana fee payer, a payout wallet without a
// USDC account, a testnet paywall on mainnet and Phantom payments rejected by
// PayAI (Ichimoku Signal).

const { validateDiscoveryExtension } = require('@x402/extensions/bazaar');
const { BUILDER_CODE, BUILDER_CODE_PATTERN, MAX_SERVER_SERVICE_CODES } = require('@x402/extensions/builder-code');
const { recoverMessageAddress } = require('viem');
const { NETWORKS, V1_NAMES, CAIP2_RE, isSolanaAddress, isEvmAddress, burnAddress, isXrplAddress, isXrplCurrency, isAlgorandAddress, isAsaId, isStellarAddress, familyOf, sameAsset, dollarToken, GATEWAY, isGatewayOption } = require('./networks');
const { walletCompatibility, summaryCheck } = require('./wallets');
const { checkMcp } = require('./mcp-check');
const { checkSiteScan } = require('./site-scan');
const { cdpFindings, VALIDATE_URL: CDP_VALIDATE_URL } = require('./cdp-validate');

// Schemes the standard x402 clients know; anything else needs its own client. "batch-settlement" (a core x402 scheme
// since mid-2026: one deposit into an escrow channel, then a signed cumulative voucher per call, claimed in batches)
// is paid by x402 SDK clients with a batch-settlement client, not by browser wallets.
const STANDARD_SCHEMES = new Set(['exact', 'upto', 'batch-settlement']);
const isCustomScheme = (scheme) => scheme !== undefined && !STANDARD_SCHEMES.has(scheme);
// Nevermined's x402 schemes (nevermined.ai/docs/development-guide/nevermined-x402): the offer names a plan (planId,
// extra.agentId) instead of an amount and a payout address; the price is in the plan, and Nevermined's facilitator
// settles it from the buyer's credits. nvm:erc4337: an ERC-4337 smart account with session keys, network eip155:<id>.
// nvm:card-delegation: a card delegation, network the card rail (stripe, braintree or visa).
const NEVERMINED_SCHEMES = {
  'nvm:erc4337': { rail: 'an ERC-4337 smart account with session keys', network: (n) => /^eip155:\d+$/.test(String(n)), expected: 'eip155:<chain id>, e.g. eip155:8453' },
  'nvm:card-delegation': { rail: 'a card delegation', network: (n) => ['stripe', 'braintree', 'visa'].includes(n), expected: 'stripe, braintree or visa' },
};
const isNeverminedScheme = (scheme) => typeof scheme === 'string' && scheme.startsWith('nvm:');
// @x402/evm batch-settlement: the escrow (same address on every chain) and the withdraw delay clients accept.
const X402_BATCH_ESCROW = '0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003';
const BATCH_MIN_WITHDRAW_DELAY = 900;
const BATCH_MAX_WITHDRAW_DELAY = 2592000;

const CHALLENGE_HEADER_NAMES = ['payment-required', 'x-payment-required', 'x402'];
const { checkMpp } = require('./mpp');
const { checkL402 } = require('./l402');
const { checkLightningOption, checkLightning } = require('./lightning');
const { describeCheck } = require('./jev-describe');
const { marketPriceCheck } = require('./jev-price');
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

// Stellar options (@x402/stellar, "exact" with a Soroban token transfer): payTo a G…, C… or M… address, asset the
// token's C… contract, a positive integer amount (USDC has 7 decimals), and extra.areFeesSponsored: true, without
// which the client refuses ("Exact scheme requires areFeesSponsored to be true"). The x402 server copies that flag
// from the facilitator's /supported.
function checkStellarOption(accept, p, checks, group, known) {
  if (!isStellarAddress(accept.payTo)) {
    addCheck(checks, `${p}-payto`, 'fail', `${p}: "payTo" is missing or not a valid Stellar address (G… account, C… contract or M… muxed account, with a valid checksum).`, { group });
  } else {
    addCheck(checks, `${p}-payto`, 'pass', `${p}: payTo ${accept.payTo} is a valid Stellar address.`, { group });
  }
  const usdc = known?.usdc;
  if (!isStellarAddress(accept.asset, 'C')) {
    addCheck(checks, `${p}-asset`, 'fail', `${p}: asset ${JSON.stringify(accept.asset)} is not a Soroban token contract (C…); x402 Stellar clients refuse it ("Invalid Stellar asset address").`, { group, hint: usdc ? `USDC on ${known.name} is the contract ${usdc} (not "USDC" or "USDC:${known.usdcIssuer}").` : 'Use the token\'s Stellar Asset Contract address (C…).' });
  } else if (known && accept.asset !== usdc) {
    const other = Object.values(NETWORKS).find((n) => n.family === 'stellar' && n.usdc === accept.asset);
    addCheck(checks, `${p}-asset`, other ? 'fail' : 'warn', other ? `${p}: asset is USDC on ${other.name}, but the network is ${known.name}.` : `${p}: asset ${accept.asset} is not USDC on ${known.name}; clients may not recognise it.`, { group, hint: `USDC on ${known.name} is ${usdc}.` });
  }
  const amount = accept.amount ?? accept.maxAmountRequired;
  if (amount === undefined || amount === null || !/^\d+$/.test(String(amount)) || BigInt(amount) === 0n) {
    addCheck(checks, `${p}-amount`, 'fail', `${p}: amount ${JSON.stringify(amount)} is not a positive integer in atomic units; x402 Stellar clients refuse it.`, { group, hint: 'USDC on Stellar has 7 decimals: "100000" is $0.01.' });
  } else {
    const usd = known && accept.asset === usdc ? ` ($${(Number(amount) / 1e7).toFixed(7).replace(/0+$/, '').replace(/\.$/, '')} USDC, 7 decimals)` : '';
    addCheck(checks, `${p}-amount`, 'pass', `${p}: amount "${amount}" is in atomic units${usd}.`, { group });
  }
  if (accept.extra?.areFeesSponsored !== true) {
    addCheck(checks, `${p}-extra`, 'fail', `${p}: extra.areFeesSponsored is not true, so x402 Stellar clients refuse to pay ("Exact scheme requires areFeesSponsored to be true").`, { group, hint: 'Settle through a facilitator that sponsors Stellar fees; the x402 server then copies areFeesSponsored: true from its /supported into extra.' });
  }
  checkDescriptionLength(accept.description, `${p}-description-length`, `${p}.description`, checks, group);
}

// Circle Gateway (GATEWAY in lib/networks.js): Circle's client only picks an option with extra.version "1" and an
// extra.verifyingContract, and signs for that contract; Gateway only accepts signatures for its Gateway Wallet.
function checkGatewayOption(accept, p, checks, group, known) {
  const extra = accept.extra || {};
  const wallet = known?.testnet ? GATEWAY.testnetWallet : GATEWAY.wallet;
  if (String(extra.version) !== GATEWAY.version) {
    addCheck(checks, `${p}-extra`, 'fail', `${p}: Circle Gateway option with extra.version ${JSON.stringify(extra.version)}; Circle's Gateway client only pays "${GATEWAY.domain}" version "${GATEWAY.version}", so it skips this option.`, { group, hint: `Set extra.version to "${GATEWAY.version}".` });
  } else if (!isEvmAddress(extra.verifyingContract)) {
    addCheck(checks, `${p}-extra`, 'fail', `${p}: Circle Gateway option without a valid extra.verifyingContract (the Gateway Wallet), so Circle's Gateway client can't build the signature.`, { group, hint: `The Gateway Wallet on ${known?.name || 'this network'} is ${wallet}.` });
  } else if (known && !sameAsset(extra.verifyingContract, wallet)) {
    addCheck(checks, `${p}-extra`, 'warn', `${p}: extra.verifyingContract ${extra.verifyingContract} is not Circle's Gateway Wallet on ${known.name} (${wallet}); Gateway refuses signatures made for another contract.`, { group, hint: `Set extra.verifyingContract to ${wallet}.` });
  } else {
    addCheck(checks, `${p}-extra`, 'pass', `${p}: Circle Gateway, signed for the Gateway Wallet ${extra.verifyingContract}.`, { group });
  }
}

// "batch-settlement" on EVM (@x402/evm/batch-settlement): the buyer deposits once into the x402 escrow (EIP-3009 or
// Permit2) and signs a cumulative voucher per call; the seller's channel manager claims them in batches. Clients refuse
// without extra.receiverAuthorizer (who signs the claims) and take withdrawDelay from the 402 (900 s .. 30 days).
function checkBatchSettlementEvm(accept, p, checks, group, known) {
  const extra = accept.extra || {};
  const ra = extra.receiverAuthorizer;
  if (!ra || !isEvmAddress(ra) || /^0x0{40}$/i.test(ra)) {
    addCheck(checks, `${p}-extra`, 'fail', `${p}: "batch-settlement" needs extra.receiverAuthorizer (a non-zero EVM address that signs the claims); x402 batch-settlement clients refuse to pay without it ("Payment requirements must include a non-zero extra.receiverAuthorizer").`, { group, hint: 'Give the server scheme a receiverAuthorizerSigner, or use a facilitator that advertises receiverAuthorizer in /supported.' });
  } else {
    addCheck(checks, `${p}-extra`, 'pass', `${p}: "batch-settlement" with receiverAuthorizer ${ra}.`, { group });
  }
  const delay = extra.withdrawDelay;
  if (delay === undefined) {
    addCheck(checks, `${p}-batch-delay`, 'warn', `${p}: no extra.withdrawDelay; clients then open the channel with ${BATCH_MIN_WITHDRAW_DELAY} s, which facilitators with a longer minimum (PayAI: 3600 s) refuse.`, { group, hint: 'Let the server scheme write withdrawDelay (the SDK does), e.g. 86400.' });
  } else if (!Number.isInteger(delay) || delay < BATCH_MIN_WITHDRAW_DELAY || delay > BATCH_MAX_WITHDRAW_DELAY) {
    addCheck(checks, `${p}-batch-delay`, 'fail', `${p}: extra.withdrawDelay ${JSON.stringify(delay)} is outside ${BATCH_MIN_WITHDRAW_DELAY}..${BATCH_MAX_WITHDRAW_DELAY} seconds; the escrow refuses such a channel.`, { group });
  }
  // The deposit is an EIP-3009 authorization (needs the token's EIP-712 domain) unless the option says Permit2.
  if (extra.assetTransferMethod !== 'permit2' && (!extra.name || !extra.version)) {
    addCheck(checks, `${p}-batch-deposit`, 'fail', `${p}: extra.name/extra.version (the token's EIP-712 domain) is missing, so the EIP-3009 deposit into the escrow can't be signed.`, { group, hint: 'For USDC on Base: { "name": "USD Coin", "version": "2" }, or set assetTransferMethod "permit2".' });
  }
  const min = extra.minDeposit;
  if (min !== undefined && !/^\d+$/.test(String(min))) {
    addCheck(checks, `${p}-batch-deposit`, 'warn', `${p}: extra.minDeposit ${JSON.stringify(min)} is not an integer in atomic units; clients may deposit too little and be refused.`, { group });
  }
  const isUsdc = known && sameAsset(accept.asset, known.usdc);
  const minUsd = isUsdc && /^\d+$/.test(String(min ?? '')) ? ` of at least $${(Number(min) / 1e6).toFixed(2)}` : '';
  addCheck(checks, `${p}-batch`, 'info', `${p}: "batch-settlement": the buyer deposits once${minUsd} into the x402 escrow, then pays each call (up to ${accept.amount ?? '?'} base units) with a signed voucher; the seller claims in batches, and unspent funds go back after the withdraw delay${Number.isInteger(delay) ? ` (${Math.round(delay / 3600 * 10) / 10} h)` : ''}. Browser wallets can't pay it; x402 agents need a batch-settlement client.`, { group, hint: 'Offer an "exact" option next to it so every x402 client and wallet can pay.' });
}

function checkNeverminedOption(accept, p, checks, group) {
  const scheme = NEVERMINED_SCHEMES[accept.scheme];
  if (!scheme) {
    addCheck(checks, `${p}-scheme`, 'warn', `${p}: "${accept.scheme}" is not a Nevermined scheme the doctor knows (nvm:erc4337, nvm:card-delegation); only clients built for it can pay this option.`, { group });
  } else {
    addCheck(checks, `${p}-scheme`, 'info', `${p}: Nevermined plan (${accept.scheme}): paid through Nevermined's facilitator from the buyer's credits in that plan, with ${scheme.rail}. The price is in the plan, not in this offer. Standard x402 clients and wallets can't pay it; buyers need a Nevermined account and its SDK or CLI.`, { group, hint: 'Offer an "exact" option next to it if you want standard x402 clients to pay too.' });
  }
  const network = accept.network;
  const known = NETWORKS[network];
  if (!network) {
    addCheck(checks, `${p}-network`, 'fail', `${p}: missing "network".`, { group, hint: scheme ? `Nevermined expects the settlement rail: ${scheme.expected}.` : undefined });
  } else if (network === 'sandbox' || network === 'live') {
    addCheck(checks, `${p}-network`, 'fail', `${p}: network "${network}" is an environment, not a settlement rail; Nevermined's facilitator rejects it.`, { group, hint: scheme ? `Use ${scheme.expected}. The environment comes from the API key and base URL.` : undefined });
  } else if (scheme && !scheme.network(network)) {
    addCheck(checks, `${p}-network`, 'warn', `${p}: network "${network}" is not a rail for ${accept.scheme} (${scheme.expected}).`, { group });
  } else {
    addCheck(checks, `${p}-network`, 'pass', `${p}: ${known ? `${known.name} (${network})` : network}.`, { group });
  }
  if (!/^\d+$/.test(String(accept.planId ?? ''))) {
    addCheck(checks, `${p}-plan`, 'fail', `${p}: ${accept.planId === undefined ? 'no "planId"' : `planId ${JSON.stringify(accept.planId).slice(0, 80)} is not a Nevermined plan id (a decimal number)`}: buyers can't tell which plan to buy credits from.`, { group });
  } else if (!accept.extra || !/^\d+$/.test(String(accept.extra.agentId ?? ''))) {
    addCheck(checks, `${p}-plan`, 'warn', `${p}: plan ${String(accept.planId).slice(0, 12)}… without an extra.agentId; Nevermined clients pass the agent id when they ask for an access token.`, { group });
  } else {
    addCheck(checks, `${p}-plan`, 'pass', `${p}: plan ${String(accept.planId).slice(0, 12)}… for agent ${String(accept.extra.agentId).slice(0, 12)}….`, { group });
  }
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

    if (isNeverminedScheme(accept.scheme)) {
      checkNeverminedOption(accept, p, checks, group);
      return;
    }
    if (isCustomScheme(accept.scheme)) {
      addCheck(checks, `${p}-scheme`, 'warn', `${p}: unknown scheme "${accept.scheme}". Standard x402 clients and wallets pay "exact" (some also "upto" or "batch-settlement"), so only clients built for this scheme can pay this option.`, { group, hint: 'Offer an "exact" option next to it if you want standard x402 clients to pay.' });
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
    if (family === 'stellar') {
      checkStellarOption(accept, p, checks, group, known);
      return;
    }
    if (family === 'lightning') {
      checkLightningOption(accept, p, checks, group, known, addCheck);
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
    } else if (burnAddress(accept.payTo)) {
      addCheck(checks, `${p}-payto`, 'fail', `${p}: payTo ${accept.payTo} is ${burnAddress(accept.payTo)}: ${/^0x0{40}$/.test(accept.payTo) ? 'USDC refuses transfers to it, so every payment fails' : 'what is paid there can never be spent'}. It looks like a placeholder, not your payout wallet.`, { group });
    } else {
      addCheck(checks, `${p}-payto`, 'pass', `${p}: payTo ${accept.payTo} is a valid ${kind} address.`, { group });
    }

    // USDC, or on BNB Chain one of its 18-decimal dollar tokens.
    const token = known ? dollarToken(network, accept.asset) : null;
    if (!accept.asset || !addressOk(accept.asset)) {
      addCheck(checks, `${p}-asset`, 'warn', `${p}: "asset" is missing or not a valid ${isSolana ? 'token mint' : 'contract'} address.`, { group });
    } else if (known && !token) {
      const otherNetwork = Object.entries(NETWORKS).find(([, n]) => sameAsset(n.usdc, accept.asset));
      const listed = Object.entries(known.stablecoins || {});
      addCheck(
        checks,
        `${p}-asset`,
        otherNetwork ? 'fail' : 'warn',
        otherNetwork
          ? `${p}: asset is USDC on ${otherNetwork[1].name}, but the network is ${known.name}.`
          : `${p}: asset ${accept.asset} is not ${known.usdc ? 'USDC' : `a dollar stablecoin x402 Doctor knows (${listed.map(([, s]) => s.symbol).join(', ')})`} on ${known.name}; clients may not recognise it.`,
        { group, hint: known.usdc ? `USDC on ${known.name} is ${known.usdc}.` : `On ${known.name}: ${listed.map(([a, s]) => `${s.symbol} ${a}`).join(', ')}.` }
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
    } else if (token && token.decimals > 6 && BigInt(amount) < 10n ** BigInt(token.decimals - 6)) {
      // Below $0.000001 in an 18-decimal token: written as if for 6-decimal USDC.
      addCheck(checks, `${p}-amount`, 'warn', `${p}: amount "${amount}" is $${Number(amount) / 10 ** token.decimals} of ${token.symbol}, which has ${token.decimals} decimals on ${known.name}; it looks written for 6-decimal USDC.`, {
        group,
        hint: `$0.01 of ${token.symbol} on ${known.name} is "${10n ** BigInt(token.decimals - 2)}".`,
      });
    } else {
      const usd = token ? ` ($${(Number(amount) / 10 ** token.decimals).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')} ${token.symbol})` : '';
      addCheck(checks, `${p}-amount`, 'pass', `${p}: amount "${amount}" is in atomic units${usd}.`, { group });
    }

    checkDescriptionLength(accept.description, `${p}-description-length`, `${p}.description`, checks, group);

    // Circle's Gateway client sets the validity itself (at least 7 days), so a Gateway option's long timeout is right.
    const timeout = accept.maxTimeoutSeconds;
    if (timeout !== undefined && !isGatewayOption(accept) && (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600)) {
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
    } else if (family === 'evm' && isGatewayOption(accept)) {
      checkGatewayOption(accept, p, checks, group, known);
    } else if (family === 'evm' && accept.scheme === 'exact') {
      // @x402/evm's client pays "permit2" via Permit2 and anything else via EIP-3009 (its default).
      const method = accept.extra?.assetTransferMethod;
      const symbol = token?.symbol || 'this token';
      if (method !== undefined && method !== 'eip3009' && method !== 'permit2') {
        // "permit2-exact" and "permit2-upto" are the methods of Binance's B402 facilitator on BNB Chain
        // (developers.binance.com/docs/products/onchainpay-x402); its own clients pay them.
        const b402 = method === 'permit2-exact' || method === 'permit2-upto';
        const who = b402 ? `"${method}" is a method of Binance's B402 facilitator, not` : `"${String(method).slice(0, 40)}" is not`;
        const why = token?.eip3009 === false
          ? `they sign EIP-3009 instead, which ${symbol} on ${known.name} doesn't support, so only ${b402 ? 'B402 clients' : 'clients built for this facilitator'} can pay it`
          : `they sign EIP-3009 instead, so ${b402 ? 'B402' : 'the facilitator'} may refuse the payment`;
        addCheck(checks, `${p}-extra`, 'warn', `${p}: assetTransferMethod ${who} one standard x402 clients know ("eip3009" or "permit2"); ${why}.`, { group, hint: b402 ? 'For every x402 client, also offer an option with "permit2" or, for U and USD1, "eip3009".' : 'Use "permit2" (or "eip3009" for a token that supports it).' });
      } else if (method === 'permit2') {
        addCheck(checks, `${p}-extra`, 'pass', `${p}: paid via Permit2.`, { group });
      } else if (token?.eip3009 === false) {
        addCheck(checks, `${p}-extra`, 'fail', `${p}: ${symbol} on ${known.name} has no transferWithAuthorization (EIP-3009), so this EIP-3009 option can't be settled.`, { group, hint: `Set extra.assetTransferMethod to "permit2"${known.stablecoins ? `, or price in ${Object.values(known.stablecoins).filter((s) => s.eip3009).map((s) => s.symbol).join(' or ')}, which support EIP-3009` : ''}.` });
      } else if (!accept.extra?.name || !accept.extra?.version) {
        addCheck(checks, `${p}-extra`, 'fail', `${p}: extra.name/extra.version (the token's EIP-712 domain) is missing; EIP-3009 signatures cannot be built.`, {
          group,
          hint: token?.domain ? `For ${symbol} on ${known.name}: ${JSON.stringify(token.domain)}.` : 'For USDC on Base: { "name": "USD Coin", "version": "2" }.',
        });
      } else if (token?.domain && (accept.extra.name !== token.domain.name || String(accept.extra.version) !== token.domain.version)) {
        addCheck(checks, `${p}-extra`, 'fail', `${p}: EIP-712 domain "${String(accept.extra.name).slice(0, 60)}" v${String(accept.extra.version).slice(0, 10)}, but ${symbol} on ${known.name} signs as "${token.domain.name}" v${token.domain.version}; every signature would be refused.`, { group, hint: `Set extra to ${JSON.stringify(token.domain)}.` });
      } else {
        addCheck(checks, `${p}-extra`, 'pass', `${p}: EIP-712 domain ${accept.extra.name} v${accept.extra.version}.`, { group });
      }
      if (method === 'permit2' || (method !== undefined && method !== 'eip3009' && String(method).startsWith('permit2'))) {
        addCheck(checks, `${p}-permit2`, 'info', `${p}: paid via Permit2: buyers need a one-time Permit2 approval for ${symbol} (an on-chain approve transaction), so wallets that only sign EIP-3009 can't pay this option.`, { group, hint: 'Offer an EIP-3009 option next to it (USDC on Base, or USD1 or U on BNB Chain) so every x402 client can pay.' });
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
    } else if (family === 'evm' && accept.scheme === 'batch-settlement') {
      checkBatchSettlementEvm(accept, p, checks, group, known);
    }
    if (isSolana && accept.scheme === 'batch-settlement') {
      addCheck(checks, `${p}-batch`, 'info', `${p}: "batch-settlement" on Solana: the buyer opens a payment channel once (the SDK deposits on first use) and pays each call with a signed cumulative voucher; the seller claims them in batches. Only x402 clients with a batch-settlement client can pay it.`, { group, hint: 'Offer an "exact" option next to it so every x402 client and wallet can pay.' });
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

  const gatewayAt = accepts.map((a, i) => (isGatewayOption(a) ? i : -1)).filter((i) => i >= 0);
  if (gatewayAt.length) {
    const names = [...new Set(gatewayAt.map((i) => NETWORKS[accepts[i].network]?.name || accepts[i].network))];
    const only = gatewayAt.length === accepts.length;
    addCheck(checks, 'circle-gateway', 'info', `${only ? 'Every option is' : `${gatewayAt.length} of ${accepts.length} options ${gatewayAt.length === 1 ? 'is' : 'are'}`} Circle Gateway (nanopayments), on ${names.join(', ')}: the buyer pays from USDC deposited in Circle's Gateway Wallet beforehand, with Circle's Gateway client (@circle-fin/x402-batching), and Circle settles in batches. Standard x402 clients and browser wallets sign for the USDC contract instead, which Gateway refuses.`, {
      group,
      ...(only ? { hint: 'Offer a standard "exact" option too, listed first, so every x402 client and wallet can pay.' } : {}),
    });
  }

  // x402 clients pay the first option they can sign (@x402/core's default selector), so a Circle Gateway option
  // listed before a standard one on the same network makes them sign for Gateway, which refuses it.
  const firstStandard = new Map();
  accepts.forEach((a, i) => {
    if (a?.scheme === 'exact' && familyOf(a.network) === 'evm' && !isGatewayOption(a) && !firstStandard.has(a.network)) firstStandard.set(a.network, i);
  });
  accepts.forEach((a, i) => {
    const standard = isGatewayOption(a) ? firstStandard.get(a.network) : undefined;
    if (standard === undefined || standard < i) return;
    addCheck(checks, 'accepts-order', 'warn', `accepts[${i}] (Circle Gateway) comes before accepts[${standard}] (standard "exact") on ${NETWORKS[a.network]?.name || a.network}. x402 clients take the first option they can sign, so they sign the Gateway one, which fails without a Gateway balance.`, {
      group,
      option: i,
      hint: "List the standard option first; Circle's Gateway client finds its own option wherever it is.",
    });
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

// A path segment written as a template (:id, {id} or [id]): listings and 402s often name the route with its
// placeholder instead of the concrete value, or the other way round. Such a segment matches any one segment.
const TEMPLATE_SEGMENT = /^(:[A-Za-z_][\w-]*|\{[^/{}]+\}|\[[^/[\]]+\])$/;
function samePath(a, b) {
  const split = (p) => p.split('/').map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  const x = split(a), y = split(b);
  return x.length === y.length && x.every((s, i) => s === y[i] || TEMPLATE_SEGMENT.test(s) || TEMPLATE_SEGMENT.test(y[i]));
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
  let relative = false;
  try {
    declared = new URL(resource.url);
  } catch {
    // A path such as "/api/v1/tasks" (Nevermined's examples do it): judge it against the URL that was called.
    if (/^\/(?!\/)/.test(String(resource.url))) {
      declared = new URL(resource.url, finalUrl);
      relative = true;
    } else {
      addCheck(checks, 'resource-url', 'fail', `resource.url "${resource.url}" is not a URL.`, { group });
      return;
    }
  }
  const requested = new URL(finalUrl);
  if (relative) {
    const same = samePath(declared.pathname, requested.pathname);
    addCheck(checks, 'resource-url', 'warn', same
      ? `resource.url "${resource.url}" is a path, not a full URL; against this endpoint it is ${declared.origin}${declared.pathname}, which matches.`
      : `resource.url "${resource.url}" is a path, not a full URL, and it differs from the requested path ${requested.pathname}.`, {
      group,
      hint: 'x402 v2 clients and the Bazaar expect the full URL; build it from your public origin.',
    });
  } else if (requested.protocol === 'https:' && declared.protocol === 'http:') {
    addCheck(checks, 'resource-url', 'fail', `resource.url is ${resource.url} but the endpoint is served over https.`, {
      group,
      hint: 'Typical behind a TLS-terminating proxy (Render, Heroku, Fly): Express sees http. Set app.set("trust proxy", 1). Browser paywalls retry the payment at this URL and browsers block http from an https page.',
    });
  } else if (declared.host !== requested.host || !samePath(declared.pathname, requested.pathname)) {
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

// Why a routeTemplate can't be turned into a request path, or null when it can: it must be a path ("/...") and every
// :param in it needs a value in info.input.pathParams. Seen in the wild: ":var1", which makes "https://host:var1".
function routeTemplateProblem(bazaar) {
  const t = bazaar?.routeTemplate;
  if (!t) return null;
  if (typeof t !== 'string' || !t.startsWith('/')) return `"${String(t).slice(0, 80)}" is not a path (it must start with "/")`;
  const params = bazaar.info?.input?.pathParams || {};
  const missing = [...t.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]).filter((k) => params[k] === undefined || params[k] === null);
  return missing.length ? `"${t.slice(0, 80)}" has ${missing.map((k) => `:${k}`).join(', ')} without a value in info.input.pathParams` : null;
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

// The request a listing's own example describes (info.input): with a usable routeTemplate declaredRequest() fills
// the path; without one (most listings), or with one that isn't a path, the listed URL with the example's query
// parameters, method and JSON body. Null when the listing declares no input. Shared with the spot-buy (lib/spot-buy.js).
function exampleRequest(url, bazaar) {
  const input = bazaar?.info?.input;
  if (!input || typeof input !== 'object') return null;
  if (bazaar.routeTemplate && !routeTemplateProblem(bazaar)) return declaredRequest(new URL(url).origin, bazaar);
  const u = new URL(url);
  for (const [k, v] of Object.entries(input.queryParams || {})) {
    if (v !== undefined && v !== null) u.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  const method = String(input.method || 'GET').toUpperCase();
  const request = { url: u.href, method };
  if (input.body !== undefined && method !== 'GET') {
    request.headers = { 'content-type': 'application/json' };
    request.body = typeof input.body === 'string' ? input.body : JSON.stringify(input.body);
  }
  return request;
}

async function checkBazaar(challenge, origin, safeFetch, checks, targetUrl = origin) {
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

  // An example without values makes an agent send a bare request. In x402 Doctor's spot-buy, sellers that need
  // parameters and check them only after settling took the payment and answered 400/422 to such requests.
  const input = bazaar.info?.input || {};
  const filled = (v) => v !== undefined && v !== null && (typeof v !== 'object' || Object.keys(v).length > 0);
  const hasValues = [input.queryParams, input.body, input.pathParams].some(filled);
  if (!hasValues) {
    addCheck(checks, 'bazaar-input', 'info', 'The declared example input has no parameters or body. If this route needs input, agents that find it through the Bazaar cannot know what to send: they may pay and get an error back.', {
      group,
      hint: 'Give declareDiscoveryExtension real example values (input for query parameters, or a body), and check the input before you settle the payment, so a bad request is refused before anyone pays.',
    });
  }

  // A route template that isn't a usable path: indexes and agents that build the request from it get a broken URL
  // (and this check used to fail with "Invalid URL"). Then the listed URL stands in for it.
  const templateProblem = routeTemplateProblem(bazaar);
  if (templateProblem) {
    addCheck(checks, 'bazaar-route', 'warn', `The Bazaar routeTemplate ${templateProblem}, so an agent or index that builds the request from it gets an invalid URL.`, {
      group,
      hint: 'Leave routeTemplate out for a fixed route, or give the route path with a value in pathParams for each :param (for example "/signal/:pair" with pathParams { pair: "BTC-USDT" }).',
    });
  }

  // Without a route template an example without values is the plain request the probe already made.
  const request = bazaar.routeTemplate && !templateProblem ? declaredRequest(origin, bazaar) : hasValues ? exampleRequest(targetUrl, bazaar) : null;
  if (!request) return;
  const shown = (() => { const u = new URL(request.url); return `${u.pathname}${u.search}`; })();
  try {
    const replay = await safeFetch(request.url, { method: request.method, headers: request.headers, body: request.body });
    if (replay.status === 402) {
      addCheck(checks, 'bazaar-replay', 'pass', `The declared example request (${request.method} ${shown}) answers 402.`, { group });
    } else {
      addCheck(checks, 'bazaar-replay', 'warn', `The declared example request (${request.method} ${shown}) answers HTTP ${replay.status}, not 402. The Bazaar cannot index a resource whose example does not reach the paywall, and an agent sending it would not get to pay.`, {
        group,
        hint: 'Make the example pathParams/queryParams a request that is valid (e.g. a supported pair).',
      });
    }
  } catch (err) {
    addCheck(checks, 'bazaar-replay', 'warn', `Could not replay the declared example request: ${err.message}`, { group });
  }
}

// The x402-merchant extension names the seller (name, website, logo, categories).
// GoPlausible's catalog shows it on the merchant (one per pay-to address) and
// fills that profile from a settled payment, so without it the routes sit under
// an unnamed merchant. Only worth a line when the endpoint offers Algorand,
// where GoPlausible settles; a malformed one is a warning anywhere.
function checkMerchant(challenge, checks) {
  const group = 'discovery';
  const ext = challenge.extensions?.['x402-merchant'];
  if (!ext) {
    if ((challenge.accepts || []).some((a) => familyOf(a?.network) === 'algorand')) {
      addCheck(checks, 'merchant', 'info', 'No x402-merchant extension: GoPlausible\'s catalog lists these routes under a merchant without a name, website or logo.', {
        group,
        hint: 'Add extensions["x402-merchant"] = { info: { name, website, logo, categories }, schema } next to the Bazaar extension; GoPlausible reads it from a settled payment.',
      });
    }
    return;
  }
  const info = ext.info || {};
  const problems = [];
  if (typeof info.name !== 'string' || !info.name.trim()) problems.push('info.name is missing');
  for (const key of ['website', 'logo']) {
    if (info[key] === undefined) continue;
    let ok = false;
    try { ok = new URL(info[key]).protocol === 'https:'; } catch { /* not a URL */ }
    if (!ok) problems.push(`info.${key} is not an https URL`);
  }
  if (info.categories !== undefined && !(Array.isArray(info.categories) && info.categories.every((c) => typeof c === 'string'))) problems.push('info.categories is not a list of strings');
  if (problems.length) {
    addCheck(checks, 'merchant', 'warn', `x402-merchant extension: ${problems.join('; ')}.`, {
      group,
      hint: 'Shape: { info: { name: "…", website: "https://…", logo: "https://….png", categories: ["…"] }, schema }.',
    });
    return;
  }
  const missing = ['website', 'logo'].filter((k) => !info[k]);
  addCheck(checks, 'merchant', 'pass', `x402-merchant extension names the seller: ${info.name.trim().slice(0, 80)}${missing.length ? ` (no ${missing.join(' or ')})` : ''}.`, { group });
}

// Base Builder Code (ERC-8021, the x402 "builder-code" extension): the 402 declares the seller's app code, the
// buyer's x402 client echoes it with the payment, and the facilitator writes it into the settlement calldata, so Base
// attributes the payment to the seller (Base's Builder Grants and rewards start from that). Only EVM settlements of
// x402 v2 payments carry it. No code on a Base route is an info line; a code the facilitator would drop is a warning.
function checkBuilderCode(challenge, checks) {
  const group = 'discovery';
  const evm = (challenge.accepts || []).filter((a) => familyOf(a?.network) === 'evm');
  const ext = challenge.extensions?.[BUILDER_CODE];
  const shape = 'Shape: extensions["builder-code"] = { info: { a: "bc_…" }, schema }, as declareBuilderCodeExtension("bc_…") from @x402/extensions/builder-code returns it.';
  if (ext === undefined) {
    if (evm.some((a) => a.network === 'eip155:8453' || a.network === 'eip155:84532')) {
      addCheck(checks, 'builder-code', 'info', 'No Base Builder Code: Base cannot attribute payments on this route to your app (its Builder Grants and rewards start from that attribution).', {
        group,
        hint: 'Mint a code at base.dev and declare it on every paid route: extensions["builder-code"] = declareBuilderCodeExtension("bc_…") from @x402/extensions/builder-code.',
      });
    }
    return;
  }
  const info = ext && typeof ext === 'object' ? ext.info : undefined;
  if (!info || typeof info !== 'object' || Array.isArray(info)) {
    const top = ext && typeof ext === 'object' && 'a' in ext;
    addCheck(checks, 'builder-code', 'warn', `Base Builder Code: ${top ? 'the code sits at the top of the extension, not under info, so x402 clients echo nothing' : 'the extension has no info object'}. The facilitator then writes no app code into the settlement, and Base cannot attribute the payment.`, { group, hint: shape });
    return;
  }
  if (!BUILDER_CODE_PATTERN.test(String(info.a ?? ''))) {
    const what = info.a === undefined ? 'info.a (the app code) is missing' : `info.a "${String(info.a).slice(0, 40)}" is not a valid code (a-z, 0-9 and _, at most 32 characters)`;
    addCheck(checks, 'builder-code', 'warn', `Base Builder Code: ${what}. The facilitator then writes no app code into the settlement, and Base cannot attribute the payment.`, { group, hint: shape });
    return;
  }
  const services = info.s === undefined ? [] : [].concat(info.s);
  const invalid = services.filter((c) => typeof c !== 'string' || !BUILDER_CODE_PATTERN.test(c)).length;
  if (invalid || services.length > MAX_SERVER_SERVICE_CODES) {
    const what = invalid
      ? `${invalid} of the service codes in info.s ${invalid === 1 ? 'is' : 'are'} not valid and dropped at settlement`
      : `info.s has ${services.length} service codes, more than the ${MAX_SERVER_SERVICE_CODES} a server may declare, so some may be dropped`;
    addCheck(checks, 'builder-code', 'warn', `Base Builder Code ${info.a}: ${what}. The app code itself still counts.`, { group, hint: `At most ${MAX_SERVER_SERVICE_CODES} service codes, each a-z, 0-9 and _, at most 32 characters.` });
    return;
  }
  if (!evm.length) {
    addCheck(checks, 'builder-code', 'info', `Base Builder Code ${info.a} is declared, but no payment option settles on an EVM chain; only EVM settlements carry it.`, { group });
    return;
  }
  if (challenge.x402Version !== 2) {
    addCheck(checks, 'builder-code', 'warn', `Base Builder Code ${info.a} is declared on an x402 v${challenge.x402Version ?? '?'} challenge: the facilitator only reads the app code from v2 payments, so Base cannot attribute these.`, { group, hint: 'Serve an x402 v2 challenge (the current @x402 SDKs do).' });
    return;
  }
  addCheck(checks, 'builder-code', 'pass', `Base Builder Code ${info.a}: the buyer's x402 client echoes it and the facilitator writes it into the settlement, so Base attributes the payment to your app.`, { group });
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

// --------------------------------------------------- Stellar payout trustline

// A G… account can only receive a classic asset like USDC (and its Stellar Asset Contract) once it has a trustline to
// the issuer: without it every payment fails. One Horizon lookup per Stellar USDC option to a G… address (public, no
// key); a C… contract needs no trustline, and an M… muxed account is checked through its G… account by the wallet.
async function checkStellar(accepts, checks, { fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const group = 'settlement';
  for (const option of (accepts || []).filter((a) => NETWORKS[a?.network]?.family === 'stellar' && isStellarAddress(a.payTo, 'G') && a.asset === NETWORKS[a.network].usdc)) {
    const net = NETWORKS[option.network];
    const index = accepts.indexOf(option);
    try {
      const res = await fetchImpl(`${net.horizon}/accounts/${option.payTo}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 404) {
        addCheck(checks, 'stellar-payout-trustline', 'fail', `payTo ${option.payTo} does not exist on ${net.name} (never funded with XLM), so every payment to it fails.`, { group, option: index, hint: 'Fund the account with XLM (the base reserve), then add a USDC trustline from your wallet.' });
      } else if (res.status === 200) {
        const account = await res.json();
        const line = (account.balances || []).find((b) => b.asset_code === 'USDC' && b.asset_issuer === net.usdcIssuer);
        if (!line) {
          addCheck(checks, 'stellar-payout-trustline', 'fail', `payTo ${option.payTo} has no trustline to USDC (${net.usdcIssuer}) on ${net.name}, so every payment to it fails.`, { group, option: index, hint: 'Add a USDC trustline from the payout wallet (Lobstr, Freighter, xBull: "add asset" USDC by Circle); it needs 0.5 XLM extra reserve.' });
        } else if (line.is_authorized === false) {
          addCheck(checks, 'stellar-payout-trustline', 'fail', `payTo ${option.payTo} has a USDC trustline on ${net.name} that the issuer has not authorised, so payments to it fail.`, { group, option: index });
        } else {
          addCheck(checks, 'stellar-payout-trustline', 'pass', `payTo ${option.payTo} has a USDC trustline on ${net.name}, so it can receive the payment.`, { group, option: index });
        }
      } else {
        addCheck(checks, 'stellar-payout-trustline', 'info', `Could not check the payout trustline (Horizon HTTP ${res.status}).`, { group, option: index });
      }
    } catch (err) {
      addCheck(checks, 'stellar-payout-trustline', 'info', `Could not check the payout trustline (${err.message}).`, { group, option: index });
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
    // A Circle Gateway option is not signed in a browser wallet, so Blockaid never sees it.
    if (!net || net.family !== 'evm' || net.testnet || !isEvmAddress(option.payTo) || isGatewayOption(option)) continue;
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

// The x402 batch-settlement escrow (@x402/evm/batch-settlement, same address on every chain): without its code on the
// option's network, no buyer can open a channel, so the option can't be paid.
async function checkBatchEscrow(accepts, checks, { evmRpcUrls } = {}) {
  const seen = new Set();
  for (const [index, option] of (accepts || []).entries()) {
    const net = NETWORKS[option?.network];
    if (option?.scheme !== 'batch-settlement' || !net || net.family !== 'evm' || seen.has(option.network)) continue;
    seen.add(option.network);
    const rpc = evmRpcFor(option.network, evmRpcUrls);
    if (!rpc) continue;
    let code;
    try { code = await solanaRpc(rpc, 'eth_getCode', [X402_BATCH_ESCROW, 'latest']); } catch { continue; }
    if (typeof code !== 'string') continue;
    if (/^0x0*$/.test(code)) {
      addCheck(checks, 'batch-escrow', 'fail', `The x402 batch-settlement escrow (${X402_BATCH_ESCROW}) is not deployed on ${net.name}, so no buyer can open a channel there.`, { group: 'accepts', option: index, hint: 'Use the "exact" scheme on this network.' });
    } else {
      addCheck(checks, 'batch-escrow', 'pass', `The x402 batch-settlement escrow is deployed on ${net.name}.`, { group: 'accepts', option: index });
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

async function checkOpenApi(origin, safeFetch, checks, { payTos = [] } = {}) {
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
    await checkX402scanReadiness(origin, json, payTos, checks);
  } catch (err) {
    addCheck(checks, 'openapi-present', 'warn', `Could not fetch /openapi.json: ${err.message}`, { group });
  }
}

// What x402scan (and AgentCash, which uses the same discovery) asks of openapi.json beyond the basics: a contact
// e-mail, an ownership proof signed by a payTo address, an input schema on every paid operation, and free
// operations marked as such. Learned registering the fizzl services on 13 Oct 2026; each is an info line or a warn,
// never a fail: the endpoint itself works without them.
async function checkX402scanReadiness(origin, json, payTos, checks) {
  const group = 'discovery';
  if (!json.info?.contact?.email) {
    addCheck(checks, 'openapi-contact', 'info', 'No info.contact.email in openapi.json. x402scan uses it to link the origin to its owner and to reach you.', { group });
  }

  // Ownership proof: an EIP-191 personal_sign of the bare origin ("https://host", no slash) by one of the payTo
  // addresses, under x-agentcash-provenance.ownershipProofs (x-discovery.ownershipProofs is the older place).
  const proofs = json['x-agentcash-provenance']?.ownershipProofs || json['x-discovery']?.ownershipProofs;
  const signHint = `Sign the exact text "${origin}" with personal_sign from a payTo wallet and list the signature under x-agentcash-provenance.ownershipProofs.`;
  if (!Array.isArray(proofs) || proofs.length === 0) {
    if (Array.isArray(json.ownershipProofs) && json.ownershipProofs.length) {
      addCheck(checks, 'openapi-ownership', 'warn', 'ownershipProofs sits at the top level of openapi.json, where x402scan ignores it.', { group, hint: 'Move it under x-agentcash-provenance: { ownershipProofs: [...] }.' });
    } else {
      addCheck(checks, 'openapi-ownership', 'info', 'No ownership proof in openapi.json. With one, x402scan and AgentCash show the origin as "ownership verified".', { group, hint: signHint });
    }
  } else {
    const wanted = new Set(payTos.map((a) => String(a).toLowerCase()));
    const signers = [];
    let slashSigned = false;
    for (const signature of proofs.slice(0, 5)) {
      try {
        const signer = (await recoverMessageAddress({ message: origin, signature })).toLowerCase();
        if (wanted.has(signer)) {
          addCheck(checks, 'openapi-ownership', 'pass', `Ownership proof verified: signed by payTo ${signer}, so x402scan can mark the origin as ownership verified.`, { group });
          return addInputSchemaChecks(json, checks);
        }
        signers.push(signer);
        if (wanted.has((await recoverMessageAddress({ message: `${origin}/`, signature })).toLowerCase())) slashSigned = true;
      } catch {
        signers.push(null);
      }
    }
    if (slashSigned) addCheck(checks, 'openapi-ownership', 'warn', `The ownership proof signs "${origin}/" with a trailing slash; x402scan checks the bare origin and rejects it.`, { group, hint: signHint });
    else if (!wanted.size) addCheck(checks, 'openapi-ownership', 'info', 'openapi.json has an ownership proof, but this endpoint has no EVM payTo to check it against.', { group });
    else if (signers.every((s) => s === null)) addCheck(checks, 'openapi-ownership', 'warn', 'The ownership proof in openapi.json is not a valid signature.', { group, hint: signHint });
    else addCheck(checks, 'openapi-ownership', 'warn', `The ownership proof is signed by ${signers.filter(Boolean)[0]}, which is not a payTo of this endpoint, so x402scan will not verify it.`, { group, hint: signHint });
  }
  addInputSchemaChecks(json, checks);
}

function addInputSchemaChecks(json, checks) {
  const group = 'discovery';
  const paidWithoutInput = [];
  const freeUnmarked = [];
  for (const [path, item] of Object.entries(json.paths || {})) {
    for (const [method, op] of Object.entries(item || {})) {
      if (!op || typeof op !== 'object' || !['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      const route = `${method.toUpperCase()} ${path}`;
      if (op['x-payment-info']) {
        if (!(op.parameters || []).length && !(item.parameters || []).length && !op.requestBody) paidWithoutInput.push(route);
      } else if (!Array.isArray(op.security) || op.security.length) {
        freeUnmarked.push(route);
      }
    }
  }
  const list = (routes) => routes.slice(0, 3).join(', ') + (routes.length > 3 ? ` and ${routes.length - 3} more` : '');
  if (paidWithoutInput.length) {
    addCheck(checks, 'openapi-input-schema', 'info', `Paid operations without parameters or requestBody: ${list(paidWithoutInput)}. x402scan does not register a paid operation without an input schema.`, { group, hint: 'Describe what to send, or leave them out of the listing if they take no input.' });
  }
  if (freeUnmarked.length) {
    addCheck(checks, 'openapi-free-routes', 'info', `Operations with neither x-payment-info nor "security": []: ${list(freeUnmarked)}. x402scan probes them, and reports the free ones as unprotected instead of listing them.`, { group, hint: 'Mark free operations with "security": [] so x402scan lists them as public.' });
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
  // Resources as URL strings, or as objects with a url or resource (the richer
  // {"x402Version": 2, "kind": "resource-server"} form some servers publish).
  const entries = doc && Array.isArray(doc.resources) ? doc.resources : [];
  const urlOf = (r) => (typeof r === 'string' ? r : r && typeof r.url === 'string' ? r.url : r && typeof r.resource === 'string' ? r.resource : null);
  const resources = entries.map(urlOf).filter(Boolean);
  if (!resources.length) {
    addCheck(checks, 'well-known', 'warn', '/.well-known/x402 has no resources list (URLs, or objects with a url), so crawlers cannot read it.', {
      group,
      hint: 'Serve {"version": 1, "resources": ["https://your-domain/your/route"]}.',
    });
    return;
  }
  // The XRPL AI Hub (and other directories) list each resource by its name and description.
  const unnamed = entries.filter((r) => urlOf(r) && !(r && typeof r === 'object' && r.name && r.description)).length;
  if (unnamed) {
    addCheck(checks, 'well-known-names', 'info', `${unnamed} of ${resources.length} resource(s) in /.well-known/x402 have no name and description. Directories such as the XRPL AI Hub list each resource by them, otherwise by a generic label or the long 402 text.`, {
      group,
      hint: 'Serve the resources as {"url": "https://your-domain/route", "name": "Short name", "description": "One line on what it returns"} objects.',
    });
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

// skill.md: Markdown at the root telling an agent how to use the API (what it does, routes, prices, how to pay).
// Coinbase (coinbase.com/skill.md), fizzl and others publish one, so a user can tell an agent "connect to
// <host>/skill.md". /llms.txt is the older, more general form. Optional: info when neither is there. A site that
// answers every path with its homepage (HTML) doesn't count.
async function checkSkillMd(origin, safeFetch, checks) {
  const group = 'discovery';
  const host = hostOf(origin);
  for (const path of ['/skill.md', '/llms.txt']) {
    let res;
    try {
      res = await safeFetch(`${origin}${path}`);
    } catch {
      continue;
    }
    const text = String(res.text || '').trimStart();
    const type = String(res.headers?.get?.('content-type') || '');
    if (res.status !== 200 || !text || /^<(!doctype|html)/i.test(text) || /text\/html/i.test(type)) continue;
    const pays = /x402|\b402\b|payment|USDC|price/i.test(text);
    addCheck(checks, 'agent-instructions', 'pass', path === '/skill.md'
      ? `/skill.md found: a user can tell an agent "connect to ${host}/skill.md" and it learns how to call your API${pays ? ' and pay for it' : ''}.`
      : `/llms.txt found (no /skill.md). Agents can read it; /skill.md is the address agents are now pointed at ("connect to ${host}/skill.md").`, { group });
    return;
  }
  addCheck(checks, 'agent-instructions', 'info', `No /skill.md or /llms.txt. Optional: a short Markdown file at ${host}/skill.md lets a user tell an agent "connect to ${host}/skill.md", and the agent learns your routes, prices and how to pay (Coinbase publishes one at coinbase.com/skill.md).`, {
    group,
    hint: 'Serve Markdown at /skill.md: what the API does, each paid route with its price and an example request, how to pay (x402 networks, MPP), a free route to try first, and where to send feedback.',
  });
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
// Coinbase's agent wallets (Oct 2026). Wallet MCP (wallet-mcp.coinbase.com) pays x402 in USDC on Base with the
// "exact", "upto" or "auth-capture" scheme and finds services through the CDP Bazaar. The Coinbase MCP
// (agents.coinbase.com, paid from a Coinbase account's USDC) fetches x402 v2 only, in USDC on Base, at most 5 USDC a
// payment, and only services in its curated catalog. Info only: whether these agents can pay this endpoint.
const COINBASE_SCHEMES = new Set(['exact', 'upto', 'auth-capture']);
const COINBASE_MCP_CAP_USD = 5;
// `listing` is the bazaar-listing check's status when the Bazaar index was read: pass (listed under this origin),
// warn (only under another host) or info (not listed). Without it the line says how a listing gets made.
function checkCoinbaseAgents(challenge, checks, { listing } = {}) {
  const group = 'wallets';
  const usdc = NETWORKS['eip155:8453'].usdc.toLowerCase();
  const usdcOnBase = (challenge.accepts || []).filter((a) => a && a.network === 'eip155:8453' && String(a.asset || '').toLowerCase() === usdc);
  // They sign for the USDC contract, which Circle Gateway refuses.
  const onBase = usdcOnBase.filter((a) => !isGatewayOption(a));
  if (!onBase.length && usdcOnBase.length) {
    addCheck(checks, 'coinbase-agents', 'info', "This endpoint offers USDC on Base only through Circle Gateway. Coinbase's agent wallets (Wallet MCP, and the Coinbase MCP for Coinbase accounts) sign for the USDC contract, which Gateway refuses, so they can't pay it.", {
      group,
      hint: 'Add a standard "exact" option in USDC on Base (extra { "name": "USD Coin", "version": "2" }), listed before the Gateway one.',
    });
    return;
  }
  if (!onBase.length) {
    addCheck(checks, 'coinbase-agents', 'info', "Coinbase's agent wallets (Wallet MCP, and the Coinbase MCP for Coinbase accounts) pay x402 only in USDC on Base, and this endpoint offers no USDC on Base, so they can't pay it.", {
      group,
      hint: 'Add an accepts option in USDC on Base (network eip155:8453, asset 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) with the "exact" scheme.',
    });
    return;
  }
  const payable = onBase.filter((a) => COINBASE_SCHEMES.has(a.scheme));
  if (!payable.length) {
    addCheck(checks, 'coinbase-agents', 'info', `This endpoint offers USDC on Base only with the "${onBase[0].scheme}" scheme; Coinbase's Wallet MCP pays "exact", "upto" or "auth-capture", so its agents can't pay it.`, {
      group,
      hint: 'Offer an "exact" option in USDC on Base next to it.',
    });
    return;
  }
  const usd = Math.min(...payable.map((a) => Number(a.amount ?? a.maxAmountRequired) / 1e6).filter(Number.isFinite));
  const limits = [];
  if (Number(challenge.x402Version) !== 2) limits.push('the Coinbase MCP fetches x402 v2 only, and this is v1');
  if (usd > COINBASE_MCP_CAP_USD) limits.push(`the Coinbase MCP pays at most $${COINBASE_MCP_CAP_USD} a call, and this asks $${usd}`);
  const found = {
    pass: 'and find it through their CDP Bazaar search, where it is listed',
    warn: 'but their CDP Bazaar search finds it only under another host (see bazaar-listing)',
    info: "but their CDP Bazaar search can't find it yet: it is not listed there (see bazaar-listing)",
  }[listing] || 'and find it through their CDP Bazaar search once it is listed there';
  addCheck(checks, 'coinbase-agents', 'pass', `Coinbase Wallet MCP agents can pay this (USDC on Base, "${payable[0].scheme}") ${found}. ${limits.length ? `But ${limits.join('; ')}.` : 'The Coinbase MCP (paid from Coinbase accounts) fetches only services in its own curated catalog.'}`, { group });
}

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
    checkBazaarLastPayment(found.last_settled, checks, group);
  } else if (found.elsewhere.length) {
    addCheck(checks, 'bazaar-listing', 'warn', `The CDP Bazaar lists this route (same payTo) only under ${found.elsewhere.join(', ')}, not under ${origin}. Agents and indexes that read the Bazaar send buyers there.`, {
      group,
      hint: 'The Bazaar lists a route under the URL the payer used. One settled payment through this URL adds it; keep the old host answering until then.',
    });
  } else {
    addCheck(checks, 'bazaar-listing', 'info', 'Not listed in the CDP Bazaar yet. The CDP facilitator adds a route with a Bazaar declaration after its first settled payment.', { group });
  }
}

// Coinbase's own verdict (CDP's validate API): would the CDP facilitator index this route in the Bazaar? A warning
// when the endpoint offers Base or Solana, where the Bazaar and Coinbase's agents matter; info otherwise. Says
// nothing when CDP doesn't answer.
async function checkCdpValidate(targetUrl, method, challenge, cdpValidate, checks) {
  const group = 'discovery';
  if (!/^https:\/\//i.test(targetUrl) || !['GET', 'POST'].includes(method)) return;
  let result;
  try {
    result = await cdpValidate.validate(targetUrl, method);
  } catch {
    return;
  }
  const { accepted, required, advisory, rejectionReason } = cdpFindings(result);
  const list = (failed) => failed.slice(0, 3).map((c) => String(c.detail).replace(/\.$/, '')).join('; ');
  if (accepted) {
    addCheck(checks, 'cdp-validate', 'pass', `Coinbase's own validator (CDP) accepts this endpoint: the CDP facilitator would index it in the Bazaar after a settled payment.${advisory.length ? ` CDP also suggests: ${list(advisory)}.` : ''}`, { group });
    return;
  }
  const cdpNetwork = (challenge.accepts || []).some((a) => a && (a.network === 'eip155:8453' || a.network === 'base' || familyOf(a.network) === 'solana'));
  const why = required.length ? list(required) : rejectionReason || 'no reason given';
  addCheck(checks, 'cdp-validate', cdpNetwork ? 'warn' : 'info', `Coinbase's own validator (CDP) rejects this endpoint for the Bazaar: ${why}.`, {
    group,
    hint: `The CDP Bazaar, which Coinbase's agents search, lists a route only once this passes and a payment settles through the CDP facilitator. Run Coinbase's check yourself: curl -X POST ${CDP_VALIDATE_URL} -H 'content-type: application/json' -d '${JSON.stringify({ resource: targetUrl, method })}'`,
  });
}

// The Bazaar drops a route after 30 days without a settled payment, and it then
// has to be indexed again by a new payment. Warn from 21 days, so there is time.
const BAZAAR_DROP_DAYS = 30;
const BAZAAR_WARN_DAYS = 21;
function checkBazaarLastPayment(lastSettled, checks, group, now = Date.now()) {
  const last = Date.parse(lastSettled || '');
  if (!last) return; // the Bazaar did not say: nothing to judge
  const days = Math.floor((now - last) / 86400e3);
  if (days < BAZAAR_WARN_DAYS) {
    addCheck(checks, 'bazaar-last-payment', 'pass', `Last settled payment counted by the CDP Bazaar: ${days} day(s) ago.`, { group });
    return;
  }
  const left = BAZAAR_DROP_DAYS - days;
  addCheck(checks, 'bazaar-last-payment', 'warn', `The CDP Bazaar counted the last settled payment for this route ${days} days ago; it drops a route after ${BAZAAR_DROP_DAYS} days without one${left > 0 ? ` (in about ${left} day(s))` : ''}. Agents and directories that read the Bazaar then stop finding it.`, {
    group,
    hint: 'One settled payment through the CDP facilitator keeps it listed: a real buyer, or a call you pay yourself (to your own payout address).',
  });
}

// ------------------------------------------------------------------- probe

// x401's proof request header (PROOF-REQUIRED in Proof's early material, PROOF-REQUEST since spec 0.2.0).
const PROOF_HEADER_NAMES = ['proof-request', 'proof-required'];

// Response headers that say what runs the endpoint (see lib/stack.js).
const FINGERPRINT_HEADERS = ['x-powered-by', 'server', 'via', 'x-vercel-id', 'x-render-origin-server', 'cf-ray', 'x-amz-cf-id', 'x-nextjs-cache', 'x-matched-path', 'content-type', 'access-control-allow-headers', 'access-control-expose-headers'];
// Served through Amazon CloudFront, where an AWS WAF Monetize rule can answer the 402 itself.
const viaCloudFront = (headers = {}) => Boolean(headers['x-amz-cf-id'] || /cloudfront/i.test(headers.via || '') || /cloudfront/i.test(headers.server || ''));
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
// HEAD on a paid GET route. Up to @x402/core 2.28.0 the payment middleware matched HEAD against no route, so the
// request went through unpaid and the framework ran the GET handler for it (Express, Hono and Next do): no body goes
// back, but the handler's work and costs do. Fixed in x402-foundation/x402#3796 (13 Oct 2026). One HEAD request.
async function checkHeadUnpaid(targetUrl, probe, safeFetch, checks) {
  if (probe?.method !== 'GET') return;
  let res;
  try {
    res = await safeFetch(targetUrl, { method: 'HEAD', headers: {} });
  } catch {
    return; // no answer to HEAD: nothing to say
  }
  if (res.status >= 200 && res.status < 300) {
    addCheck(checks, 'head-unpaid', 'warn', `HEAD answers ${res.status} without payment, while GET asks for 402. With the x402 SDKs up to @x402/core 2.28.0 the payment middleware lets HEAD through and your server runs the GET handler for it: no body goes back, but the work behind it (and what it costs you) runs for free.`, {
      group: 'challenge',
      hint: 'Update the @x402 packages once the fix is released (x402-foundation/x402#3796). Until then, key the route without a method ("/api/data" instead of "GET /api/data"), so every method has to pay, or answer HEAD with 405 before the payment middleware.',
    });
  } else {
    addCheck(checks, 'head-unpaid', 'pass', `HEAD gets ${res.status}, not a free answer.`, { group: 'challenge' });
  }
}

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
      const proofName = PROOF_HEADER_NAMES.find((h) => res.headers?.get?.(h));
      attempts.push({ method: m, status: res.status, headers: fingerprintOf(res), ...(proofName ? { proof: { name: proofName, value: res.headers.get(proofName) } } : {}) });
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
  // x401: the endpoint asks who is behind the agent first, and only asks for payment once that proof is satisfied.
  const proof = attempts.find((a) => a.proof);
  if (proof) {
    addCheck(checks, 'returns-402', 'info', `No 402 yet: the endpoint asks for proof of who is behind the agent first (x401, ${proof.method} ${proof.status}). The payment request only comes once an agent presents a credential, so the payment checks below can't run without one.`, { group });
    return null;
  }
  // Behind Cloudflare (cf-ray) or CloudFront, the route may be priced by a Monetization Gateway or AWS WAF Monetize
  // rule, whose usual misses are documented.
  const cloudflare = attempts.some((a) => a.headers && a.headers['cf-ray']);
  const cloudfront = attempts.some((a) => viaCloudFront(a.headers));
  addCheck(checks, 'returns-402', 'fail', `Endpoint did not return 402 Payment Required (${seen.join(', ')}). Agents and registries will not recognise it as a paid x402 resource.`, {
    group,
    hint: 'Check the route and method; a 400/404 here often means the example input is invalid.'
      + (cloudflare ? ' Served through Cloudflare: if a Monetization Gateway rule prices this route, check that its URL matches this path, that the method is selected (a rule charges GET only by default), and that the audience is "Everyone" ("Verified Bots" only charges bots Cloudflare identifies, so other agents get the resource without paying).' : '')
      + (cloudfront ? ' Served through Amazon CloudFront: if an AWS WAF Monetize rule prices this route, check that the web ACL is the one on this CloudFront distribution, with Bot Control (Common or Targeted) and a monetization config, and that the rule matches this request: a rule limited to Bot Control\'s bot label charges only callers WAF labels as bots, so other agents get the resource without paying.' : ''),
  });
  return null;
}

// AWS WAF Monetize in Test currency mode charges on testnets (Base Sepolia, Solana Devnet). A CloudFront-served 402
// that offers only testnets is most likely that mode left on: worth a line, since real agents can't pay it.
function checkCloudFrontTestMode(headers, accepts, checks) {
  const nets = (Array.isArray(accepts) ? accepts : []).map((a) => NETWORKS[a?.network]).filter(Boolean);
  if (!viaCloudFront(headers) || !nets.length || !nets.every((n) => n.testnet)) return;
  addCheck(checks, 'aws-test-mode', 'info', `Served through Amazon CloudFront and offering only testnets (${nets.map((n) => n.name).join(', ')}): if AWS WAF Monetize prices this route, its currency mode is Test, so agents paying with real USDC can't use it.`, {
    group: 'accepts',
    hint: 'In the web ACL\'s monetization settings, switch Currency mode from Test to Real once your Test-mode payments work.',
  });
}

// x401 (Proof's HTTP Proof Requirement Protocol, https://x401.id): a Verifier asks for proof of who is behind the
// agent (identity, age, membership, signing authority) in a PROOF-REQUEST header, one base64url JSON object, and only
// asks for payment (402) once that proof is satisfied. Doctor holds no credential, so it checks the request itself.
function checkX401({ proof }, checks) {
  const group = 'challenge';
  const shape = 'PROOF-REQUEST: one unpadded base64url JSON object { scheme: "x401", version, credential_requirements: { digital: { requests: [{ protocol: "openid4vp-v1-signed", data }] } } }, as the x401 SDK builds it.';
  if (proof.value.includes(',')) {
    addCheck(checks, 'x401', 'warn', 'x401: the PROOF-REQUEST header has more than one value (or a comma in it), which agents must treat as invalid.', { group, hint: shape });
    return;
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(proof.value.trim(), 'base64url').toString('utf8'));
  } catch {
    addCheck(checks, 'x401', 'warn', 'x401: the PROOF-REQUEST header is not base64url-encoded JSON, so agents cannot read what proof is asked.', { group, hint: shape });
    return;
  }
  const requests = payload?.credential_requirements?.digital?.requests;
  const problems = [];
  if (payload?.scheme !== 'x401') problems.push(`scheme is ${payload?.scheme === undefined ? 'missing' : `"${String(payload.scheme).slice(0, 20)}"`}, not "x401"`);
  if (!payload?.version) problems.push('version is missing');
  if (!Array.isArray(requests) || !requests.length) problems.push('credential_requirements.digital.requests is missing or empty');
  else if (requests.some((r) => !r?.protocol || r.data === undefined)) problems.push('a credential request lacks its protocol or data');
  if (problems.length) {
    addCheck(checks, 'x401', 'warn', `x401 proof request: ${problems.join('; ')}.`, { group, hint: shape });
    return;
  }
  const protocols = [...new Set(requests.map((r) => r.protocol))].join(', ');
  let tokens = '';
  try { if (payload.oauth?.token_endpoint) tokens = `, token exchange at ${new URL(payload.oauth.token_endpoint).host}`; } catch { /* not a URL */ }
  const pay = payload.payment?.scheme_hint ? `; payment afterwards via ${String(payload.payment.scheme_hint).slice(0, 20)}` : '';
  const legacy = proof.name === 'proof-required' ? ' Sent as PROOF-REQUIRED, the name in Proof\'s early material; the spec (0.2.0) calls it PROOF-REQUEST.' : '';
  addCheck(checks, 'x401', legacy ? 'info' : 'pass', `Asks for proof before payment (x401 ${String(payload.version).slice(0, 12)}: ${protocols}${tokens}${pay}).${legacy}`, { group });
}

// ------------------------------------------------------------------ runner

// The lowest price in USDC across the mainnet options, in dollars, or null when none is in a known USDC.
function lowestUsdcPrice(accepts) {
  let low = null;
  for (const a of Array.isArray(accepts) ? accepts : []) {
    const net = NETWORKS[a?.network] || NETWORKS[V1_NAMES[a?.network]];
    const amount = String(a?.amount ?? a?.maxAmountRequired ?? '');
    if (!net || net.testnet || !sameAsset(a?.asset, net.usdc) || !/^\d+$/.test(amount)) continue;
    const usd = Number(amount) / 1e6;
    if (usd > 0 && (low === null || usd < low)) low = usd;
  }
  return low;
}

async function diagnose(targetUrl, { safeFetch, method, rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_SOLANA_RPC, evmRpcUrls, siteScan = process.env.METAMASK_SCAN === 'on', bazaarIndex, cdpValidate, describe, poison, price } = {}) {
  const url = new URL(targetUrl);
  const checks = [];

  const attempts = [];
  const probe = await probe402(url.href, safeFetch, checks, method, attempts);
  const proofAttempt = probe ? null : attempts.find((a) => a.proof);
  if (proofAttempt) checkX401(proofAttempt, checks);
  let challenge = null;
  if (probe) {
    challenge = await checkEnvelope(probe, checks);
    if (challenge) {
      checkAccepts(challenge.accepts, checks);
      checkResource(challenge, probe.res.url || url.href, checks);
      checkCloudFrontTestMode(fingerprintOf(probe.res), challenge.accepts, checks);
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
    mcp ? null : checkOpenApi(origin, safeFetch, checks, { payTos: (challenge?.accepts || []).filter((a) => isEvmAddress(a?.payTo)).map((a) => a.payTo) }),
    mcp ? null : checkWellKnown(origin, safeFetch, checks),
    checkAgentIdentity(origin, safeFetch, checks, { evmRpcUrls }),
    checkSkillMd(origin, safeFetch, checks),
    challenge && probe && typeof bazaarIndex?.listings === 'function' ? checkBazaarListing(probe.res.url || url.href, challenge, bazaarIndex, checks) : null,
    challenge && probe && typeof cdpValidate?.validate === 'function' ? checkCdpValidate(probe.res.url || url.href, probe.method, challenge, cdpValidate, checks) : null,
    challenge && probe ? checkBazaar(challenge, origin, safeFetch, checks, probe.res.url || url.href) : null,
    challenge ? checkMerchant(challenge, checks) : null,
    challenge ? checkBuilderCode(challenge, checks) : null,
    probe ? checkHeadUnpaid(probe.res.url || url.href, probe, safeFetch, checks) : null,
    challenge ? checkSolana(challenge.accepts, checks, { rpcUrl }) : null,
    challenge ? checkAlgorand(challenge.accepts, checks) : null,
    challenge ? checkStellar(challenge.accepts, checks) : null,
    challenge ? checkXrpl(challenge.accepts, checks) : null,
    challenge ? checkLightning(challenge.accepts, checks, { networks: NETWORKS, addCheck, request: probe ? { method: probe.method, url: probe.res.url || url.href, body: probe.method === 'GET' ? '' : '{}', headers: probe.method === 'GET' ? {} : { 'content-type': 'application/json' } } : null }) : null,
    challenge ? checkEvmPayTo(challenge.accepts, checks, { evmRpcUrls }) : null,
    challenge ? checkUptoProxy(challenge.accepts, checks, { evmRpcUrls }) : null,
    challenge ? checkBatchEscrow(challenge.accepts, checks, { evmRpcUrls }) : null,
    challenge && probe ? checkPaywall(url.href, probe.method, challenge.accepts, safeFetch, checks) : null,
    challenge && siteScan ? checkSiteScan(url.href, checks, siteScan === true ? {} : siteScan) : null,
  ]);
  // After the Bazaar listing check, so it can say whether Coinbase's agents find this route there.
  if (challenge) checkCoinbaseAgents(challenge, checks, { listing: checks.find((c) => c.id === 'bazaar-listing')?.status });

  // How clear the description is to an agent picking a service, and how its price compares with comparable paid
  // APIs in the Trust Index (both opt-in, TypeSafe Jev; an info line at most, asked at the same time).
  if (challenge && (describe?.enabled || price?.enabled)) {
    const v2 = typeof challenge.resource?.description === 'string' && challenge.resource.description.trim();
    const where = v2 ? 'resource.description' : 'accepts[0].description';
    const text = v2 || challenge.accepts?.[0]?.description;
    const priceUsd = lowestUsdcPrice(challenge.accepts);
    const [rating, cmp] = await Promise.all([
      describe?.enabled ? describe.rate(text) : null,
      price?.enabled && priceUsd !== null ? price.compare(probe?.res?.url || url.href, { description: text, priceUsd }).catch(() => null) : null,
    ]);
    const line = describeCheck(rating, where);
    if (line) checks.push(line);
    const market = marketPriceCheck(cmp);
    if (market) checks.push(market);
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
  isNeverminedScheme,
  probe402,
  decodeChallengeValue,
  checkEnvelope,
  checkAccepts,
  addCheck,
  checkLightning,
  checkResource,
  checkBazaar,
  checkMerchant,
  checkBuilderCode,
  checkHeadUnpaid,
  checkCloudFrontTestMode,
  checkX401,
  checkSolana,
  checkAlgorand,
  checkStellar,
  checkStellarOption,
  checkXrpl,
  checkEvmPayTo,
  checkUptoProxy,
  checkBatchEscrow,
  checkPaywall,
  checkOpenApi,
  checkWellKnown,
  checkAgentIdentity,
  checkSkillMd,
  checkCoinbaseAgents,
  checkBazaarListing,
  checkCdpValidate,
  schemaErrors,
  declaredRequest,
  exampleRequest,
  routeTemplateProblem,
  checkBazaar,
};
