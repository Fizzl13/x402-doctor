// nohumans.directory: resolve each of our endpoints, and the submission/claim rules from llms.txt. Read-only.
const API = "https://api.nohumans.directory";
const eps = [
  "https://presign-guard.onrender.com/v1/check", "https://presign-guard.onrender.com/v1/check/explain", "https://presign-guard.onrender.com/v1/token", "https://presign-guard.onrender.com/v1/approvals",
  "https://ichimoku-signal.onrender.com/signal/:pair", "https://ichimoku-signal.onrender.com/signals/:pair", "https://ichimoku-signal.onrender.com/levels/:pair", "https://ichimoku-signal.onrender.com/scan",
  "https://x402-doctor.onrender.com/api/v1/preflight", "https://x402-doctor.onrender.com/api/v1/diagnose", "https://x402-doctor.onrender.com/api/v1/fix",
  "https://smartcontractexplainer.onrender.com/api/check-wallet", "https://smartcontractexplainer.onrender.com/api/explain",
];
const j = async (u) => { const r = await fetch(u, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(25000) }); return [r.status, await r.json().catch(() => null)]; };
for (const u of eps) {
  const [s, d] = await j(`${API}/v1/resolve?url=${encodeURIComponent(u)}`);
  const l = d?.listing || d?.match || d;
  const brief = d ? JSON.stringify({ found: d.found ?? d.listed ?? !!d.id, id: l?.id, status: l?.status, score: l?.score, probes: `${l?.probes_passed}/${l?.probe_count}`, paid_verified: l?.paid_verified, evidence: l?.evidence_tier, has_sample: l?.has_sample, verdict: d.verdict, note: d.note || d.message || d.evidence_note }) : "";
  console.log(`${s} ${u.replace("https://", "")} ${brief.slice(0, 400)}`);
}
const txt = await (await fetch(`${API}/llms.txt`)).text();
for (const key of ["### POST /v1/listings", "claim", "sample_query", "Claim"]) {
  const i = txt.indexOf(key);
  if (i >= 0) console.log(`\n--- llms.txt @ "${key}"\n${txt.slice(i, i + 2500)}`);
}
