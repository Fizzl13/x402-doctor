// Spending limits for presign-guard-wallet: per transaction and per rolling
// window (default 24h), per token, with a human asked (onOverLimit) for
// anything over a limit, to an address outside the allow list, or of a token
// without a limit.
//
// What counts as spending:
//   - the native value sent with a transaction (ETH, BNB, POL);
//   - an ERC-20 transfer or transferFrom (and a TIP-20 transferWithMemo on Tempo);
//   - an allowance (approve, increaseAllowance, Permit, Permit2): whoever gets
//     it can spend that amount, so it counts when it is given; an unlimited
//     one or setApprovalForAll is over any limit;
//   - an EIP-3009 payment or Permit2 transfer signature.
// Transactions are decoded here; typed-data signatures are read from the
// signed subject of presign-guard's verdict. A signature presign-guard could
// not decode (or one signed without a verdict) counts as unknown spending.
//
// Amounts are kept at 18 decimals so one budget can cover the same token with
// different decimals on different chains (USDC is 18 on BNB Chain, 6 elsewhere).
import { decodeFunctionData, formatUnits, parseAbi, parseUnits } from "viem";

const SCALE = 18;
const NATIVE = "native";

// USDC (native and bridged) per chain, with decimals. Bridged USDC shares the budget.
const USDC = {
  1: [["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", 6]],
  10: [["0x0b2c639c533813f4aa9d7837caf62653d097ff85", 6], ["0x7f5c764cbc14f9669b88837ca1490cca17c31607", 6]],
  56: [["0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", 18]],
  137: [["0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", 6], ["0x2791bca1f2de4661ed88a30c99a7a9449aa84174", 6]],
  8453: [["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", 6]],
  42161: [["0xaf88d065e77c8cc2239327c5edb3a432268e5831", 6], ["0xff970a61a04b1ca14834a43f5de4533ebddb5cc8", 6]],
  // Tempo: USDC.e (bridged USDC, what MPP charges in), and pathUSD on the Moderato testnet.
  4217: [["0x20c000000000000000000000b9537d11c60e8b50", 6]],
  42431: [["0x20c0000000000000000000000000000000000000", 6]],
};
const NATIVE_SYMBOL = { 1: "ETH", 10: "ETH", 8453: "ETH", 42161: "ETH", 56: "BNB", 137: "POL" };
export const KNOWN_TOKENS = ["USDC", "ETH", "BNB", "POL"];

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount)",
  "function increaseAllowance(address spender, uint256 addedValue)",
  "function transfer(address to, uint256 amount)",
  "function transferFrom(address from, address to, uint256 amount)",
  "function transferWithMemo(address to, uint256 amount, bytes32 memo)",
  "function setApprovalForAll(address operator, bool approved)",
]);

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const lower = (a) => (typeof a === "string" ? a.toLowerCase() : a);

export function parseWindow(window) {
  if (window === undefined) return 86_400_000;
  if (typeof window === "number" && window > 0) return window;
  const m = /^(\d+)\s*(m|h|d)$/.exec(String(window));
  if (!m || Number(m[1]) === 0) throw new TypeError('limits.window must be like "24h", "1h", "7d", "30m" or a number of milliseconds');
  return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
}

function amount(value, what) {
  if (value === undefined || value === null) return null;
  if (!/^\d+(\.\d+)?$/.test(String(value))) throw new TypeError(`${what} must be a positive number of whole tokens, like "5" or "0.002"`);
  return parseUnits(String(value), SCALE);
}

// limits config -> { budgets, index, unknownTokens, allow, windowMs }
export function normalizeLimits(limits) {
  if (!limits || typeof limits !== "object") throw new TypeError("limits must be an object");
  const { tokens = {}, unknownTokens = "ask", allow, window } = limits;
  if (!["stop", "ask", "allow"].includes(unknownTokens)) throw new TypeError('limits.unknownTokens must be "stop", "ask" or "allow"');
  if (allow !== undefined && (!Array.isArray(allow) || allow.some((a) => !ADDRESS_RE.test(a)))) throw new TypeError("limits.allow must be a list of 0x addresses");
  const budgets = new Map();
  const index = new Map(); // "chainId:token" or "*:token" -> { budget, decimals }
  const put = (k, v) => { if (index.has(k)) throw new TypeError(`limits.tokens: ${k} is covered twice`); index.set(k, v); };
  for (const [name, cfg] of Object.entries(tokens)) {
    if (!cfg || typeof cfg !== "object") throw new TypeError(`limits.tokens.${name} must be { perTx, perDay }`);
    const perTx = amount(cfg.perTx, `limits.tokens.${name}.perTx`);
    const perDay = amount(cfg.perDay, `limits.tokens.${name}.perDay`);
    if (perTx === null && perDay === null) throw new TypeError(`limits.tokens.${name} needs perTx, perDay or both`);
    budgets.set(name, { name, perTx, perDay });
    const symbol = name.toUpperCase();
    if (symbol === "USDC") {
      for (const [chain, list] of Object.entries(USDC)) for (const [addr, decimals] of list) put(`${chain}:${addr}`, { budget: name, decimals });
    } else if (["ETH", "BNB", "POL"].includes(symbol)) {
      for (const [chain, s] of Object.entries(NATIVE_SYMBOL)) if (s === symbol) put(`${chain}:${NATIVE}`, { budget: name, decimals: 18 });
    } else {
      const m = /^(?:(\d+):)?(0x[0-9a-fA-F]{40})$/.exec(name);
      if (!m) throw new TypeError(`limits.tokens: "${name}" is not a known token (${KNOWN_TOKENS.join(", ")}), a 0x address or "chainId:0x address"`);
      if (!Number.isInteger(cfg.decimals) || cfg.decimals < 0 || cfg.decimals > 36) throw new TypeError(`limits.tokens.${name}.decimals is required for a token given by address`);
      put(`${m[1] ?? "*"}:${lower(m[2])}`, { budget: name, decimals: cfg.decimals });
    }
  }
  return { budgets, index, unknownTokens, allow: allow ? new Set(allow.map(lower)) : null, windowMs: parseWindow(window) };
}

// Amounts this large are "unlimited" (dapps use 2^256-1, 2^255 or 2^160-1 for Permit2).
const UNLIMITED = 2n ** 159n;
const capped = (raw) => (raw >= UNLIMITED ? null : raw);

const scaled = (raw, decimals) => (decimals <= SCALE ? raw * 10n ** BigInt(SCALE - decimals) : (raw + 10n ** BigInt(decimals - SCALE) - 1n) / 10n ** BigInt(decimals - SCALE));

// What a request spends: items [{ chainId, token, amount (raw bigint, null = unlimited), to }],
// the addresses that receive value or rights, and whether anything could not be read.
export function spendFor(request, verdict) {
  const out = { items: [], counterparties: [], unknown: false };
  const chainId = request.chainId;
  if (request.type === "transaction") {
    const to = lower(request.to ?? null);
    const value = BigInt(request.value ?? 0);
    if (value > 0n) out.items.push({ chainId, token: NATIVE, amount: value, to });
    let call = null;
    try { if (request.data && request.data !== "0x") call = decodeFunctionData({ abi: ERC20_ABI, data: request.data }); } catch { /* another contract call */ }
    if (!call) { out.counterparties.push(to); return out; }
    const a = call.args;
    if (call.functionName === "approve" || call.functionName === "increaseAllowance") {
      if (a[1] > 0n) out.items.push({ chainId, token: to, amount: capped(a[1]), to: lower(a[0]) });
      out.counterparties.push(lower(a[0]));
    } else if (call.functionName === "transfer" || call.functionName === "transferWithMemo") {
      out.items.push({ chainId, token: to, amount: capped(a[1]), to: lower(a[0]) });
      out.counterparties.push(lower(a[0]));
    } else if (call.functionName === "transferFrom") {
      out.items.push({ chainId, token: to, amount: capped(a[2]), to: lower(a[1]) });
      out.counterparties.push(lower(a[1]));
    } else if (call.functionName === "setApprovalForAll") {
      if (a[1]) out.items.push({ chainId, token: to, amount: null, to: lower(a[0]) });
      out.counterparties.push(lower(a[0]));
    }
    return out;
  }
  // Typed data: what presign-guard decoded (and signed).
  const subject = verdict?.subject;
  const verifying = lower(request.typedData?.domain?.verifyingContract ?? null);
  if (!subject || !Array.isArray(subject.grants) || ["unknown_signature", "marketplace_order"].includes(subject.kind)) {
    out.unknown = true;
    out.counterparties.push(verifying);
    return out;
  }
  for (const g of subject.grants) {
    out.items.push({ chainId, token: lower(g.token), amount: g.amount === null || g.amount === undefined || g.allForAll || g.unlimited ? null : capped(BigInt(g.amount)), to: lower(g.spender) });
    out.counterparties.push(lower(g.spender));
  }
  if (!subject.grants.length) out.counterparties.push(verifying);
  return out;
}

const fmt = (x) => (x === null ? "unlimited" : formatUnits(x, SCALE));
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "a new contract");

// Check a request against the limits. Returns { charges: [{ budget, amount }], reasons, hardStop }.
export function evaluate(policy, spend, used) {
  const reasons = [];
  let hardStop = false;
  const perBudget = new Map(); // budget -> scaled total (null = unlimited)
  const unknownItems = [];
  for (const item of spend.items) {
    const hit = policy.index.get(`${item.chainId}:${item.token}`) ?? policy.index.get(`*:${item.token}`);
    if (!hit) { unknownItems.push(item); continue; }
    const prev = perBudget.has(hit.budget) ? perBudget.get(hit.budget) : 0n;
    perBudget.set(hit.budget, prev === null || item.amount === null ? null : prev + scaled(item.amount, hit.decimals));
  }
  if (unknownItems.length || spend.unknown) {
    if (policy.unknownTokens === "stop") hardStop = true;
    if (policy.unknownTokens !== "allow") {
      for (const item of unknownItems) reasons.push({ code: "unknown_token", token: item.token === NATIVE ? `${NATIVE_SYMBOL[item.chainId] ?? "native"} on chain ${item.chainId}` : item.token, amount: item.amount === null ? "unlimited" : item.amount.toString(), to: item.to, message: `${item.amount === null ? "unlimited" : item.amount.toString()} (raw units) of ${item.token === NATIVE ? "the native coin" : item.token} on chain ${item.chainId}, a token without a limit` });
      if (spend.unknown) reasons.push({ code: "unknown_spend", message: "a signature whose spending could not be read" });
    }
  }
  const charges = [];
  for (const [name, total] of perBudget) {
    const b = policy.budgets.get(name);
    const u = used.get(name) ?? 0n;
    if (b.perTx !== null && (total === null || total > b.perTx)) reasons.push({ code: "per_tx", budget: name, amount: fmt(total), limit: fmt(b.perTx), message: `${fmt(total)} ${name} is over the limit of ${fmt(b.perTx)} per transaction` });
    if (b.perDay !== null && (total === null || u + total > b.perDay)) reasons.push({ code: "per_day", budget: name, amount: fmt(total), limit: fmt(b.perDay), used: fmt(u), message: `${fmt(total)} ${name} is over the limit of ${fmt(b.perDay)} per ${windowLabel(policy.windowMs)} (${fmt(u)} used)` });
    // An approved unlimited allowance uses up what is left of the window.
    charges.push({ budget: name, amount: total ?? (b.perDay !== null && b.perDay > u ? b.perDay - u : 0n) });
  }
  if (policy.allow) {
    for (const c of new Set(spend.counterparties)) {
      if (!c || !policy.allow.has(c)) reasons.push({ code: "not_allowed", to: c, message: `${short(c)} is not on the allow list` });
    }
  }
  return { charges, reasons, hardStop };
}

const windowLabel = (ms) => (ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : `${ms / 60_000}m`);

// In memory: gone on a restart. Fine for a single run; use fileStore or your own store otherwise.
export function memoryStore() {
  let entries = [];
  return {
    async add(entry) { entries.push(entry); },
    async remove(id) { entries = entries.filter((e) => e.id !== id); },
    async list(since) { entries = entries.filter((e) => e.at >= since - 31 * 86_400_000); return entries.filter((e) => e.at >= since); },
  };
}

let seq = 0;
const newId = () => `${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// The limiter the wallet uses: one check at a time (so two parallel
// transactions cannot both fit in the last of a budget), booked before
// signing and given back when signing fails.
export function createLimiter(limits, { store = memoryStore(), onOverLimit, onSpend, now = () => Date.now() } = {}) {
  const policy = normalizeLimits(limits);
  if (onOverLimit !== undefined && typeof onOverLimit !== "function") throw new TypeError("onOverLimit must be a function");
  if (onSpend !== undefined && typeof onSpend !== "function") throw new TypeError("onSpend must be a function");
  for (const m of ["add", "remove", "list"]) if (typeof store?.[m] !== "function") throw new TypeError(`store must have add, remove and list (missing ${m})`);
  let queue = Promise.resolve();
  const locked = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };

  async function usedNow() {
    const used = new Map();
    for (const e of await store.list(now() - policy.windowMs + 1)) used.set(e.budget, (used.get(e.budget) ?? 0n) + BigInt(e.amount));
    return used;
  }

  return {
    policy,
    // Resolves to { ok: true, entries } or { ok: false, hardStop, reasons, summary }.
    reserve: (info) => locked(async () => {
      const spend = spendFor(info.request, info.verdict);
      const used = await usedNow();
      const result = evaluate(policy, spend, used);
      if (result.reasons.length) {
        const summary = result.reasons.map((r) => r.message).join("; ");
        if (result.hardStop || !onOverLimit) return { ok: false, ...result, summary };
        const approved = (await onOverLimit({ method: info.method, request: info.request, verdict: info.verdict, reasons: result.reasons, summary, spending: await summarize(used), purchase: info.purchase ?? null })) === true;
        if (!approved) return { ok: false, ...result, summary, asked: true };
      }
      const entries = result.charges.filter((c) => c.amount > 0n).map((c) => ({ id: newId(), at: now(), budget: c.budget, amount: c.amount.toString(), method: info.method, chainId: info.request.chainId, to: spend.items[0]?.to ?? info.request.to ?? null }));
      for (const e of entries) await store.add(e);
      return { ok: true, entries };
    }),
    release: async (entries) => { for (const e of entries) await store.remove(e.id); },
    spent(entries, result, info) {
      if (!onSpend) return;
      for (const e of entries) {
        try { onSpend({ ...e, amount: formatUnits(BigInt(e.amount), SCALE), result, verdict: info.verdict ?? null, receiptId: info.verdict?.receipt?.request_id ?? null, purchase: info.purchase ?? null }); } catch (err) { console.warn(`[presign-guard-wallet] onSpend threw: ${err.message}`); }
      }
    },
    spending: async () => summarize(await usedNow()),
  };

  async function summarize(used) {
    return [...policy.budgets.values()].map((b) => {
      const u = used.get(b.name) ?? 0n;
      return { token: b.name, perTx: b.perTx === null ? null : fmt(b.perTx), perDay: b.perDay === null ? null : fmt(b.perDay), used: fmt(u), left: b.perDay === null ? null : fmt(b.perDay > u ? b.perDay - u : 0n) };
    });
  }
}
