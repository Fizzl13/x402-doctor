// One-off check: x402-trust detail for the ichimoku /signals endpoint vs /signal (read-only). Output is data only.
for (const id of ['165771', '165309']) {
  const html = await (await fetch(`https://x402-trust.com/endpoint/${id}`)).text();
  const text = html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ');
  const i = text.indexOf('ichimoku');
  console.log(`=== ${id}`, text.slice(Math.max(0, i - 200), i + 5000));
}
