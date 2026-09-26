// Status of our 12 nohumans listings (embedding sync time included), then the ranking test. Free, read-only.
const API = "https://api.nohumans.directory";
const ids = { "5b72a75f-172": "presign check", "6298e4ab-2fb": "presign explain", "ee5c650c-d63": "presign token", "1f61fcfc-42f": "presign approvals",
  "1259df9a-70c": "ichimoku signal", "5b091fee-e8d": "ichimoku signals", "3e22b66d-48d": "ichimoku levels", "1c8d9230-124": "ichimoku scan",
  "22c4a0f9-8dd": "doctor preflight", "b8dc5b73-c7b": "doctor diagnose", "3cdb4ceb-a86": "doctor fix", "938d66f7-e9c": "plaintext check-wallet" };
const t = (s) => (s ? new Date(s * 1000).toISOString().slice(11, 16) : "-");
for (const [id, what] of Object.entries(ids)) {
  const d = await (await fetch(`${API}/v1/listings/${id}`)).json().catch(() => ({}));
  console.log(`${what.padEnd(22)} ${String(d.status).padEnd(10)} score=${d.score} probes=${d.probes_passed}/${d.probe_count} updated=${t(d.updated_at)} embedded=${t(d.embedding_synced_at)} ${d.origin}`);
}
console.log("");
await import("./rank.mjs");
