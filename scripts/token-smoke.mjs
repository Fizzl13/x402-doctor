// nohumans.directory: claim challenges (one-time, 24h, public by design, not credentials) for the Ichimoku
// /signals and /scan listings, whose stored prices are stale. Shows each listing's endpoint path. Free.
const API = "https://api.nohumans.directory";
for (const [id, what] of [["5b091fee-e8d", "/signals"], ["1c8d9230-124", "/scan"]]) {
  const l = await (await fetch(`${API}/v1/listings/${id}`)).json().catch(() => ({}));
  const r = await fetch(`${API}/v1/listings/${id}/claim/challenge`, { method: "POST" });
  const d = await r.json().catch(() => ({}));
  console.log(`${what} ${id}: endpoint=${l.endpoint_url} challenge ${r.status} token=${d.token} ${d.error ?? ""}`);
}
