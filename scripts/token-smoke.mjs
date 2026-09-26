// nohumans.directory: claim challenges (one-time, 24h, not credentials) for 3 listings whose descriptions we rewrite.
const API = "https://api.nohumans.directory";
for (const [id, what] of [["ee5c650c-d63", "presign token"], ["1259df9a-70c", "ichimoku signal"], ["3e22b66d-48d", "ichimoku levels"]]) {
  const r = await fetch(`${API}/v1/listings/${id}/claim/challenge`, { method: "POST" });
  const d = await r.json().catch(() => ({}));
  console.log(`${what} ${id}: ${r.status} token=${d.token} | ${(d.instructions || []).join(" | ").slice(0, 400)}`);
}
