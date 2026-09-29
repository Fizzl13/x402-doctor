// Site audit part 2: subdomain assets and Agentic Market slugs, read-only GETs. Output is data only.
const PAT = { font_new: /Space\+?\s?Grotesk|DM\+?\s?Sans/gi, violet: /#a78bfa|167,\s?139,\s?250|violet/gi, fonts: /font-family:[^;]{0,80}/gi, googlefonts: /fonts\.googleapis\.com\/css2\?[^"')]+/gi,
  colors: /--[a-z-]+:\s*#[0-9a-fA-F]{3,6}/g, mint: /#61f5c3/gi, surname: /zwager/gi, onrender: /[a-z0-9-]+\.onrender\.com/gi, logo: /<svg[^>]*class="[^"]*(mark|logo)[^"]*"/gi, img: /<img[^>]+src="[^"]+"/gi, favicon: /rel="icon"[^>]*href="[^"]{0,120}/gi };
const urls = [];
for (const h of ['ai', 'cv', 'lab', 'projects']) urls.push(`https://${h}.fizzl.eu/`, `https://${h}.fizzl.eu/style.css`);
urls.push('https://fizzl.eu/');
for (const u of urls) {
  try {
    const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0 (fizzl site audit)' }, signal: AbortSignal.timeout(30000) });
    const t = await r.text();
    console.log(`\nASSET ${u} -> ${r.status} ${t.length}b`);
    for (const [k, re] of Object.entries(PAT)) { const m = t.match(re) || []; if (m.length) console.log(`  ${k} ${m.length}: ${[...new Set(m.map((x) => x.trim()))].slice(0, 14).join(' | ')}`); }
    if (u.endsWith('/')) {
      const text = t.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      console.log(`  text: ${text.slice(0, 1500)}`);
    }
  } catch (e) { console.log(`\nASSET ${u} ERR ${e.message}`); }
}
for (const slug of ['x402-doctor-fizzl-eu', 'presign-guard-fizzl-eu', 'ichimoku-signal-fizzl-eu', 'plaintext-fizzl-eu', 'x402-doctor-onrender-com', 'presign-guard-onrender-com', 'ichimoku-signal-onrender-com', 'smartcontractexplainer-onrender-com']) {
  try { const r = await fetch(`https://agentic.market/services/${slug}`, { signal: AbortSignal.timeout(30000) }); const t = await r.text(); console.log(`AM ${slug} ${r.status} ${(t.match(/<title>([^<]*)/i) || [])[1] || ''}`); } catch (e) { console.log(`AM ${slug} ERR ${e.message}`); }
}
