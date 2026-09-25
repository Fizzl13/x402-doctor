// One-off: where can x402 demand (paid volume) be read? (read-only)
const show = (label, v) => console.log(`\n===== ${label}\n${typeof v === 'string' ? v : JSON.stringify(v, null, 1)}`.slice(0, 3500));
const r = await fetch('https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?type=http&limit=3&offset=0');
const j = await r.json().catch(() => ({}));
show('CDP item keys', Object.keys((j.items || [])[0] || {}));
show('CDP item sample', (j.items || [])[0]);
for (const u of ['https://agentic.market/SKILL.md', 'https://www.x402scan.com/', 'https://www.x402scan.com/resources']) {
  const t = await (await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' } })).text().catch((e) => e.message);
  const text = t.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  show(u, text.slice(0, 3000));
}
