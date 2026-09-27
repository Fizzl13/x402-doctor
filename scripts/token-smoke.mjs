// 08:00 check: nohumans status of the Ichimoku /setups listing and the stored prices of /signals and /scan.
// Free, read-only; no claim or edit tokens involved.
const API = "https://api.nohumans.directory";
const t = (s) => (s ? new Date(s * 1000).toISOString().replace("T", " ").slice(0, 16) : "-");
for (const [id, what] of [["59de3f48-43f", "/setups (should be $0.50)"], ["5b091fee-e8d", "/signals (should be $0.15)"], ["1c8d9230-124", "/scan (should be $0.10)"]]) {
  const d = await (await fetch(`${API}/v1/listings/${id}`)).json().catch(() => ({}));
  console.log(`${what}: status=${d.status} price=${d.price_amount} ${d.price_currency} score=${d.score} probes=${d.probes_passed}/${d.probe_count} updated=${t(d.updated_at)} embedded=${t(d.embedding_synced_at)}`);
}
