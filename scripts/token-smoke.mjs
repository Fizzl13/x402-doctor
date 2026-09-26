// nohumans.directory: claim challenge (one-time, 24h, not a credential) for the presign /v1/check listing.
const r = await fetch("https://api.nohumans.directory/v1/listings/5b72a75f-172/claim/challenge", { method: "POST" });
const d = await r.json().catch(() => ({}));
console.log(`presign check 5b72a75f-172: ${r.status} token=${d.token}`);
