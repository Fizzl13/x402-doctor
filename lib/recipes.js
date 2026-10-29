// Fix recipes: for each failed or warning check of a diagnosis, the concrete
// change that fixes it, as code for the detected stack (lib/stack.js), filled
// in with the endpoint's own values (payTo, amount, network, route).
//
// Node snippets use the @x402 TypeScript SDK (v2) route config, which is the
// same object for @x402/express, @x402/next and @x402/hono; lines that only
// apply to Express say so. "generic" snippets describe the raw HTTP response,
// for any language. Each recipe has its own test in test/recipes.test.js.

const { NETWORKS, V1_NAMES, familyOf, isEvmAddress, isSolanaAddress, dollarToken, burnAddress } = require('./networks');
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
    // POST answered 400/422 to an empty body, and no example body reached the 402 (a warning, not a broken paywall).
    key: 'needs-input',
    match: (c) => c.id === 'returns-402' && c.status === 'warn' && c.needs_input,
    fix(_c, ctx) {
      const tried = ctx.probes.map((p) => `${p.method}${p.example ? ' with the example body' : ''} ${p.status ?? p.error}`).join(', ');
      const spec = { paths: { [ctx.path]: { post: { requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['input'], properties: { input: { type: 'string' } } }, example: { input: 'a real example' } } } } } } } };
      return {
        title: 'Input validation answers before the 402',
        why: `${tried}: a request without valid input is rejected before x402 can answer. That keeps anyone from paying for a bad request, but agents, indexers and checkers that probe with an empty body never see the price.`,
        steps: [
          'Publish an example request body in /openapi.json (requestBody, content application/json, example). x402 Doctor sends it once, unpaid, to reach the 402, and agents read it too.',
          'Or let a request without any input through to the payment middleware, so it gets the 402, and reject invalid input before the paywall only when input is present.',
        ],
        code: [
          raw('openapi.json: an example body for this route', JSON.stringify(spec, null, 2), 'json'),
          node('Validate only when input is present', `function validate(req, res, next) {
  if (!Object.keys(req.body || {}).length) return next(); // no input: let x402 answer with the 402
  // ...reject invalid input with 400 here, before anyone pays
  next();
}`),
        ],
      };
    },
  },
  {
    // A POST route whose unpaid GET answers 404 or 410: directories that probe with GET list it as gone. The same
    // change as presign-guard's src/post-only.js (29 Oct 2026).
    key: 'get-probe',
    match: (c) => c.id === 'get-probe' && c.status === 'warn',
    fix(c, ctx) {
      const status = c.get_status ?? 404;
      return {
        title: 'Answer an unpaid GET with the same 402 as POST',
        why: `An unpaid GET on ${ctx.path} answers ${status}, while POST gets the 402. Directories that list x402 routes by probing each one with an unpaid GET (such as the Agent Exchange x402 census) mark this route as gone, although it sells fine.`,
        steps: [
          `Before the payment middleware, answer GET and HEAD on ${ctx.path} with the 402 an unpaid POST gets, plus the header Allow: POST.`,
          'Refuse a GET that carries a payment (PAYMENT-SIGNATURE, X-PAYMENT or Authorization: Payment) with 405 and Allow: POST: the paid answer needs the POST body, and a payment on a GET would buy nothing.',
          'Leave POST and your other routes as they are.',
        ],
        code: [
          express("GET and HEAD get the POST's 402", `// paywall: the paymentMiddleware(...) you already use for POST ${ctx.path}.
const paywall = paymentMiddleware(routes, resourceServer);
const POST_ONLY = new Set([${j(ctx.path)}]);

app.use((req, res, next) => {
  if ((req.method !== "GET" && req.method !== "HEAD") || !POST_ONLY.has(req.path)) return next();
  res.set("Allow", "POST");
  const refuse = () => res.status(405).json({ error: "method_not_allowed", message: \`\${req.path} takes POST with a JSON body\` });
  const paying = req.headers["payment-signature"] || req.headers["x-payment"] || /(^|,)\\s*Payment\\s/i.test(req.headers.authorization || "");
  if (paying) return refuse(); // never take a payment on a GET
  // The paywall sees the POST this GET stands for and answers its 402 (Node sends no body for HEAD).
  paywall(Object.create(req, { method: { value: "POST" } }), res, refuse);
});
app.use(paywall);`),
          raw('What an unpaid GET or HEAD should get', rawChallenge(ctx).replace('HTTP/1.1 402 Payment Required\n', 'HTTP/1.1 402 Payment Required\nAllow: POST\n')),
          raw('What a GET that carries a payment should get', `HTTP/1.1 405 Method Not Allowed
Allow: POST
Content-Type: application/json

{"error":"method_not_allowed","message":"${ctx.path} takes POST with a JSON body"}`),
        ],
      };
    },
  },
  {
    // MPP: a malformed or made-up Payment credential must get 402 with a fresh challenge: not 400, not a crash, and
    // never the resource (13 of 200 sellers in a sample of the Trust Index on 29 Oct 2026 answered 400).
    key: 'mpp-bad-credential',
    match: (c) => c.id === 'mpp-bad-credential' && (c.status === 'warn' || c.status === 'fail'),
    fix(c, ctx) {
      const served = /got HTTP 2\d\d/.test(c.message);
      const crash = /crashes/.test(c.message);
      return {
        title: served ? 'A made-up MPP credential gets the resource: verify before serving' : crash ? 'A malformed MPP credential crashes the endpoint' : 'Answer a rejected MPP credential with 402 and a fresh challenge',
        why: `${c.message} ${served ? 'Anyone can send "Authorization: Payment <anything>" and get the paid answer for free.' : 'An MPP client that sent a bad or expired credential retries only when it gets a 402 with a new WWW-Authenticate: Payment challenge; a 400 or 500 ends the purchase.'}`,
        steps: [
          'Read and verify the credential before your handler runs; serve the resource only after the payment is verified.',
          'When the credential can\'t be read, doesn\'t match a challenge you issued, has expired or doesn\'t verify: answer 402 with a fresh WWW-Authenticate: Payment challenge (and Cache-Control: no-store), never 400 or 500.',
          'Catch every error in that path, so a malformed header can\'t crash the request.',
        ],
        code: [
          express('Refuse with a fresh 402, never 400/500 or the resource', `// verifyCredential(auth, req): your MPP SDK's verify call; it throws or returns false when the credential is bad.
// challengeFor(req): the WWW-Authenticate: Payment value your unpaid 402 already sends for this route.
app.use(${j(ctx.path)}, async (req, res, next) => {
  const auth = req.headers.authorization || "";
  if (!/(^|,)\\s*Payment\\s/i.test(auth)) return next(); // no credential: your normal 402
  let ok = false;
  try { ok = Boolean(await verifyCredential(auth, req)); } catch { ok = false; }
  if (ok) return next(); // verified: serve (and settle after a 2xx answer)
  res.status(402).set("WWW-Authenticate", challengeFor(req)).set("Cache-Control", "no-store")
    .type("application/problem+json")
    .send(JSON.stringify({ type: "https://paymentauth.org/problems/verification-failed", title: "Payment failed", status: 402, detail: "The Payment credential was not accepted. Pay the fresh challenge." }));
});`),
          raw('What a rejected credential should get', `HTTP/1.1 402 Payment Required
WWW-Authenticate: Payment id="<new id>", realm="${new URL(ctx.url).host}", method="…", intent="charge", request="…", expires="…"
Cache-Control: no-store
Content-Type: application/problem+json

{"type":"https://paymentauth.org/problems/verification-failed","title":"Payment failed","status":402,"detail":"…"}`),
        ],
      };
    },
  },
  {
    key: 'mpp-realm',
    match: (c) => c.id === 'mpp-realm' && (c.status === 'warn' || c.status === 'fail'),
    fix(c, ctx) {
      const host = new URL(ctx.url).host;
      return {
        title: `Set the MPP realm to ${host}`,
        why: `${c.message} The realm tells the client which site asks for the payment; a client may refuse a challenge whose realm is another domain, or none.`,
        steps: [`Set the realm of your MPP challenges to "${host}" (or its base domain), in your MPP server's options or where you build the WWW-Authenticate header.`],
        code: [raw('The challenge header', `WWW-Authenticate: Payment id="…", realm="${host}", method="…", intent="charge", request="…", expires="…"`)],
      };
    },
  },
  {
    key: 'mpp-stripe',
    match: (c) => c.id === 'mpp-stripe' && c.status === 'fail',
    fix(c) {
      return {
        title: 'Complete the Stripe method details',
        why: `${c.message} An MPP client paying by card needs your Stripe profile id and the payment method types in the challenge's request.`,
        steps: ['Put methodDetails.networkId (your Stripe profile id, from the Stripe dashboard) and methodDetails.paymentMethodTypes (for example ["card"]) in the request of the stripe challenge.'],
        code: [raw('The request of the stripe challenge (base64url-encoded in request=…)', JSON.stringify({ amount: '100', currency: 'usd', methodDetails: { networkId: 'profile_…', paymentMethodTypes: ['card'] } }, null, 2), 'json')],
      };
    },
  },
  {
    // ERC-8004: the registration file must be one, its agent must exist, and the registry must point back here.
    key: 'agent-identity',
    match: (c) => c.id === 'agent-identity' && c.status === 'warn',
    fix(c, ctx) {
      const host = new URL(ctx.url).host;
      const fileUrl = `${ctx.origin}/.well-known/agent-registration.json`;
      const agentId = (c.message.match(/agent #(\d+)/i) || [])[1];
      const file = { type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1', name: 'Your service name', description: 'What it does, in one or two sentences.', image: `${ctx.origin}/icon.png`, services: [{ name: 'web', endpoint: `${ctx.origin}/` }], active: true, x402Support: true, registrations: [{ agentId: Number(agentId) || 0, agentRegistry: 'eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' }], supportedTrust: [] };
      if (/isn't an ERC-8004 registration file|is not an ERC-8004 registration file/.test(c.message)) {
        return {
          title: 'Make /.well-known/agent-registration.json an ERC-8004 registration file',
          why: `${c.message} Agents and registries only read the file when it has the ERC-8004 type and a name.`,
          steps: [`Serve this JSON at ${fileUrl} (Content-Type application/json), with your own name, description and services.`, 'Register the agent in the ERC-8004 Identity Registry (Base: 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432) with this URL as its URI, then put the agent id in registrations.'],
          code: [raw('agent-registration.json', JSON.stringify(file, null, 2), 'json')],
        };
      }
      if (/doesn't exist there/.test(c.message)) {
        return {
          title: 'The agent id in the registration file is not registered',
          why: `${c.message} An agent checking you looks the id up in the registry and finds nothing.`,
          steps: ['Register the agent in the ERC-8004 Identity Registry with your registration file URL, then put the id it gets in registrations.', 'Or remove that entry from registrations.'],
          code: [shell('Register (Foundry cast; Base)', `cast send 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 "register(string)" ${j(fileUrl)} --rpc-url https://mainnet.base.org --private-key $OWNER_KEY`)],
        };
      }
      if (/not to /.test(c.message)) {
        return {
          title: `Point agent #${agentId || '<id>'} back to ${host}`,
          why: `${c.message}`,
          steps: [`From the wallet that owns agent #${agentId || '<id>'}, set its URI to ${fileUrl}.`],
          code: [shell('Set the agent URI (Foundry cast; Base)', `cast send 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 "setAgentURI(uint256,string)" ${agentId || '<agentId>'} ${j(fileUrl)} --rpc-url https://mainnet.base.org --private-key $OWNER_KEY`)],
        };
      }
      return null;
    },
  },
  {
    key: 'payto-stable',
    match: (c) => c.id === 'payto-stable' && c.status === 'warn',
    fix(c) {
      return {
        title: 'Use one fixed payout address per network',
        why: `${c.message}`,
        steps: ['Read payTo from one fixed setting per network (an environment variable), not from a per-request generator.', 'If you must hand out a new address per request, keep accepting and settling payments to the earlier ones until they expire, and never answer a paid request with a fresh 402.'],
        code: [node('One payTo per network', `const PAY_TO = { "eip155:8453": process.env.PAY_TO, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": process.env.PAY_TO_SOLANA };
// in the route config: payTo: PAY_TO[network]  (never a fresh address per request)`)],
      };
    },
  },
  {
    // MPP: a challenge that can't be read or misses what a client needs (id, method/intent, a future expires, the
    // chain, a real recipient, the amount or currency). One complete example covers them.
    key: 'mpp-challenge',
    match: (c) => /^mpp-(challenge|id|method|expires|chain|recipient|amount|currency)$/.test(c.id) && (c.status === 'fail' || c.status === 'warn'),
    fix(c, ctx) {
      const host = new URL(ctx.url).host;
      const request = { amount: '10000', currency: NETWORKS['eip155:8453'].usdc, recipient: '0xYourPayoutAddress', methodDetails: { chainId: 8453 } };
      return {
        title: 'Send a complete MPP challenge',
        why: `${c.message} An MPP client builds its payment from the challenge: it needs a unique id to send back, method and intent, an expiry a few minutes ahead, and a request with the amount in the smallest unit, the token contract, your real payout address and the chain.`,
        steps: [
          'Give every challenge a unique id (for example an HMAC over the challenge) and check it when the credential comes back.',
          'Set expires to an ISO 8601 time a few minutes ahead, made fresh for every 402.',
          'Put the request in request= as base64url JSON: amount (digits, smallest unit), currency (the token contract), recipient (your payout address, never 0x000…) and methodDetails.chainId.',
        ],
        code: [
          raw('The challenge header', `WWW-Authenticate: Payment id="<unique, e.g. HMAC of the fields below>", realm="${host}", method="evm", intent="charge", request="<base64url of the JSON below>", expires="<now + 5 minutes, ISO 8601>"`),
          raw('The request (decoded)', JSON.stringify(request, null, 2), 'json'),
          node('Build it', `import crypto from "node:crypto";
const request = { amount: "10000", currency: ${j(NETWORKS['eip155:8453'].usdc)}, recipient: process.env.PAY_TO, methodDetails: { chainId: 8453 } };
const expires = new Date(Date.now() + 5 * 60 * 1000).toISOString();
const encoded = Buffer.from(JSON.stringify(request)).toString("base64url");
const id = crypto.createHmac("sha256", process.env.MPP_SECRET).update(\`\${encoded}|\${expires}\`).digest("base64url");
res.set("WWW-Authenticate", \`Payment id="\${id}", realm=${j(host)}, method="evm", intent="charge", request="\${encoded}", expires="\${expires}"\`);`),
        ],
      };
    },
  },
  {
    // Stellar options: the asset must be the token's C… contract and extra.areFeesSponsored true.
    key: 'stellar-option',
    match: (c) => /^accepts\[\d+\]-(asset|extra)$/.test(c.id) && c.status === 'fail' && /Soroban token contract|areFeesSponsored/.test(c.message),
    fix(c, ctx) {
      const a = ctx.accepts[optionIndex(c)] || {};
      const net = NETWORKS[a.network] || NETWORKS['stellar:pubnet'];
      const option = { scheme: 'exact', network: a.network || 'stellar:pubnet', amount: a.amount && /^\d+$/.test(String(a.amount)) ? String(a.amount) : '100000', asset: net.usdc, payTo: a.payTo || 'G…your account', maxTimeoutSeconds: 300, extra: { areFeesSponsored: true } };
      return {
        title: /areFeesSponsored/.test(c.message) ? 'Settle Stellar through a facilitator that sponsors the fees' : `Use the USDC contract on ${net.name} as asset`,
        why: `${c.message}`,
        steps: [
          `asset is the token's Stellar Asset Contract: USDC on ${net.name} is ${net.usdc} (not "USDC" or "USDC:<issuer>"). Amounts have 7 decimals ("100000" is $0.01).`,
          'Register @x402/stellar with a facilitator that sponsors Stellar fees; the x402 server then copies areFeesSponsored: true from its /supported into extra.',
        ],
        code: [
          raw('The Stellar option', JSON.stringify(option, null, 2), 'json'),
          node('Register Stellar', `import { ExactStellarScheme } from "@x402/stellar/exact/server";
const stellar = new HTTPFacilitatorClient({ url: process.env.STELLAR_FACILITATOR_URL }); // one that sponsors fees
resourceServer.register(${j(a.network || 'stellar:pubnet')}, new ExactStellarScheme());`),
        ],
      };
    },
  },
  {
    key: 'algorand-id',
    match: (c) => /^accepts\[\d+\]-network-id$/.test(c.id) && c.status === 'warn',
    fix(c, ctx) {
      const a = ctx.accepts[optionIndex(c)] || {};
      const caip2 = `algorand:${String(a.network || '').slice('algorand:'.length, 'algorand:'.length + 32)}`;
      return {
        title: 'Name Algorand by its CAIP-2 id',
        why: c.message,
        steps: [
          `Change the option's network from "${a.network}" to "${caip2}": the same chain, written as CAIP-2 (the first 32 characters of the genesis hash).`,
          'With @x402/avm, register the scheme under that id and upgrade to 2.29 or later. Your facilitator must list the id in its /supported (GoPlausible lists both).',
          "Then check that a buyer on @x402/avm 2.29 can pay, and that Coinbase's validator no longer names the network.",
        ],
        code: [
          raw('The Algorand option', JSON.stringify({ ...a, network: caip2 }, null, 2), 'json'),
          node('Register Algorand under the CAIP-2 id', `import { ExactAvmScheme } from "@x402/avm/exact/server";
resourceServer.register(${j(caip2)}, new ExactAvmScheme());`),
        ],
      };
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
      const burned = burnAddress(value.trim());
      if (burned) {
        return {
          title: 'Set payTo to your own wallet',
          why: `${c.message} Usually an example value or an unset PAY_TO that fell back to a default.`,
          steps: ['Put the address of the wallet you want to be paid in into your PAY_TO setting.', 'Refuse placeholder addresses at startup, so a missing setting stops the deploy instead of publishing a 402 nobody can pay.'],
          code: [node('Refuse a placeholder at startup', solana
            ? `const PAY_TO_SOLANA = process.env.PAY_TO_SOLANA?.trim();
if (!PAY_TO_SOLANA || /^1{32}$|^1nc1nerator1{32}$/.test(PAY_TO_SOLANA)) throw new Error("PAY_TO_SOLANA is not set to your wallet");`
            : `const PAY_TO = process.env.PAY_TO?.trim();
if (!/^0x[0-9a-fA-F]{40}$/.test(PAY_TO || "") || /^0x0{40}$|^0x0{36}dead$/i.test(PAY_TO)) {
  throw new Error("PAY_TO must be your own wallet address, not the zero or 0x…dEaD address");
}`)],
        };
      }
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
      if (net && !net.usdc && net.stablecoins) {
        // BNB Chain: no Circle USDC; suggest a listed dollar token, one with EIP-3009 first.
        const listed = Object.entries(net.stablecoins);
        const [address, pick] = listed.find(([, s]) => s.eip3009) || listed[0];
        return { title: `Use a dollar stablecoin on ${net.name}`, why: c.message, steps: [`Known on ${net.name}: ${listed.map(([, s]) => s.symbol).join(', ')}, all with ${pick.decimals} decimals.`], code: [raw('Option field', `"asset": ${j(address)}`, 'json')] };
      }
      return { title: net ? `Use USDC on ${net.name}` : 'Set the token address', why: c.message, steps: ['With an @x402 SDK, give a dollar price ("$0.01") and it fills in USDC for you.'], code: net ? [raw('Option field', `"asset": ${j(net.usdc)}`, 'json')] : [] };
    },
  },
  {
    key: 'amount',
    match: (c) => /^accepts\[\d+\]-amount$/.test(c.id) && (c.status === 'fail' || c.status === 'warn'),
    fix(c, ctx) {
      const a = ctx.accepts[optionIndex(c)] || {};
      const given = a.amount ?? a.maxAmountRequired;
      const token = dollarToken(V1_NAMES[a.network] || a.network, a.asset);
      if (token && token.decimals > 6 && given !== undefined) {
        // An 18-decimal token (BNB Chain): scale a dollar value, or a 6-decimal USDC amount, to its own decimals.
        const six = /^\d+$/.test(String(given)) ? String(given) : toAtomic(given);
        if (six && BigInt(six) > 0n) {
          const scaled = (BigInt(six) * 10n ** BigInt(token.decimals - 6)).toString();
          return { title: `Amount "${given}" → "${scaled}" (${usd(six)} of ${token.symbol})`, why: `${c.message} ${token.symbol} has ${token.decimals} decimals here, so $0.01 is "${10n ** BigInt(token.decimals - 2)}".`, steps: [`Set "amount": "${scaled}".`], code: [raw('Option field', `"amount": ${j(scaled)}`, 'json')] };
        }
      }
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
      // The token's own domain where x402 Doctor knows it (Celo's USDC signs as "USDC", BNB Chain's USD1 by its full name).
      const network = V1_NAMES[a.network] || a.network;
      const domain = dollarToken(network, a.asset)?.domain || EIP712[network] || EIP712['eip155:8453'];
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
    key: 'merchant',
    match: (c) => c.id === 'merchant' && c.status === 'warn',
    fix: (c, ctx) => ({
      title: 'Fix the x402-merchant extension',
      why: `${c.message} GoPlausible's x402 catalog shows the seller from this extension (name, website, logo, categories), one merchant per pay-to address.`,
      steps: ['Add the x402-merchant extension next to the Bazaar extension on every paid route (the same on every route that pays the same address).', 'Use https URLs for website and logo; a square logo of 512 px works best.', 'Then make one payment through GoPlausible\'s facilitator.'],
      code: ctx.family === 'node' ? [node('x402-merchant extension', `const merchant = {
  "x402-merchant": {
    info: {
      name: "Your service",
      website: "https://example.com",
      logo: "https://example.com/logo-512.png",
      categories: ["data", "ai-agents"],
    },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        website: { type: "string" },
        logo: { type: "string" },
        categories: { type: "array", items: { type: "string" } },
      },
    },
  },
};

// in the route config, next to the Bazaar extension:
extensions: { ...discovery, ...merchant },`)] : [],
    }),
  },
  {
    key: 'head-unpaid',
    match: (c) => c.id === 'head-unpaid' && c.status === 'warn',
    fix: (c, ctx) => ({
      title: 'Make HEAD pay too (or refuse it)',
      why: `${c.message} Anyone can make your server do the work of a paid call for free, as often as they like.`,
      steps: ['Update @x402/core and your framework adapter (@x402/express, @x402/hono, @x402/next) to the release that includes x402-foundation/x402#3796.', 'Until then, key the paid route without a method, so the middleware asks every method for payment, or refuse HEAD before the payment middleware.', 'Check again: HEAD on the paid URL must answer 402 or 405.'],
      code: ctx.family === 'node' ? [node('refuse HEAD on paid routes (Express, before paymentMiddleware)', `app.use((req, res, next) => (req.method === "HEAD" ? res.sendStatus(405) : next()));`)] : [],
    }),
  },
  {
    key: 'builder-code',
    match: (c) => c.id === 'builder-code' && c.status === 'warn',
    fix: (c, ctx) => ({
      title: 'Fix the Base Builder Code declaration',
      why: `${c.message} Base attributes an x402 payment to your app only when the facilitator finds your app code in the payment, which the buyer's client copies from extensions["builder-code"].info in your 402.`,
      steps: ['Mint your code at base.dev (Settings → Project Settings → Builder Code).', 'Declare it with declareBuilderCodeExtension on every paid route, next to the Bazaar extension; it validates the code and adds the schema.', 'Serve an x402 v2 challenge and settle on Base (the CDP facilitator writes the code into the settlement).'],
      code: ctx.family === 'node' ? [node('builder-code extension', `import { BUILDER_CODE, declareBuilderCodeExtension } from "@x402/extensions/builder-code";

// in the route config, next to the Bazaar extension:
extensions: { ...discovery, [BUILDER_CODE]: declareBuilderCodeExtension("bc_yourcode") },`)] : [],
    }),
  },
  {
    key: 'bazaar',
    match: (c) => (c.id === 'bazaar' && (c.status === 'warn' || c.status === 'fail')) || ((c.id === 'bazaar-replay' || c.id === 'bazaar-route') && c.status === 'warn'),
    fix(c, ctx) {
      const query = Object.fromEntries(new URL(ctx.url).searchParams);
      const isGet = ctx.method === 'GET';
      const example = isGet ? (Object.keys(query).length ? query : { example: 'value' }) : { example: 'value' };
      const props = Object.keys(example).map((k) => `      ${k}: { type: "string", description: "…" },`).join('\n');
      return {
        title: c.id === 'bazaar-replay' ? 'Make the Bazaar example a request that works' : c.id === 'bazaar-route' ? 'Fix the Bazaar route template' : c.status === 'fail' ? 'Fix the Bazaar declaration' : 'Declare the route for the x402 Bazaar',
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
    key: 'well-known',
    match: (c) => c.id === 'well-known' && c.status === 'warn',
    fix: (c, ctx) => ({
      title: 'List your paid routes under your public domain in /.well-known/x402',
      why: c.message,
      steps: ['Build the URLs from a fixed public origin, not from the Host header of the request.', 'Serve the same list on every host the service answers on (an old platform address too).'],
      code: [express('Serve it (Express)', `const PUBLIC_URL = process.env.PUBLIC_URL || ${j(ctx.origin)};
app.get("/.well-known/x402", (_req, res) => res.json({ version: 1, resources: [\`\${PUBLIC_URL}${ctx.path}\`] }));`)],
    }),
  },
  {
    key: 'bazaar-listing',
    match: (c) => c.id === 'bazaar-listing' && c.status === 'warn',
    fix: (c, ctx) => ({
      title: 'Get this URL listed in the CDP Bazaar',
      why: c.message,
      steps: [`Make one real payment to ${ctx.url} through the CDP facilitator; the Bazaar then lists the route under this origin.`, 'Point your own clients, scripts, docs and directory listings at this URL, so later payments use it too.', 'Keep the old host answering until the new listing appears; the old entry stays but stops being refreshed.'],
      code: [],
    }),
  },
  {
    key: 'cdp-validate',
    match: (c) => c.id === 'cdp-validate' && c.status === 'warn',
    fix: (c, ctx) => ({
      title: "Fix what Coinbase's validator rejects",
      why: c.message,
      steps: [
        'Fix each failure CDP names. Once one check fails CDP skips the ones after it, so new ones can show up after a fix.',
        `Run Coinbase's check again until it answers "valid": true and "simulation": { "outcome": "accepted" }: curl -X POST https://api.cdp.coinbase.com/platform/v2/x402/validate -H 'content-type: application/json' -d '${JSON.stringify({ resource: ctx.url, method: ctx.method === 'POST' ? 'POST' : 'GET' })}'`,
        'Then one real payment through the CDP facilitator lists the route in the CDP Bazaar.',
      ],
      code: [],
    }),
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
              'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: ctx.accepts[0]?.amount && /^\d+$/.test(ctx.accepts[0].amount) ? (Number(ctx.accepts[0].amount) / 1e6).toString() : '0.01' }, protocols: [{ x402: {} }], networks: ctx.accepts.length ? [...new Set(ctx.accepts.map((a) => V1_NAMES[a.network] || a.network))] : ['eip155:8453'], asset: 'USDC' },
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
  {
    key: 'openapi-ownership',
    match: (c) => c.id === 'openapi-ownership' && c.status === 'warn',
    fix: (c, ctx) => ({
      title: 'Sign your origin with the payout wallet for x402scan',
      why: `${c.message}`,
      steps: [
        `Sign the exact text "${ctx.origin}" (no trailing slash, no path) with personal_sign from the wallet your 402 pays to.`,
        'Put the signature in openapi.json under x-agentcash-provenance.ownershipProofs, deploy, and add the origin on x402scan again.',
      ],
      code: [
        raw('Sign with Foundry (or personal_sign from a browser wallet)', `cast wallet sign --interactive "${ctx.origin}"`, 'bash'),
        raw('openapi.json', '"x-agentcash-provenance": {\n  "ownershipProofs": ["0x…the signature…"]\n}', 'json'),
      ],
    }),
  },
  {
    key: 'bazaar-last-payment',
    match: (c) => c.id === 'bazaar-last-payment' && c.status === 'warn',
    fix: (c, ctx) => ({
      title: 'Keep the route listed in the CDP Bazaar with one settled payment',
      why: `${c.message}`,
      steps: [
        'Pay one call of this route through the CDP facilitator before day 30, from any wallet (paying from a wallet of your own sends the money back to your payout address).',
        'The Bazaar counts the payment within about six hours; a route it dropped is indexed again by the next settled payment.',
      ],
      code: [
        raw('One paid call with the x402 fetch client', `import { wrapFetchWithPayment, x402Client } from "@x402/fetch";\nimport { ExactEvmScheme } from "@x402/evm/exact/client";\nimport { privateKeyToAccount } from "viem/accounts";\n\nconst client = new x402Client().register("eip155:8453", new ExactEvmScheme(privateKeyToAccount(process.env.PAYER_KEY)));\nconst res = await wrapFetchWithPayment(fetch, client)(${j(ctx.url)});\nconsole.log(res.status, res.headers.get("payment-response"));`, 'js'),
      ],
    }),
  },
];

// Improvements: info checks that aren't wrong, but make a seller easier to find, trust or pay (measured on 200
// sellers of the Trust Index on 29 Oct 2026: most had several). They come after the fixes, as their own list.
const recipeFor = (key) => RECIPES.find((r) => r.key === key);
const asImprovement = (key, title) => (c, ctx) => {
  const f = recipeFor(key).fix({ ...c, status: 'warn' }, ctx);
  return f ? { ...f, title } : null;
};
const IMPROVEMENTS = [
  {
    key: 'agent-identity',
    match: (c) => c.id === 'agent-identity' && /^No ERC-8004 registration file|isn't registered anywhere|Not in the Identity Registry/.test(c.message),
    fix(c, ctx) {
      const fileUrl = `${ctx.origin}/.well-known/agent-registration.json`;
      const hasFile = !/^No ERC-8004/.test(c.message);
      return {
        title: hasFile ? 'Register your agent in the ERC-8004 Identity Registry' : 'Give your service an ERC-8004 identity',
        why: `${c.message} An agent can then look your service up on-chain and see that the registration points back to this domain.`,
        steps: [
          ...(hasFile ? [] : [`Serve the registration file below at ${fileUrl}, with your own name, description and services.`]),
          `Register it in the Identity Registry on Base (0x8004A169FB4a3325136EB29fA0ceB6D2e539a432) with ${fileUrl} as its URI; the transaction's Registered event gives your agent id.`,
          'Put that id in registrations in the file, and run the check again.',
        ],
        code: [
          ...(hasFile ? [] : [raw('agent-registration.json', JSON.stringify({ type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1', name: 'Your service name', description: 'What it does, in one or two sentences.', image: `${ctx.origin}/icon.png`, services: [{ name: 'web', endpoint: `${ctx.origin}/` }], active: true, x402Support: true, registrations: [{ agentId: 0, agentRegistry: 'eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' }], supportedTrust: [] }, null, 2), 'json')]),
          shell('Register (Foundry cast; Base)', `cast send 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 "register(string)" ${j(fileUrl)} --rpc-url https://mainnet.base.org --private-key $OWNER_KEY`),
        ],
      };
    },
  },
  { key: 'builder-code', match: (c) => c.id === 'builder-code' && /^No Base Builder Code/.test(c.message), fix: asImprovement('builder-code', 'Add a Base Builder Code') },
  { key: 'openapi-ownership', match: (c) => c.id === 'openapi-ownership' && /^No ownership proof/.test(c.message), fix: asImprovement('openapi-ownership', 'Prove you own this origin, for x402scan') },
  { key: 'well-known', match: (c) => c.id === 'well-known' && /^No \/\.well-known\/x402/.test(c.message), fix: asImprovement('well-known', 'Publish /.well-known/x402') },
  {
    key: 'bazaar-output',
    match: (c) => c.id === 'bazaar-output' && /without an output schema/.test(c.message),
    fix: (c) => ({
      title: 'Add an output schema next to the output example',
      why: `${c.message} Agents and the Bazaar read the schema to know which fields your answer has before they pay.`,
      steps: ['Describe the fields of your response in output.schema, next to output.example, in the Bazaar declaration.'],
      code: [node('Discovery declaration', `output: {
  example: { /* your real response, as now */ },
  schema: { type: "object", properties: { /* each field: { type, description } */ }, required: [ /* the fields always present */ ] },
},`)],
    }),
  },
  {
    key: 'well-known-names',
    match: (c) => c.id === 'well-known-names',
    fix: (c, ctx) => ({
      title: 'Name each resource in /.well-known/x402',
      why: `${c.message}`,
      steps: ['List each paid route as an object with url, method, name and a one-line description instead of a bare URL.'],
      code: [raw('/.well-known/x402', JSON.stringify({ version: 1, resources: [{ url: ctx.url, method: ctx.method, name: 'Short name', description: 'What the caller gets, in one line.' }] }, null, 2), 'json')],
    }),
  },
  {
    key: 'paywall',
    match: (c) => c.id === 'paywall' && /^No browser paywall/.test(c.message),
    fix: (c) => ({
      title: 'Add a browser paywall for people',
      why: `${c.message} With @x402/paywall a person who opens the URL gets a page to pay with their wallet instead of raw JSON.`,
      steps: ['Install @x402/paywall, build a paywall in mainnet mode and pass it to paymentMiddleware.'],
      code: [
        shell('Install', 'npm install @x402/paywall'),
        node('Paywall (mainnet)', `import { createPaywall, evmPaywall, svmPaywall } from "@x402/paywall";

const paywall = createPaywall()
  .withNetwork(evmPaywall)
  .withNetwork(svmPaywall)
  .withConfig({ appName: "Your service", testnet: false }) // the default is testnet
  .build();

app.use(paymentMiddleware(routes, resourceServer, undefined, paywall));`),
      ],
    }),
  },
  {
    key: 'openapi-contact',
    match: (c) => c.id === 'openapi-contact',
    fix: (c) => ({
      title: 'Add a contact e-mail to openapi.json',
      why: `${c.message}`,
      steps: ['Add info.contact with an e-mail address you read.'],
      code: [raw('openapi.json', '"info": {\n  "title": "Your service",\n  "contact": { "name": "Your name or company", "email": "you@example.com" }\n}', 'json')],
    }),
  },
  {
    key: 'agent-instructions',
    match: (c) => c.id === 'agent-instructions' && /^No \/skill\.md/.test(c.message),
    fix(c, ctx) {
      const host = new URL(ctx.url).host;
      const price = ctx.accepts[0]?.amount && /^\d+$/.test(String(ctx.accepts[0].amount)) && ctx.accepts[0].network?.startsWith('eip155:') ? `$${(Number(ctx.accepts[0].amount) / 1e6).toString()}` : '$0.01';
      return {
        title: 'Publish /skill.md for agents',
        why: `${c.message}`,
        steps: [`Serve this Markdown at ${ctx.origin}/skill.md (and the same at /llms.txt if you like), with your own routes and prices.`, `Then a user can tell an agent "connect to ${host}/skill.md".`],
        code: [
          raw('skill.md', `---
name: ${host}
description: One line on what this service does for an agent.
---

# ${host}

Paid with x402 (USDC on Base). An unpaid call answers 402 with the payment terms; pay and call again.

| Route | Price | What you get |
|---|---|---|
| \`${ctx.method} ${ctx.url}\` | ${price} | What the caller gets |

Example: \`${ctx.method} ${ctx.url}\`
`, 'markdown'),
          express('Serve it (Express)', 'app.get(["/skill.md", "/llms.txt"], (_req, res) => res.type("text/markdown").sendFile(require("path").join(__dirname, "skill.md")));'),
        ],
      };
    },
  },
  {
    key: 'openapi-free-routes',
    match: (c) => c.id === 'openapi-free-routes',
    fix: (c) => ({
      title: 'Mark the free routes in openapi.json',
      why: `${c.message}`,
      steps: ['Give every free operation "security": [] so x402scan lists it as public instead of reporting it as unprotected.'],
      code: [raw('openapi.json', '"/your/free/route": {\n  "get": {\n    "summary": "…",\n    "security": [],\n    "responses": { "200": { "description": "OK" } }\n  }\n}', 'json')],
    }),
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

  const improvements = [];
  for (const check of report.checks || []) {
    if (check.status !== 'info') continue;
    const recipe = IMPROVEMENTS.find((r) => r.match(check));
    const fix = recipe ? recipe.fix(check, ctx) : null;
    if (!fix || improvements.some((f) => f.recipe === recipe.key)) continue;
    improvements.push({ recipe: recipe.key, severity: 'info', checks: [check.id], ...fix });
  }

  const code = (f) => f.code.filter((c) => c.stack === 'any' || c.stack === 'generic' || (stack.family === 'node' && (c.stack === 'node' || c.stack === 'express')));
  return {
    url: report.url,
    method: report.method,
    overall: report.overall,
    stack: { id: stack.id, name: stack.name, detected_from: stack.detected_from },
    summary: `${fixes.length
      ? `${fixes.length} fix${fixes.length === 1 ? '' : 'es'} (${fixes.filter((f) => f.severity === 'fail').length} blocking), for ${stack.name}.`
      : unfixed.length ? 'No recipe for the remaining warnings; see unfixed.' : 'Nothing to fix: every check passes.'}${improvements.length ? ` ${improvements.length} improvement${improvements.length === 1 ? '' : 's'} to be easier to find, trust or pay.` : ''}`,
    fixes: fixes.map(({ key, ...f }) => ({ ...f, code: code(f), verify: `Run x402 Doctor again on ${report.url}; ${f.checks.join(', ')} should pass.` })),
    improvements: improvements.map((f) => ({ ...f, code: code(f) })),
    unfixed,
  };
}

module.exports = { buildFixes, RECIPES, IMPROVEMENTS, toAtomic, usd };
