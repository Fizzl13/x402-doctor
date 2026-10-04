// Limits kept by a wallet server instead of in this process: one budget and
// one set of rules for all of an owner's agents, approvals on the server's
// dashboard or Telegram. Same interface as createLimiter in limits.js.
//
// The server only counts, asks and records; this agent still signs and pays
// itself, and its keys never leave it. When the server can't be reached, the
// wallet stops (limit_unavailable) instead of signing.

export function createRemoteLimiter({ url, key, fetch: fetchImpl = globalThis.fetch, requestTimeoutMs = 35_000, onSpend } = {}) {
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) throw new TypeError("server.url must be the wallet server's URL (https://…)");
  if (typeof key !== "string" || !key.startsWith("awk_")) throw new TypeError("server.key must be an agent key (awk_…) made on the server's dashboard");
  const base = url.replace(/\/$/, "");

  async function call(method, path, body) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), requestTimeoutMs);
    try {
      const res = await fetchImpl(`${base}${path}`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" }, body: body === undefined ? undefined : JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), signal: ctl.signal });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(`wallet server ${path}: ${data?.message ?? data?.error ?? `HTTP ${res.status}`}`);
      return data;
    } finally { clearTimeout(t); }
  }

  return {
    remote: true,
    async reserve({ method, request, verdict, purchase }) {
      let r = await call("POST", "/v1/reserve", { method, request, verdict: verdict ?? null, ...(purchase ? { purchase } : {}) });
      if (r.status === "ok") return { ok: true, entries: (r.entries ?? []).map((id) => ({ id })), purchaseId: r.purchaseId ?? null };
      if (r.status === "paused") return { ok: false, paused: true, summary: r.summary ?? "paused on the wallet server", reasons: [] };
      if (r.status === "denied") return { ok: false, hardStop: true, summary: r.summary, reasons: r.reasons ?? [] };
      if (r.status !== "pending") throw new Error(`wallet server: unexpected answer ${r.status}`);
      // Over a limit: the owner decides on the dashboard or Telegram. Wait for it.
      const id = r.approvalId, summary = r.summary, deadline = (r.expiresAt ?? Date.now() + 600_000) + 10_000;
      while (Date.now() < deadline) {
        const a = await call("GET", `/v1/approvals/${encodeURIComponent(id)}?wait=25`);
        if (a.status === "approved") return { ok: true, entries: (a.entries ?? []).map((x) => ({ id: x })), approved: true, purchaseId: a.purchaseId ?? null };
        if (a.status === "denied") return { ok: false, asked: true, summary: `${summary} (denied by the owner)`, reasons: [] };
        if (a.status === "expired") return { ok: false, asked: true, summary: `${summary} (no answer in time)`, reasons: [] };
      }
      return { ok: false, asked: true, summary: `${summary} (no answer in time)`, reasons: [] };
    },
    async release(entries, info) { if (entries?.length) await call("POST", "/v1/release", { entries: entries.map((e) => e.id), ...(info?.purchaseId ? { purchaseId: info.purchaseId, error: String(info.error ?? "").slice(0, 300) || null } : {}) }); },
    spent(entries, result, info) {
      for (const e of entries ?? []) { try { onSpend?.({ id: e.id, result, verdict: info?.verdict ?? null, receiptId: info?.verdict?.receipt?.request_id ?? null, purchase: info?.purchase ?? null, purchaseId: info?.purchaseId ?? null }); } catch (err) { console.warn(`[presign-guard-wallet] onSpend threw: ${err.message}`); } }
      if (entries?.length) call("POST", "/v1/spent", { entries: entries.map((e) => e.id), result: typeof result === "string" ? result : null, ...(info?.purchaseId ? { purchaseId: info.purchaseId } : {}) }).catch((err) => console.warn(`[presign-guard-wallet] ${err.message}`));
    },
    // What happened after signing (e.g. the API's answer and the x402 settlement), on the server's receipt.
    async annotate(purchaseIds, outcome) { await call("POST", "/v1/purchases/annotate", { ids: purchaseIds, outcome }); },
    async spending() { return (await call("GET", "/v1/spending")).spending; },
  };
}
