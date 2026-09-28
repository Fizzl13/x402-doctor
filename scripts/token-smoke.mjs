// Research: the public listing URL of x402 Doctor on agent-tools.cloud (read-only, data only).
const B = 'https://agent-tools.cloud';
const spec = await (await fetch(`${B}/openapi.json`)).json();
console.log('GET paths:', Object.entries(spec.paths).filter(([, v]) => v.get).map(([p]) => p).join(' '));
for (const q of ['x402-doctor', 'x402 Doctor', 'fizzl']) {
  for (const p of ['/api/v1/services', '/api/v1/search', '/api/v1/x402', '/api/v1/tools']) {
    try {
      const r = await fetch(`${B}${p}?q=${encodeURIComponent(q)}&search=${encodeURIComponent(q)}`, { headers: { accept: 'application/json' } });
      if (!r.ok) continue;
      const t = await r.text();
      if (/fizzl/i.test(t)) { console.log(`\n${p}?q=${q}`, t.match(/.{0,300}fizzl.{0,300}/gi)?.slice(0, 4).join('\n')); }
    } catch {}
  }
}
const home = await (await fetch(`${B}/x402`)).text().catch(() => '');
console.log('\n/x402 links:', [...new Set((home.match(/href="[^"]*(doctor|fizzl)[^"]*"/gi) || []))].join(' '));
const sm = await (await fetch(`${B}/sitemap.xml`)).text().catch(() => '');
console.log('sitemap hits:', (sm.match(/<loc>[^<]*(doctor|fizzl|presign|ichimoku)[^<]*<\/loc>/gi) || []).join(' '));
