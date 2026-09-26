// Fix recipes: for each failed or warning check of a diagnosis, the concrete
// change that fixes it, as code for the detected stack (lib/stack.js), filled
// in with the endpoint's own values (payTo, amount, network, route).
//
// Node snippets use the @x402 TypeScript SDK (v2) route config, which is the
// same object for @x402/express, @x402/next and @x402/hono; lines that only
// apply to Express say so. "generic" snippets describe the raw HTTP response,
// for any language. Each recipe has its own test in test/recipes.test.js.

const { NETWORKS, V1_NAMES, familyOf, isEvmAddress, isSolanaAddress } = require('./networks');
const { detectStack } = require('./stack');

const USDC_DECIMALS = 6;
const EIP712 = {
  'eip155:8453': { name: 'USD Coin', version: '2' },
  'eip155:84532': { name: 'USDC', version: '2' },
  'eip155:137': { name: 'USD Coin', version: '2' },
  'eip155:43114': { name: 'USD Coin', version: '2' },
};

const j = (v) => JSON.stringify(v);
// "10000" -> "$0.01", "1000" -> "$0.001", "2500000" -> "$2.50"
function usd(atomic) {
  const n = Number(atomic) / 10 ** USDC_DECIMALS;
  return Number.isInteger(n * 100) ? `$${n.toFixed(2)}` : `$${n.toFixed(USDC_DECIMALS).replace(/0+$/, '')}`;
}

// "0.01" -> "10000"; null when it is not a plain decimal.
function toAtomic(value) {
  const text = String(value).trim().replace(/^\$/, '');
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const [whole, frac = ''] = text.split('.');
  return String(BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt((frac + '0'.repeat(USDC_DECIMALS)).slice(0, USDC_DECIMALS)));
}

function optionIndex(check) {
  const m = /^accepts\[(\d+)\]/.exec(check.id);
  return m ? Number(m[1]) : check.option ?? null;
}

// The route config an @x402 SDK expects, with this endpoint's own values.
function routeConfig(ctx, { extensions = false, comment } = {}) {
  const options = (ctx.accepts.length ? ctx.accepts : [{ network: 'eip155:8453' }]).map((a) => {
    const network = V1_NAMES[a.network] || a.network || 'eip155:8453';
    const price = a.amount && /^\d+$/.test(String(a.amount)) ? usd(a.amount) : toAtomic(a.amount || a.maxAmountRequired || '') ? usd(toAtomic(a.amount || a.maxAmountRequired)) : '$0.01';
    const payTo = familyOf(network) === 'solana' ? 'process.env.PAY_TO_SOLANA' : 'process.env.PAY_TO';
    return `      { scheme: "exact", price: ${j(price)}, network: ${j(network)}, payTo: ${payTo} },`;
  });
  return [
    comment ? `// ${comment}` : null,
    `app.use(paymentMiddleware({`,
    `  ${j(`${ctx.method} ${ctx.path}`)}: {`,
    `    accepts: [`,
    ...options,
    `    ],`,
    `    description: ${j(ctx.challenge?.resource?.description || 'What the caller gets for the payment')},`,
    `    mimeType: ${j(ctx.challenge?.resource?.mimeType || 'application/json')},`,
    extensions ? `    extensions: discovery, // the declareDiscoveryExtension(...) above` : null,
    `  },`,
    `}, resourceServer));`,
  ].filter((l) => l !== null).join('\n');
}

const node = (label, snippet) => ({ language: 'javascript', stack: 'node', label, snippet });
const express = (label, snippet) => ({ language: 'javascript', stack: 'express', label, snippet });
const raw = (label, snippet, language = 'http') => ({ language, stack: 'generic', label, snippet });
const shell = (label, snippet) => ({ language: 'shell', stack: 'any', label, snippet });

const MIRROR = `// @x402 SDKs put the v2 challenge only in the PAYMENT-REQUIRED header and send
// an empty {} body; some clients read the challenge from the body, so mirror it there.
function mirrorChallengeIntoBody(req, res, next) {
  const json = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode === 402 && !(body && Array.isArray(body.accepts))) {
      const header = res.getHeader("PAYMENT-REQUIRED");
      if (header) {
        try {
          const challenge = JSON.parse(Buffer.from(String(header), "base64").toString("utf8"));
          // the whole challenge: x402 v2 carries resource next to accepts
          body = { ...(body || {}), ...challenge };
        } catch {}
      }
    }
    return json(body);
  };
  next();
}
app.use(mirrorChallengeIntoBody); // before app.use(paymentMiddleware(...))`;

function rawChallenge(ctx) {
  const accepts = ctx.accepts.length ? ctx.accepts : [{ scheme: 'exact', network: 'eip155:8453', amount: '10000', asset: NETWORKS['eip155:8453'].usdc, payTo: '0xYourPayoutAddress', maxTimeoutSeconds: 300, extra: EIP712['eip155:8453'] }];
  const challenge = { x402Version: 2, error: 'Payment required', resource: { url: ctx.url, description: ctx.challenge?.resource?.description || 'What the caller gets', mimeType: 'application/json' }, accepts };
  return `HTTP/1.1 402 Payment Required
PAYMENT-REQUIRED: <base64 of the JSON below>
Content-Type: application/json

${JSON.stringify(challenge, null, 2)}`;
}

// ------------------------------------------------------------------ recipes
// Each: { key, match(check), fix(check, ctx) -> fix | null }.

const RECIPES = [
  {
    key: 'no-402',
    match: (c) => c.id === 'returns-402' && c.status === 'fail',
    fix(_c, ctx) {
      const statuses = ctx.probes.map((p) => p.status);
      const tried = ctx.probes.map((p) => `${p.method} ${p.status ?? p.error}`).join(', ');
      if (statuses.every((s) => s === null)) {
        return { title: 'The endpoint cannot be reached', why: `Every request failed (${tried}). Nothing reaches your payment middleware.`, steps: ['Check that the URL is public and the service is running (a sleeping free instance can take up to a minute to wake).', 'Check DNS and the TLS certificate.'], code: [] };
      }
      if (statuses.some((s) => s >= 200 && s < 300)) {
        return {
          title: 'The route answers 200 without asking for payment',
          why: `A caller without payment got ${tried}. Either the payment middleware does not cover this method and path, it runs after your handler, or something (a free tier, a cache, an auth shortcut) answers first. Agents, x402scan and the CDP Bazaar only see a paid resource when the first answer is a 402.`,
          steps: [
            `Make the route key exactly "${ctx.method} ${ctx.path}" (method and path; path parameters in the form your SDK version documents).`,
            'Register the payment middleware before the route handler.',
            'If you offer free calls, make them opt-in (a header or query flag), so a caller without it gets the 402.',
          ],
          code: [
            ...(ctx.family === 'node' ? [node('Payment middleware before the route', `${routeConfig(ctx)}\n\napp.${ctx.method.toLowerCase()}(${j(ctx.path)}, handler); // after the middleware\n\n// A Vercel/Node function without an app: run the same middleware at the top of the\n// handler and only continue to your logic when it calls next().`)] : []),
            node('Free calls only when asked for', `// Everyone else gets the 402 challenge first. (req.headers works in Express and in Vercel/Node functions.)
const wantsFree = req.headers["x-free-tier"] === "1";
if (wantsFree && (await freeTierAllows(req))) return handler(req, res);
// ...otherwise fall through to the payment middleware`),
            raw('What a caller without payment must get', rawChallenge(ctx)),
          ],
        };
      }
      if (statuses.includes(404)) {
        return { title: 'Nothing answers at this path', why: `${tried}: the path or method is not routed here, so the payment middleware never runs.`, steps: ['Check the exact path (trailing slash, prefix such as /api) and the method.', 'If the path has a parameter, diagnose it with a real value (e.g. /signal/BTC-USDT, not /signal/{pair}).'], code: [] };
      }
      if (statuses.includes(405)) {
        return { title: 'Wrong method', why: `${tried}. Call it with the method the route is registered for, and use that method in the route key.`, steps: [`If the route is POST, diagnose it with method=POST.`], code: [] };
      }
      if (statuses.some((s) => s === 401 || s === 403)) {
        return { title: 'Authentication runs before the paywall', why: `${tried}: an auth check rejects the request before x402 can ask for payment. x402 callers do not have your API key; the payment is the authorisation.`, steps: ['Exempt the paid route from the auth middleware, or register the payment middleware first.'], code: ctx.family === 'node' ? [node('Paywall before auth', `${routeConfig(ctx)}\napp.use(requireApiKey); // after the paywall, or skip it for paid routes`)] : [] };
      }
      if (statuses.some((s) => s >= 500)) {
        return { title: 'The server fails before the paywall', why: `${tried}: a server error happens before the payment middleware answers. Check the logs for this request; common causes are a missing setting at startup or a facilitator that cannot be reached.`, steps: ['Look at the server log for the request.', 'Check that the facilitator URL is reachable from the server.'], code: [] };
      }
      if (statuses.some((s) => s === 400 || s === 422)) {
        return { title: 'Input validation answers before the paywall', why: `${tried}: the probe sends no input, and your validation rejects it before x402 can answer. Indexers probe without input too.`, steps: ['Let a request without any input through to the payment middleware (so it gets the 402), and validate real input before the paywall only when it is present.'], code: [node('Validate only when input is present', `function validate(req, res, next) {
  if (req.query.url === undefined && !Object.keys(req.body || {}).length) return next(); // probe: let x402 answer
  // ...reject invalid input with 400 here, before anyone pays
  next();
}`)] };
      }
      return null;
    },
  },
  {
    key: 'protocol',
    match: (c) => c.id === 'protocol-version' && (c.status === 'fail' || c.status === 'warn'),
    fix(c, ctx) {
      return {
        title: /v1/.test(c.message) ? 'Move to x402 v2' : 'Send a valid x402 v2 challenge',
        why: `${c.message} v2 sends the PaymentRequired object base64-encoded in the PAYMENT-REQUIRED header, with CAIP-2 networks; the Bazaar, x402scan and current clients read that.`,
        steps: ['Use a v2 SDK (the @x402/* packages) or send the header yourself as below.'],
        code: [
          ...(ctx.family === 'node' ? [shell('Install the v2 SDK', 'npm install @x402/express @x402/core @x402/evm   # plus @x402/svm for Solana'), express('Route config', `import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";

const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: "https://facilitator.payai.network" }))
  .register("eip155:8453", new ExactEvmScheme());

${routeConfig(ctx)}`)] : []),
          raw('The v2 402 response', rawChallenge(ctx)),
        ],
      };
    },
  },
  {
    key: 'header-name',
    match: (c) => c.id === 'challenge-header' && c.status === 'warn',
    fix: (c) => ({ title: 'Use the PAYMENT-REQUIRED header', why: `${c.message} v2 clients look for exactly this header name.`, steps: ['Rename the header to PAYMENT-REQUIRED (value unchanged: base64 JSON).', 'Browsers: also expose it, see the CORS line below.'], code: [raw('Headers', 'PAYMENT-REQUIRED: <base64 JSON>\nAccess-Control-Expose-Headers: PAYMENT-REQUIRED, PAYMENT-RESPONSE')] }),
  },
  {
    key: 'body-mirror',
    match: (c) => c.id === 'envelope-body-mirror' && c.status === 'warn',
    fix(c, ctx) {
      return {
        title: /disagree/.test(c.message) ? 'Make the 402 body match the header' : 'Mirror the challenge into the 402 body',
        why: c.message,
        steps: ['Build the body from the same object as the header, so they can never differ.'],
        code: [...(ctx.family === 'node' ? [express('Middleware (Express; same idea for other frameworks)', MIRROR)] : []), raw('402 body', `{ "x402Version": 2, "accepts": ${JSON.stringify(ctx.accepts)} }`, 'json')],
      };
    },
  },
  {
    key: 'accepts',
    match: (c) => c.id === 'accepts-present' && c.status === 'fail',
    fix: (c, ctx) => ({ title: 'List at least one payment option', why: c.message, steps: ['Add an accepts[] entry per network you want to be paid on.'], code: [...(ctx.family === 'node' ? [node('Route config', routeConfig(ctx))] : []), raw('accepts[] entry', rawChallenge(ctx))] }),
  },
  {
    key: 'scheme',
    match: (c) => /^accepts\[\d+\]-scheme$/.test(c.id),
    fix: (c) => ({ title: 'Use the "exact" scheme', why: c.message, steps: ['Set "scheme": "exact" in this option; it is the scheme x402 clients implement.'], code: [raw('Option field', '"scheme": "exact"', 'json')] }),
  },
  {
    key: 'network',
    match: (c) => /^accepts\[\d+\]-network$/.test(c.id) && (c.status === 'warn' || c.status === 'fail'),
    fix(c, ctx) {
      const a = ctx.accepts[optionIndex(c)] || {};
      const caip = V1_NAMES[a.network];
      return {
        title: caip ? `Network "${a.network}" → "${caip}"` : 'Use a CAIP-2 network id',
        why: c.message,
        steps: [caip ? `Replace "${a.network}" with "${caip}".` : 'Use a CAIP-2 id: "eip155:8453" (Base), "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" (Solana), "eip155:137" (Polygon).'],
        code: [raw('Option field', `"network": ${j(caip || 'eip155:8453')}`, 'json')],
      };
    },
  },
  {
    key: 'payto',
    match: (c) => /^accepts\[\d+\]-payto$/.test(c.id) && c.status === 'fail',
    fix(c, ctx) {
      const a = ctx.accepts[optionIndex(c)] || {};
      const solana = familyOf(V1_NAMES[a.network] || a.network) === 'solana';
      const value = typeof a.payTo === 'string' ? a.payTo : '';
      const hints = [];
      if (/^\s|\s$/.test(value)) hints.push('it has spaces around it');
      if (/^["']|["']$/.test(value.trim())) hints.push('it is wrapped in quotes');
      if (!solana && isSolanaAddress(value.trim())) hints.push('it is a Solana address on an EVM network');
      if (solana && isEvmAddress(value.trim())) hints.push('it is an EVM address on a Solana network');
      if (!solana && value && !value.startsWith('0x')) hints.push(`an EVM address is 0x + 40 hex characters (42 in total); this value has ${value.length}`);
      return {
        title: 'Fix the payout address (payTo)',
        why: `${c.message}${hints.length ? ` Likely cause: ${hints.join('; ')}.` : ''} Nobody can pay until it is a valid ${solana ? 'Solana' : 'EVM'} address.`,
        steps: ['Put only the address in your PAY_TO setting: no quotes, no spaces, no ENS name.', 'Validate it at startup, so a typo stops the deploy instead of publishing an unpayable 402.'],
        code: [node('Validate at startup', solana
          ? `const PAY_TO_SOLANA = process.env.PAY_TO_SOLANA?.trim();
if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(PAY_TO_SOLANA || "")) throw new Error("PAY_TO_SOLANA must be a Solana address");`
          : `const PAY_TO = process.env.PAY_TO?.trim();
if (!/^0x[0-9a-fA-F]{40}$/.test(PAY_TO || "")) {
  throw new Error(\`PAY_TO must be 0x + 40 hex characters (got \${PAY_TO?.length ?? 0})\`);
}`)],
      };
    },
  },
  {
    key: 'asset',
    match: (c) => /^accepts\[\d+\]-asset$/.test(c.id) && c.status === 'warn',
    fix(c, ctx) {
      const a = ctx.accepts[optionIndex(c)] || {};
      const net = NETWORKS[V1_NAMES[a.network] || a.network];
      return { title: net ? `Use USDC on ${net.name}` : 'Set the token address', why: c.message, steps: ['With an @x402 SDK, give a dollar price ("$0.01") and it fills in USDC for you.'], code: net ? [raw('Option field', `"asset": ${j(net.usdc)}`, 'json')] : [] };
    },
  },
  {
    key: 'amount',
    match: (c) => /^accepts\[\d+\]-amount$/.test(c.id) && (c.status === 'fail' || c.status === 'warn'),
    fix(c, ctx) {
      const a = ctx.accepts[optionIndex(c)] || {};
      const given = a.amount ?? a.maxAmountRequired;
      const atomic = given !== undefined ? toAtomic(given) : null;
      return {
        title: atomic ? `Amount "${given}" → "${atomic}" (${usd(atomic)})` : 'Give the amount in atomic units',
        why: `${c.message} x402 amounts are integer strings in the token's smallest unit; USDC has 6 decimals, so $0.01 is "10000".`,
        steps: [ctx.family === 'node' ? `Easiest: let the SDK convert it by using price: "${atomic ? usd(atomic) : '$0.01'}" instead of an amount.` : `Set "amount": "${atomic || '10000'}".`],
        code: [
          ...(ctx.family === 'node' ? [node('Route config', `accepts: [{ scheme: "exact", price: ${j(atomic ? usd(atomic) : '$0.01')}, network: ${j(V1_NAMES[a.network] || a.network || 'eip155:8453')}, payTo: process.env.PAY_TO }]`)] : []),
          raw('Option field', `"amount": ${j(atomic || '10000')}`, 'json'),
        ],
      };
    },
  },
  {
    key: 'fee-payer',
    match: (c) => /^accepts\[\d+\]-extra$/.test(c.id) && c.status === 'fail' && /feePayer/.test(c.message),
    fix(c, ctx) {
      const equals = /equals payTo/.test(c.message);
      return {
        title: equals ? 'The fee payer is the facilitator, not your wallet' : 'Add the Solana fee payer (extra.feePayer)',
        why: `${c.message} On Solana the facilitator pays the network fee, so its signer address (not yours) goes in extra.feePayer.`,
        steps: [
          ctx.family === 'node' ? 'Register the Solana scheme on the resource server with a facilitator that supports Solana; the SDK then fills extra.feePayer from the facilitator\'s /supported response. Do not set it by hand.' : 'Read the fee payer from your facilitator\'s /supported response and put it in extra.feePayer.',
        ],
        code: [
          ...(ctx.family === 'node' ? [node('Solana on the resource server', `import { ExactSvmScheme } from "@x402/svm/exact/server";

const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: "https://facilitator.payai.network" }))
  .register("eip155:8453", new ExactEvmScheme())
  .register("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", new ExactSvmScheme());`)] : []),
          shell('Find the fee payer', 'curl -s https://facilitator.payai.network/supported | jq \'.kinds[] | select(.network|startswith("solana")) | .extra.feePayer\''),
          raw('Option field', '"extra": { "feePayer": "<the facilitator signer from /supported>" }', 'json'),
        ],
      };
    },
  },
  {
    key: 'eip712',
    match: (c) => /^accepts\[\d+\]-extra$/.test(c.id) && c.status === 'fail' && /EIP-712|extra\.name/.test(c.message),
    fix(c, ctx) {
      const a = ctx.accepts[optionIndex(c)] || {};
      const domain = EIP712[V1_NAMES[a.network] || a.network] || EIP712['eip155:8453'];
      return { title: 'Add the token\'s EIP-712 domain (extra.name, extra.version)', why: `${c.message} Wallets sign the payment against this domain; without it the signature cannot be built.`, steps: [ctx.family === 'node' ? 'With a dollar price and the ExactEvmScheme, the SDK fills this in for USDC.' : 'Add it to the option.'], code: [raw('Option field', `"extra": ${j(domain)}`, 'json')] };
    },
  },
  {
    key: 'resource-https',
    match: (c) => c.id === 'resource-url' && c.status === 'fail' && /https/.test(c.message),
    fix: (c, ctx) => ({
      title: 'resource.url must be https',
      why: `${c.message} Behind a proxy that ends TLS (Render, Heroku, Fly, Railway) the app sees plain http and builds an http:// URL; browser paywalls then retry the payment at the wrong URL.`,
      steps: [ctx.stack.id === 'express' || ctx.family === 'node' ? 'Tell Express to trust the proxy, so req.protocol is https.' : 'Build resource.url from the public https URL.'],
      code: [express('Express', 'app.set("trust proxy", 1); // before the payment middleware'), raw('Challenge field', `"resource": { "url": ${j(ctx.url.replace(/^http:/, 'https:'))} }`, 'json')],
    }),
  },
  {
    key: 'resource-url',
    match: (c) => c.id === 'resource-url' && (c.status === 'warn' || (c.status === 'fail' && !/https/.test(c.message))),
    fix: (c, ctx) => ({ title: 'Set resource.url to the public URL', why: c.message, steps: ['resource.url should be the exact URL callers use (scheme, host, path).'], code: [raw('Challenge field', `"resource": { "url": ${j(ctx.url)} }`, 'json')] }),
  },
  {
    key: 'resource-metadata',
    match: (c) => c.id === 'resource-metadata' && c.status === 'warn',
    fix: (c, ctx) => ({ title: 'Describe the resource', why: `${c.message} Agents and the Bazaar show these to decide whether to pay.`, steps: ['Add description and mimeType to the route config.'], code: [...(ctx.family === 'node' ? [node('Route config', routeConfig(ctx))] : []), raw('Challenge field', `"resource": { "url": ${j(ctx.url)}, "description": "What the caller gets", "mimeType": "application/json" }`, 'json')] }),
  },
  {
    key: 'description-length',
    match: (c) => /description-length$/.test(c.id) && c.status === 'warn',
    fix: (c) => ({
      title: 'Shorten the description to 500 characters',
      why: c.message,
      steps: ['Keep the description to one or two sentences about what the caller gets (500 characters at most).', 'Move longer explanations to your OpenAPI description or docs; agents can read those before paying.'],
      code: [],
    }),
  },
  {
    key: 'bazaar',
    match: (c) => (c.id === 'bazaar' && (c.status === 'warn' || c.status === 'fail')) || (c.id === 'bazaar-replay' && c.status === 'warn'),
    fix(c, ctx) {
      const query = Object.fromEntries(new URL(ctx.url).searchParams);
      const isGet = ctx.method === 'GET';
      const example = isGet ? (Object.keys(query).length ? query : { example: 'value' }) : { example: 'value' };
      const props = Object.keys(example).map((k) => `      ${k}: { type: "string", description: "…" },`).join('\n');
      return {
        title: c.id === 'bazaar-replay' ? 'Make the Bazaar example a request that works' : c.status === 'fail' ? 'Fix the Bazaar declaration' : 'Declare the route for the x402 Bazaar',
        why: `${c.message} The CDP Bazaar and x402scan index a route from this declaration after its first settled payment; agents read the example and schemas to call it correctly.`,
        steps: ['Declare input (a real, valid example), inputSchema and output (schema + example) with declareDiscoveryExtension.', 'Pass it as extensions in the route config.', 'Make one real payment through the CDP facilitator; the route then appears in the Bazaar.'],
        code: [
          ...(ctx.family === 'node' ? [node('Discovery declaration', `import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

const discovery = declareDiscoveryExtension({
  method: ${j(ctx.method)},${isGet ? '' : '\n  bodyType: "json",'}
  input: ${j(example)},
  inputSchema: {
    properties: {
${props}
    },
    required: ${j(Object.keys(example))},
  },
  output: {
    schema: { type: "object", properties: { /* your response fields */ } },
    example: { /* a real response */ },
  },
});

${routeConfig(ctx, { extensions: true })}`)] : []),
        ],
      };
    },
  },
  {
    key: 'bazaar-output',
    match: (c) => c.id === 'bazaar-output' && c.status === 'warn',
    fix: (c) => ({ title: 'Make the output example match its schema', why: c.message, steps: ['Copy a real response into output.example, and make sure every enum value and type in output.schema allows it.'], code: [] }),
  },
  {
    key: 'solana-account',
    match: (c) => c.id === 'solana-payout-account' && c.status === 'fail',
    fix(c, ctx) {
      const a = ctx.accepts[c.option] || ctx.accepts.find((x) => familyOf(x.network) === 'solana') || {};
      return {
        title: 'Create the USDC account of your Solana payout wallet',
        why: `${c.message} x402 clients do not create it, so every Solana settlement fails until it exists.`,
        steps: ['Send any small amount of USDC (e.g. 0.01) to the payout wallet once, from any wallet or exchange. Or create the account yourself:'],
        code: [shell('Create the token account (Solana CLI)', `spl-token create-account ${a.asset || NETWORKS['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'].usdc} --owner ${a.payTo || '<payTo>'} --fee-payer <your keypair.json>`)],
      };
    },
  },
  {
    key: 'solana-wallets',
    match: (c) => c.id === 'solana-wallets' && c.status === 'warn',
    fix: (c, ctx) => ({
      title: 'Let Phantom users pay on Solana',
      why: c.message,
      steps: ['Settle Solana through a facilitator that accepts the Lighthouse instructions Phantom adds (for example Coinbase CDP, or a self-hosted facilitator in smart-wallet mode). Keep PayAI as the fallback.'],
      code: ctx.family === 'node' ? [node('CDP first, PayAI as fallback', `import { createFacilitatorConfig } from "@coinbase/x402";

const facilitators = [
  new HTTPFacilitatorClient(createFacilitatorConfig(process.env.CDP_API_KEY_ID, process.env.CDP_API_KEY_SECRET)),
  new HTTPFacilitatorClient({ url: "https://facilitator.payai.network" }),
];
const resourceServer = new x402ResourceServer(facilitators); // the first that supports a network handles it`)] : [],
    }),
  },
  {
    key: 'paywall-testnet',
    match: (c) => c.id === 'paywall' && c.status === 'fail',
    fix: (c) => ({ title: 'Put the browser paywall in mainnet mode', why: `${c.message} People would be asked to pay with test money on a mainnet price.`, steps: ['@x402/paywall defaults to testnet; pass testnet: false.'], code: [node('Paywall config', `const paywall = createPaywall()
  .withNetwork(evmPaywall)
  .withNetwork(svmPaywall)
  .withConfig({ appName: "Your service", testnet: false })
  .build();`)] }),
  },
  {
    key: 'openapi',
    match: (c) => c.id === 'openapi-present' && c.status === 'warn',
    fix(c, ctx) {
      const spec = {
        openapi: '3.1.0',
        info: { title: ctx.challenge?.resource?.description ? ctx.challenge.resource.description.slice(0, 60) : 'Your service', version: '1.0.0', 'x-guidance': 'When to call which route, with an example request.' },
        servers: [{ url: ctx.origin }],
        paths: {
          [ctx.path]: {
            [ctx.method.toLowerCase()]: {
              summary: ctx.challenge?.resource?.description || 'What the caller gets',
              'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: ctx.accepts[0]?.amount && /^\d+$/.test(ctx.accepts[0].amount) ? (Number(ctx.accepts[0].amount) / 1e6).toString() : '0.01' }, protocols: ['x402'], networks: ctx.accepts.length ? [...new Set(ctx.accepts.map((a) => V1_NAMES[a.network] || a.network))] : ['eip155:8453'], asset: 'USDC' },
              responses: { 200: { description: 'OK' }, 402: { description: 'Payment Required' } },
            },
          },
        },
      };
      return {
        title: 'Publish /openapi.json',
        why: `${c.message}`,
        steps: ['Serve this spec at /openapi.json on the same origin (fill in parameters and response schemas).'],
        code: [raw('openapi.json', JSON.stringify(spec, null, 2), 'json'), express('Serve it (Express)', 'app.get("/openapi.json", (_req, res) => res.json(require("./openapi.json")));')],
      };
    },
  },
  {
    key: 'openapi-fields',
    match: (c) => (c.id === 'openapi-guidance' || c.id === 'openapi-title') && c.status === 'warn',
    fix: (c) => ({ title: c.id === 'openapi-title' ? 'Add info.title to openapi.json' : 'Add info.x-guidance to openapi.json', why: `${c.message}`, steps: ['Agents read x-guidance to decide whether your service fits their task; one or two sentences with an example call.'], code: [raw('openapi.json', '"info": {\n  "title": "Your service",\n  "x-guidance": "Call GET /path?x=… when you need …; returns {…}."\n}', 'json')] }),
  },
];

// Every failed or warning check, with a fix where a recipe exists.
function buildFixes(report, { stack: override } = {}) {
  const stack = detectStack(report, override);
  const url = new URL(report.url);
  const ctx = {
    report,
    stack,
    family: stack.family,
    url: report.url,
    origin: url.origin,
    path: url.pathname,
    // The method that got the 402, else the one method that was tried (e.g. method=POST), else GET.
    method: report.method || (report.probes || []).find((p) => p.status === 402)?.method || ((report.probes || []).length === 1 ? report.probes[0].method : 'GET'),
    challenge: report.challenge || null,
    accepts: (report.challenge && Array.isArray(report.challenge.accepts) ? report.challenge.accepts : []).filter((a) => a && typeof a === 'object'),
    probes: report.probes || [],
  };

  const fixes = [];
  const unfixed = [];
  const seen = new Set();
  for (const check of report.checks || []) {
    if (check.status !== 'fail' && check.status !== 'warn') continue;
    const recipe = RECIPES.find((r) => r.match(check));
    const fix = recipe ? recipe.fix(check, ctx) : null;
    if (!fix) {
      unfixed.push({ id: check.id, status: check.status, message: check.message, hint: check.hint });
      continue;
    }
    const key = `${recipe.key}:${fix.title}`;
    if (seen.has(key)) {
      fixes.find((f) => f.key === key).checks.push(check.id);
      continue;
    }
    seen.add(key);
    fixes.push({ key, recipe: recipe.key, severity: check.status, checks: [check.id], ...fix });
  }
  fixes.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'fail' ? -1 : 1));

  const code = (f) => f.code.filter((c) => c.stack === 'any' || c.stack === 'generic' || (stack.family === 'node' && (c.stack === 'node' || c.stack === 'express')));
  return {
    url: report.url,
    method: report.method,
    overall: report.overall,
    stack: { id: stack.id, name: stack.name, detected_from: stack.detected_from },
    summary: fixes.length
      ? `${fixes.length} fix${fixes.length === 1 ? '' : 'es'} (${fixes.filter((f) => f.severity === 'fail').length} blocking), for ${stack.name}.`
      : unfixed.length ? 'No recipe for the remaining warnings; see unfixed.' : 'Nothing to fix: every check passes.',
    fixes: fixes.map(({ key, ...f }) => ({ ...f, code: code(f), verify: `Run x402 Doctor again on ${report.url}; ${f.checks.join(', ')} should pass.` })),
    unfixed,
  };
}

module.exports = { buildFixes, RECIPES, toAtomic, usd };
