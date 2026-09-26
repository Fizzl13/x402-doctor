// nohumans.directory: claim challenges (one-time, 24h, not credentials) for presign /v1/check and /v1/token.
for (const [id, what] of [["5b72a75f-172", "/v1/check"], ["ee5c650c-d63", "/v1/token"]]) {
  const r = await fetch(`https://api.nohumans.directory/v1/listings/${id}/claim/challenge`, { method: "POST" });
  const d = await r.json().catch(() => ({}));
  console.log(`${what} ${id}: ${r.status} token=${d.token} ${d.error ?? ""}`);
}
const d = await (await fetch("https://api.nohumans.directory/v1/listings/ee5c650c-d63")).json();
console.log("current /v1/token description:", d.description);
const c = await (await fetch("https://api.nohumans.directory/v1/listings/5b72a75f-172")).json();
console.log("current /v1/check description:", c.description);
