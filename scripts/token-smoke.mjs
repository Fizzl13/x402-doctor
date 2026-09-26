// nohumans.directory demand, compact: every published search term with its buyer-IP count (free, read-only).
const d = await (await fetch("https://api.nohumans.directory/v1/demand")).json();
console.log(`window ${d.window_starts_at_iso} → ${d.window_ends_at_iso} (${d.covered_days} days), ${d.total_queries} queries from ${d.distinct_client_ips} IPs`);
const rows = [...(d.top_needs || []), ...(d.other_needs || []), ...(d.needs || [])];
const seen = new Set();
for (const r of rows) {
  if (seen.has(r.q)) continue; seen.add(r.q);
  console.log(`${String(r.buyer_client_ips).padStart(3)} ips ${String(r.searches).padStart(4)}x ${r.distinct_days}d | ${r.q} | top: ${(r.catalogue_top || []).map((t) => `${t.name.slice(0, 40)} $${t.price_amount}`).join(" ; ")}`);
}
console.log("other keys:", Object.keys(d).join(", "));
if (d.named_listing_lookups) console.log("named lookups:", JSON.stringify(d.named_listing_lookups).slice(0, 1500));
