// The wallet behind presign-guard-wallet-mcp: an agent's own key, wrapped in
// presign-guard-wallet, so every payment and transfer a model asks for is
// checked by presign-guard and kept to the owner's limits, with approval on
// Telegram or the wallet server above them.
import { createPublicClient, createWalletClient, erc20Abi, formatEther, formatUnits, http, isAddress, keccak256, parseEther, parseUnits, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum, base, bsc, mainnet, optimism, polygon, tempo, tempoModerato } from "viem/chains";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { guardWallet, PresignBlockedError } from "presign-guard-wallet";
import { telegramApprover } from "presign-guard-wallet/telegram";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const VERSION = "0.7.0";

// eip712: native USDC's EIP-712 domain, for EIP-3009 payments over MPP (BNB's bridged USDC has none).
const USDC_DOMAIN = { name: "USD Coin", version: "2" };
export const CHAINS = {
  base: { chain: base, usdc: ["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", 6], eip712: USDC_DOMAIN },
  ethereum: { chain: mainnet, usdc: ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 6], eip712: USDC_DOMAIN },
  optimism: { chain: optimism, usdc: ["0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", 6], eip712: USDC_DOMAIN },
  arbitrum: { chain: arbitrum, usdc: ["0xaf88d065e77c8cC2239327C5EDb3A432268e5831", 6], eip712: USDC_DOMAIN },
  polygon: { chain: polygon, usdc: ["0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", 6], eip712: USDC_DOMAIN },
  bsc: { chain: bsc, usdc: ["0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", 18] },
};

// Tempo, for MPP charges with method "tempo" (push mode: the wallet sends a TIP-20 transferWithMemo itself
// and answers with the hash). The wallet's own key works there; it needs USDC.e on Tempo, which also pays the fee.
export const TEMPO = {
  4217: { chain: tempo, token: "0x20c000000000000000000000b9537d11c60e8b50", symbol: "USDC.e" },
  42431: { chain: tempoModerato, token: "0x20c0000000000000000000000000000000000000", symbol: "pathUSD" },
};
const TIP20_ABI = [
  { type: "function", name: "transferWithMemo", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }, { name: "memo", type: "bytes32" }], outputs: [{ type: "bool" }] },
];
// The MPP memo (as mppx writes it): keccak256("mpp")[0:4], version 1, keccak256(realm)[0:10], 10 zero bytes, keccak256(challenge id)[0:7].
export const tempoMemo = (realm, challengeId) => `0x${keccak256(stringToHex("mpp")).slice(2, 10)}01${keccak256(stringToHex(String(realm))).slice(2, 22)}${"0".repeat(20)}${keccak256(stringToHex(String(challengeId))).slice(2, 16)}`;

// MPP (Machine Payments Protocol): `WWW-Authenticate: Payment id="…", realm="…", method="…", request="<base64url JSON>", …`,
// possibly several challenges in one header. Returns [{ params, request }] (request decoded, or null).
export function parseMppChallenges(header) {
  const out = [];
  const re = /(?:^|,)\s*Payment\s+/gi;
  const starts = [];
  let m;
  while ((m = re.exec(String(header ?? "")))) starts.push(m.index + m[0].length);
  starts.forEach((start, i) => {
    const chunk = String(header).slice(start, i + 1 < starts.length ? starts[i + 1] : undefined);
    const params = {};
    const pr = /([a-zA-Z_][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
    let p;
    while ((p = pr.exec(chunk))) params[p[1].toLowerCase()] = p[2] !== undefined ? p[2].replace(/\\(.)/g, "$1") : p[3];
    let request = null;
    try { request = JSON.parse(Buffer.from(String(params.request ?? ""), "base64url").toString("utf8")); } catch { request = null; }
    out.push({ params, request });
  });
  return out;
}
const EIP3009_TYPES = { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] };

const BODY_LIMIT = 20_000;
// The public x402 catalog (Coinbase's x402 Bazaar). Paid APIs list themselves there.
const DISCOVERY_URL = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const DISCOVERY_PAGES = 20;
const CHECK_PRICE_CAP = "$0.02"; // a presign-guard check costs $0.01

const amountString = z.string().regex(/^\d+(\.\d+)?$/, "a decimal amount like \"2.5\"");
// Lowercase words of 3+ letters, for matching a request against catalog listings.
const STOP = new Set(["the", "and", "for", "with", "api", "get", "data", "from", "that", "this", "http", "https", "www", "com", "json", "what", "how", "can", "want", "need", "please", "tell", "give", "show", "does", "are", "you", "your", "about", "wat", "het", "een", "van", "voor", "met", "mij", "mijn", "kan", "wil", "graag", "zijn", "deze", "dit", "die", "komende", "hoe", "welke", "waar", "wanneer", "geef", "ook", "naar", "over", "niet", "wel", "nog", "maar", "dat", "wordt", "worden", "bij", "als", "uit", "doet", "zoek"]);
// Everyday Dutch words to the English words catalog listings use, so a plain question works too
// ("wat is het weer de komende dagen in Amsterdam?" finds weather forecasts).
const NL = { weer: "weather", weerbericht: "weather", voorspelling: "forecast", temperatuur: "temperature", regen: "rain", koers: "price", koersen: "price", prijs: "price", prijzen: "price", nieuws: "news", aandeel: "stock", aandelen: "stocks", munt: "coin", munten: "coins", veilig: "safe", veiligheid: "safety", vertaal: "translate", vertaling: "translation", samenvatting: "summary", samenvatten: "summarize", adres: "address", beurs: "market", markt: "market", vandaag: "today", morgen: "tomorrow", dagen: "days", wisselkoers: "exchange", uitleg: "explain", leg: "explain", controleer: "check", afbeelding: "image", plaatje: "image", foto: "image", tekst: "text", vlucht: "flight", vluchten: "flights", bedrijf: "company", portemonnee: "wallet", signaal: "signal" };
export const words = (t) => String(t ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9]+/).map((w) => NL[w] ?? w).filter((w) => w.length >= 3 && !STOP.has(w));
const address = z.string().refine((a) => isAddress(a, { strict: false }), "an 0x… address");

/**
 * Read the configuration from environment variables (see README).
 * Throws a readable error for anything missing or unsafe.
 */
export function configFromEnv(env = process.env) {
  const key = env.AGENT_KEY?.trim();
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("AGENT_KEY must be the agent wallet's private key (0x + 64 hex). Use a separate wallet with only what the agent may spend.");
  const chainName = (env.CHAIN ?? "base").toLowerCase();
  if (!CHAINS[chainName]) throw new Error(`CHAIN must be one of ${Object.keys(CHAINS).join(", ")}`);

  const server = env.WALLET_SERVER_URL || env.WALLET_SERVER_KEY ? { url: env.WALLET_SERVER_URL, key: env.WALLET_SERVER_KEY } : undefined;
  const tokens = {};
  const usdc = pick(env.LIMIT_USDC_PER_TX, env.LIMIT_USDC_PER_DAY);
  if (usdc) tokens.USDC = usdc;
  const nativeSymbol = CHAINS[chainName].chain.nativeCurrency.symbol;
  const native = pick(env.LIMIT_NATIVE_PER_TX, env.LIMIT_NATIVE_PER_DAY);
  if (native) tokens[nativeSymbol === "MATIC" ? "POL" : nativeSymbol] = native;
  if (server && Object.keys(tokens).length) throw new Error("with WALLET_SERVER_URL the limits live on the wallet server: leave out the LIMIT_* variables");
  if (!server && !Object.keys(tokens).length) throw new Error("set spending limits (LIMIT_USDC_PER_TX and/or LIMIT_USDC_PER_DAY) or a wallet server (WALLET_SERVER_URL + WALLET_SERVER_KEY): this wallet does not run without a budget");

  const telegram = env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_CHAT_ID ? { token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID } : undefined;
  if (telegram && (!telegram.token || !telegram.chatId)) throw new Error("Telegram approval needs both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID");
  if (telegram && server) throw new Error("with WALLET_SERVER_URL, approvals go through the wallet server (its own Telegram): leave out TELEGRAM_*");

  const maxPrice = env.MAX_PAYMENT_USD ?? "1";
  if (!/^\d+(\.\d+)?$/.test(maxPrice)) throw new Error("MAX_PAYMENT_USD must be a number of dollars, e.g. 1 or 0.25");

  return {
    key,
    chainName,
    rpcUrl: env.RPC_URL || undefined,
    creditKey: env.PRESIGN_CREDIT_KEY || undefined,
    server,
    limits: server ? undefined : { tokens },
    telegram,
    label: env.AGENT_LABEL || "mcp-agent",
    maxPaymentUsd: Number(maxPrice),
    // MPP on Tempo: on by default (mainnet), TEMPO_CHAIN=42431 for the testnet, TEMPO=off to leave it out.
    tempo: tempoConfig(env),
    discoveryUrl: env.X402_DISCOVERY_URL || DISCOVERY_URL,
  };
}

function tempoConfig(env) {
  if (String(env.TEMPO ?? "").toLowerCase() === "off") return null;
  const chainId = Number(env.TEMPO_CHAIN || 4217);
  if (!TEMPO[chainId]) throw new Error(`TEMPO_CHAIN must be ${Object.keys(TEMPO).join(" or ")}`);
  return { chainId, rpcUrl: env.TEMPO_RPC_URL || undefined };
}

function pick(perTx, perDay) {
  const out = {};
  for (const [k, v] of [["perTx", perTx], ["perDay", perDay]]) {
    if (v === undefined || v === "") continue;
    if (!/^\d+(\.\d+)?$/.test(v)) throw new Error(`limits must be amounts like "5" or "0.5" (got "${v}")`);
    out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The guarded wallet and what the tools do with it. `overrides` is for tests
 * (walletClient, publicClient, fetch, presign options such as verifyReceipts).
 */
export function createWallet(config, overrides = {}) {
  const { chain, usdc } = CHAINS[config.chainName];
  const account = privateKeyToAccount(config.key);
  const transport = http(config.rpcUrl);
  const walletClient = overrides.walletClient ?? createWalletClient({ account, chain, transport });
  const publicClient = overrides.publicClient ?? createPublicClient({ chain, transport });
  const plainFetch = overrides.fetch ?? globalThis.fetch;

  // Pays the presign-guard checks ($0.01 each, USDC on Base) with the agent's key,
  // capped per payment. Not guarded itself: guarding the check would check the check.
  const checkPayer = new x402Client().setSpendControls({ maxAmountPerPayment: CHECK_PRICE_CAP });
  checkPayer.register("eip155:8453", new ExactEvmScheme(account));
  const pay = wrapFetchWithPayment(plainFetch, checkPayer);

  const onOverLimit = config.telegram ? telegramApprover({ ...config.telegram, label: config.label, fetch: plainFetch }) : undefined;
  const guarded = guardWallet(walletClient, {
    pay,
    creditKey: config.creditKey,
    fetch: plainFetch,
    limits: config.limits,
    onOverLimit,
    server: config.server ? { ...config.server, fetch: plainFetch } : undefined,
    ...overrides.guard,
  });

  // x402 payments are signed by the guarded wallet: checked, and counted toward the USDC limits.
  const signer = {
    address: account.address,
    signTypedData: (typedData) => guarded.signTypedData({ account, ...typedData }),
    readContract: (args) => publicClient.readContract(args),
  };

  // The MPP challenge this wallet can pay: method "evm", intent "charge", USDC on its own chain, EIP-3009 authorization.
  function payableMpp(res) {
    if (!CHAINS[config.chainName].eip712) return null;
    return parseMppChallenges(res.headers.get("www-authenticate")).find(({ params, request: r }) =>
      params.method === "evm" && params.intent === "charge" && params.id && params.realm && r
      && Number(r.methodDetails?.chainId) === chain.id && String(r.currency ?? "").toLowerCase() === usdc[0].toLowerCase()
      && isAddress(String(r.recipient ?? ""), { strict: false }) && /^\d+$/.test(String(r.amount ?? ""))
      && (!r.methodDetails?.credentialTypes || r.methodDetails.credentialTypes.includes("authorization"))
      && !r.methodDetails?.splits?.length) ?? null;
  }

  // Pays an MPP evm charge: the same EIP-3009 USDC signature as x402, signed by the guarded signer (so checked by
  // presign-guard and counted toward the limits), sent back as `Authorization: Payment <credential>`.
  async function payMpp({ url, init, challenge, cap }) {
    const { params, request: r } = challenge;
    const price = Number(r.amount) / 10 ** usdc[1];
    if (price > cap) throw new Error(`the price ($${price}) is above max_price_usd ($${cap}); nothing was paid`);
    const nonce = keccak256(stringToHex(JSON.stringify([params.id, params.realm])));
    const expires = Date.parse(params.expires ?? "");
    const validBefore = BigInt(Math.floor((Number.isFinite(expires) ? expires : Date.now() + 300_000) / 1000));
    const message = { from: account.address, to: r.recipient, value: BigInt(r.amount), validAfter: 0n, validBefore, nonce };
    const signature = await signer.signTypedData({ domain: { ...CHAINS[config.chainName].eip712, chainId: chain.id, verifyingContract: usdc[0] }, types: EIP3009_TYPES, primaryType: "TransferWithAuthorization", message });
    // The challenge goes back exactly as received (request and opaque stay base64url strings).
    const credential = {
      challenge: params,
      payload: { type: "authorization", from: account.address, to: r.recipient, value: String(r.amount), validAfter: "0", validBefore: String(validBefore), nonce, signature },
      source: `did:pkh:eip155:${chain.id}:${account.address}`,
    };
    const h = new Headers(init.headers);
    h.set("authorization", `Payment ${Buffer.from(JSON.stringify(credential)).toString("base64url")}`);
    return plainFetch(url, { ...init, headers: h });
  }

  // Tempo: the same guard (limits, pause, receipts) on a client for Tempo, made when first needed.
  const tempoNet = config.tempo ? { ...TEMPO[config.tempo.chainId], chainId: config.tempo.chainId } : null;
  let tempoClients = null;
  const tempoOf = () => (tempoClients ??= (() => {
    const t = http(config.tempo.rpcUrl);
    return {
      wallet: guarded.wrap(overrides.tempoWalletClient ?? createWalletClient({ account, chain: tempoNet.chain, transport: t })),
      public: overrides.tempoPublicClient ?? createPublicClient({ chain: tempoNet.chain, transport: t }),
    };
  })());

  // The MPP challenge this wallet can pay on Tempo: method "tempo", intent "charge", push mode, its stablecoin, no splits.
  function payableTempo(res) {
    if (!tempoNet) return null;
    return parseMppChallenges(res.headers.get("www-authenticate")).find(({ params, request: r }) =>
      params.method === "tempo" && params.intent === "charge" && params.id && params.realm && r
      && Number(r.methodDetails?.chainId ?? 4217) === tempoNet.chainId && String(r.currency ?? "").toLowerCase() === tempoNet.token
      && isAddress(String(r.recipient ?? ""), { strict: false }) && /^\d+$/.test(String(r.amount ?? "")) && BigInt(r.amount) > 0n
      && (r.methodDetails?.supportedModes ?? ["pull", "push"]).includes("push") && !r.methodDetails?.splits?.length) ?? null;
  }

  // Pays an MPP tempo charge: a USDC.e transferWithMemo (memo bound to the realm and challenge id), signed through the
  // guarded Tempo client (counted toward the USDC limits), then the hash goes back as `Authorization: Payment <credential>`.
  async function payTempo({ url, init, challenge, cap }) {
    const { params, request: r } = challenge;
    const price = Number(r.amount) / 1e6;
    if (price > cap) throw new Error(`the price ($${price}) is above max_price_usd ($${cap}); nothing was paid`);
    const t = tempoOf();
    const hash = await t.wallet.writeContract({ address: tempoNet.token, abi: TIP20_ABI, functionName: "transferWithMemo", args: [r.recipient, BigInt(r.amount), tempoMemo(params.realm, params.id)], feeToken: tempoNet.token });
    const receipt = await t.public.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status !== "success") throw new Error(`the Tempo payment failed on chain (${hash}); the API was not called`);
    const credential = { challenge: params, payload: { hash, type: "hash" }, source: `did:pkh:eip155:${tempoNet.chainId}:${account.address}` };
    const h = new Headers(init.headers);
    h.set("authorization", `Payment ${Buffer.from(JSON.stringify(credential)).toString("base64url")}`);
    return { res: await plainFetch(url, { ...init, headers: h }), hash };
  }

  // One paid call, capped per call: x402 when the API offers it, else MPP (evm, USDC on this chain), else MPP on Tempo.
  async function callX402({ url, method, body, headers, maxPriceUsd }) {
    const cap = Math.min(maxPriceUsd ?? config.maxPaymentUsd, config.maxPaymentUsd);
    const init = { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) };
    const first = await plainFetch(url, init);
    let res = first, protocol = null, tempoHash = null;
    if (first.status === 402 && !first.headers.get("payment-required") && payableMpp(first)) {
      protocol = "mpp";
      res = await payMpp({ url, init, challenge: payableMpp(first), cap });
    } else if (first.status === 402 && !first.headers.get("payment-required") && payableTempo(first)) {
      protocol = "mpp-tempo";
      ({ res, hash: tempoHash } = await payTempo({ url, init, challenge: payableTempo(first), cap }));
    } else if (first.status === 402 && !first.headers.get("payment-required") && parseMppChallenges(first.headers.get("www-authenticate")).length) {
      const offered = parseMppChallenges(first.headers.get("www-authenticate")).map(({ params, request: r }) => `${params.method ?? "?"}${r?.methodDetails?.chainId ? ` on chain ${r.methodDetails.chainId}` : ""}`);
      throw new Error(`this API only takes MPP (${[...new Set(offered)].join(", ")}), which this wallet can't pay: it pays MPP evm in USDC on ${config.chainName}${tempoNet ? ` and MPP tempo in ${tempoNet.symbol} on Tempo` : " (Tempo is off)"}. Nothing was paid`);
    } else if (first.status === 402) {
      // x402: the payment client starts from the 402 we already have, so the API isn't asked twice.
      const client = new x402Client().setSpendControls({ maxAmountPerPayment: `$${cap}` });
      client.register(`eip155:${chain.id}`, new ExactEvmScheme(signer));
      let pending = first;
      const replay = (input, i) => { if (pending) { const r = pending; pending = null; return Promise.resolve(r); } return plainFetch(input, i); };
      res = await wrapFetchWithPayment(replay, client)(url, init);
    }
    const text = await res.text();
    let payment = null;
    const settled = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
    const receipt = res.headers.get("payment-receipt");
    if (protocol === "mpp-tempo") {
      // The USDC.e has moved either way: the hash is the proof. A refused answer can be asked again with the same credential.
      payment = { protocol: "mpp", method: "tempo", success: res.ok, transaction: tempoHash, network: `eip155:${tempoNet.chainId}`, ...(res.ok ? {} : { note: "paid on Tempo but the API did not answer successfully; the transaction hash is the proof of payment" }) };
    } else if (protocol === "mpp" && receipt) {
      try { const r = JSON.parse(Buffer.from(receipt, "base64url").toString("utf8")); payment = { protocol: "mpp", success: r.status === "success", transaction: r.reference ?? null, network: `eip155:${chain.id}`, method: r.method }; } catch { payment = { protocol: "mpp", raw: receipt }; }
    } else if (settled) { try { payment = decodePaymentResponseHeader(settled); } catch { payment = { raw: settled }; } }
    return {
      status: res.status,
      paid: !!payment,
      payment,
      contentType: res.headers.get("content-type"),
      body: text.length > BODY_LIMIT ? `${text.slice(0, BODY_LIMIT)}\n… (${text.length - BODY_LIMIT} more characters cut)` : text,
    };
  }

  // The x402 catalog, fetched page by page and kept for an hour.
  let listed = null, listedAt = 0, loading = null;
  async function catalog() {
    if (listed && Date.now() - listedAt < DISCOVERY_TTL_MS) return listed;
    loading ??= (async () => {
      const items = [];
      for (let page = 0; page < DISCOVERY_PAGES; page++) {
        const res = await plainFetch(`${config.discoveryUrl}?type=http&limit=500&offset=${page * 500}`, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`the x402 catalog answered HTTP ${res.status}`);
        const batch = (await res.json()).items ?? [];
        items.push(...batch);
        if (batch.length < 500) break;
      }
      listed = items; listedAt = Date.now();
      return items;
    })().finally(() => { loading = null; });
    return loading;
  }

  return {
    address: account.address,
    chain,
    guard: guarded,

    async status() {
      const [native, usdcBalance, tempoBalance] = await Promise.all([
        publicClient.getBalance({ address: account.address }).catch(() => null),
        publicClient.readContract({ address: usdc[0], abi: erc20Abi, functionName: "balanceOf", args: [account.address] }).catch(() => null),
        tempoNet ? tempoOf().public.readContract({ address: tempoNet.token, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }).catch(() => null) : null,
      ]);
      return {
        address: account.address,
        chain: `${config.chainName} (${chain.id})`,
        balances: {
          [chain.nativeCurrency.symbol]: native === null ? "unknown" : formatEther(native),
          USDC: usdcBalance === null ? "unknown" : formatUnits(usdcBalance, usdc[1]),
          ...(tempoNet ? { [`${tempoNet.symbol} on Tempo${tempoNet.chainId === 4217 ? "" : " testnet"} (for MPP tempo charges)`]: tempoBalance === null ? "unknown" : formatUnits(tempoBalance, 6) } : {}),
        },
        limits: config.server ? `kept by the wallet server ${config.server.url}` : config.limits.tokens,
        spending: await guarded.spending().catch((err) => `unavailable (${err.message})`),
        approvals: config.server ? "wallet server (dashboard / Telegram)" : config.telegram ? "Telegram" : "none: anything over a limit is refused",
        maxPaymentUsd: config.maxPaymentUsd,
        paused: guarded.paused(),
      };
    },

    // Every payment is recorded with what it is for: on the wallet server's receipts, in Telegram approvals, in onSpend.
    async sendUsdc({ to, amount, reason }) {
      const value = parseUnits(amount, usdc[1]);
      const hash = await guarded.withPurchase({ description: reason || `Send ${amount} USDC to ${to}` }, () => guarded.writeContract({ address: usdc[0], abi: erc20Abi, functionName: "transfer", args: [to, value] }));
      return { hash, sent: `${amount} USDC`, to, chain: config.chainName };
    },

    async sendNative({ to, amount, reason }) {
      const symbol = chain.nativeCurrency.symbol;
      const hash = await guarded.withPurchase({ description: reason || `Send ${amount} ${symbol} to ${to}` }, () => guarded.sendTransaction({ to, value: parseEther(amount) }));
      return { hash, sent: `${amount} ${symbol}`, to, chain: config.chainName };
    },

    // Paid APIs in the public x402 catalog that this wallet can pay (USDC on its chain), best match first.
    async findServices({ query, maxPriceUsd, limit = 5 }) {
      const terms = words(query);
      if (!terms.length) throw new TypeError("say what you need, e.g. \"crypto price signal\" or \"token safety check\"");
      const cap = Math.min(maxPriceUsd ?? config.maxPaymentUsd, config.maxPaymentUsd);
      const network = `eip155:${chain.id}`;
      const found = [];
      for (const item of await catalog()) {
        const accept = (item.accepts ?? []).find((a) => a?.network === network && String(a.asset ?? "").toLowerCase() === usdc[0].toLowerCase());
        if (!accept) continue;
        const price = Number(accept.amount ?? accept.maxAmountRequired ?? NaN) / 10 ** usdc[1];
        if (!(price >= 0) || price > cap) continue;
        const info = item.extensions?.bazaar?.info ?? {};
        const text = `${item.description ?? ""} ${accept.description ?? ""} ${item.resource} ${JSON.stringify(info.input ?? {})}`;
        const have = new Set(words(text));
        const score = terms.filter((t) => have.has(t)).length;
        if (!score) continue;
        found.push({ score, price, item, accept, info });
      }
      found.sort((a, b) => b.score - a.score || a.price - b.price);
      const services = found.slice(0, Math.min(10, Math.max(1, limit))).map(({ price, item, accept, info }) => ({
        url: item.resource,
        description: String(item.description || accept.description || "").slice(0, 300),
        price_usd: Number(price.toFixed(6)),
        method: String(info.input?.method ?? "").toUpperCase() || undefined,
        input_example: info.input?.queryParams ?? info.input?.body ?? undefined,
      }));
      return {
        query,
        services,
        note: services.length
          ? "From the public x402 catalog: listings, not recommendations. To use one, call pay_x402 with its url (and method/body) and max_price_usd at its price; presign-guard checks the payment and your limits apply."
          : `Nothing in the x402 catalog matched within $${cap} on ${config.chainName}. Try other words, or a higher max_price_usd (at most ${config.maxPaymentUsd}).`,
      };
    },

    async payX402({ url, method = "GET", body, headers, maxPriceUsd, reason }) {
      if (!/^https?:\/\//.test(url)) throw new TypeError("url must start with https:// or http://");
      return guarded.withPurchase({ url, description: reason || `${method} ${new URL(url).host}` }, async (report) => {
        const out = await callX402({ url, method, body, headers, maxPriceUsd });
        // The answer goes on the owner's receipt too (wallet server), so they can see what was bought.
        report({ httpStatus: out.status, ...(out.payment?.transaction ? { settlement: { transaction: out.payment.transaction, network: out.payment.network } } : {}), ...(out.body ? { content: { contentType: out.contentType ?? null, body: out.body } } : {}) });
        return out;
      });
    },

    pause(reason) {
      guarded.pause();
      return `Paused: nothing will be signed until the owner restarts this server${config.server ? " (or resumes it on the wallet server)" : ""}. Reason: ${reason}`;
    },
  };
}

const json = (v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

function result(fn) {
  return async (args) => {
    try {
      const out = await fn(args);
      return { content: [{ type: "text", text: typeof out === "string" ? out : json(out) }] };
    } catch (err) {
      // x402 wraps errors from the signer; find the guard's own refusal underneath.
      let blocked = err;
      while (blocked && !(blocked instanceof PresignBlockedError)) blocked = blocked.cause;
      const guardText = /not signed|nothing was signed|is paused/.exec(err.message) ? err.message.replace(/^.*?(?=not signed|presign check|wallet is paused|spending limits|verdict not trusted|chain \d)/, "") : null;
      const why = blocked ? `Not done (${blocked.code}): ${blocked.message}` : guardText ? `Not done: ${guardText}` : `Failed: ${err.message}`;
      return { isError: true, content: [{ type: "text", text: why }] };
    }
  };
}

/** The MCP server with the wallet's tools. */
export function createServer(wallet) {
  const server = new McpServer({ name: "presign-guard-wallet", version: VERSION });
  server.registerTool("wallet_status", {
    title: "Wallet status",
    description: "This agent's wallet: address, chain, balances, spending limits, what is left today, how approvals work, and whether it is paused. Check it before spending.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, result(() => wallet.status()));

  server.registerTool("find_services", {
    title: "Find paid services",
    description: "Search the public x402 catalog (Coinbase's x402 Bazaar) for paid APIs this wallet can pay: USDC on its chain, within max_price_usd. Returns url, description, price and how to call each one, best match first. Use it whenever the owner asks for something you can't answer yourself (live weather, prices, news, safety checks, ...), however they say it and in any language: pass the gist as the query, in English works best. Then call pay_x402 with the one you pick and answer the owner. Don't ask the owner to confirm a payment that is within this wallet's limits: the limits are their consent, and anything over them goes to the owner for approval anyway. Listings are not recommendations: prefer a clear description and a fair price, and pay only what the task needs.",
    inputSchema: {
      query: z.string().min(2).max(200).describe("What you need, in a few words, e.g. \"weather forecast amsterdam\", \"bitcoin trend signal\" or \"is this token safe\" (Dutch works too)"),
      max_price_usd: z.number().positive().optional().describe("Highest price per call to show, in dollars (default and at most the server's MAX_PAYMENT_USD)"),
      limit: z.number().int().min(1).max(10).optional().describe("How many results (default 5)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, result(({ query, max_price_usd, limit }) => wallet.findServices({ query, maxPriceUsd: max_price_usd, limit })));

  server.registerTool("pay_x402", {
    title: "Pay for an x402 API",
    description: "Call a URL that may answer 402 Payment Required and pay it in USDC from this wallet, then return the response. Works with x402 and with MPP (the Machine Payments Protocol): method evm (USDC on this wallet's chain) and method tempo (USDC.e on Tempo, from this wallet's address there). When an API offers several, x402 comes first, then MPP evm, then Tempo. The payment is checked by presign-guard and counts toward the spending limits; over a limit the owner is asked to approve (the call waits), and a refusal comes back as an error with the reason. max_price_usd caps the price of this call.",
    inputSchema: {
      url: z.string().url().describe("The API URL"),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional().describe("HTTP method (default GET)"),
      body: z.union([z.string(), z.record(z.string(), z.unknown())]).optional().describe("Request body: a string, or an object sent as JSON"),
      headers: z.record(z.string(), z.string()).optional().describe("Extra request headers, e.g. content-type"),
      max_price_usd: z.number().positive().optional().describe("The most this call may cost, in dollars (never above the server's MAX_PAYMENT_USD)"),
      reason: z.string().max(300).optional().describe("What this is for, in a few words (shown to the owner on the receipt and in approval requests)"),
    },
    annotations: { openWorldHint: true },
  }, result(({ url, method, body, headers, max_price_usd, reason }) => {
    const h = { ...(headers ?? {}) };
    if (body !== undefined && typeof body !== "string" && !Object.keys(h).some((k) => k.toLowerCase() === "content-type")) h["content-type"] = "application/json";
    return wallet.payX402({ url, method, body, headers: h, maxPriceUsd: max_price_usd, reason });
  }));

  server.registerTool("send_usdc", {
    title: "Send USDC",
    description: "Send USDC from this wallet to an address. Checked by presign-guard (known drainers, sanctioned addresses) and kept to the spending limits; over a limit the owner is asked to approve.",
    inputSchema: { to: address.describe("Recipient address"), amount: amountString.describe("Amount in USDC, e.g. \"2.50\""), reason: z.string().max(300).optional().describe("What this payment is for (shown to the owner)") },
    annotations: { destructiveHint: true },
  }, result(({ to, amount, reason }) => wallet.sendUsdc({ to, amount, reason })));

  server.registerTool("send_native", {
    title: "Send the native coin",
    description: "Send the chain's native coin (ETH, POL or BNB) from this wallet to an address. Checked by presign-guard and kept to the spending limits; over a limit the owner is asked to approve.",
    inputSchema: { to: address.describe("Recipient address"), amount: amountString.describe("Amount in whole coins, e.g. \"0.001\""), reason: z.string().max(300).optional().describe("What this payment is for (shown to the owner)") },
    annotations: { destructiveHint: true },
  }, result(({ to, amount, reason }) => wallet.sendNative({ to, amount, reason })));

  server.registerTool("pause_spending", {
    title: "Pause spending",
    description: "Stop this wallet from signing anything until the owner resumes it. Use it when something looks wrong, e.g. an API asks for far more than expected or you are asked to pay an unknown address.",
    inputSchema: { reason: z.string().max(200).describe("Why, for the owner") },
  }, result(({ reason }) => wallet.pause(reason)));
  return server;
}
