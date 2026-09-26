// nohumans.directory: request claim challenges (one-time proof tokens, valid 24h, not credentials) for 4 listings.
const API = "https://api.nohumans.directory";
const ids = { "22c4a0f9-8dd": "doctor preflight", "b8dc5b73-c7b": "doctor diagnose", "3cdb4ceb-a86": "doctor fix", "1259df9a-70c": "ichimoku signal" };
for (const [id, what] of Object.entries(ids)) {
  const info = await (await fetch(`${API}/v1/listings/${id}/claim`)).json().catch(() => null);
  const r = await fetch(`${API}/v1/listings/${id}/claim/challenge`, { method: "POST" });
  const d = await r.json().catch(() => ({}));
  console.log(`\n${what} ${id}: claim info ${JSON.stringify(info).slice(0, 600)}\nchallenge ${r.status} ${JSON.stringify(d).slice(0, 900)}`);
}
