// Site audit: fizzl.eu and its subdomains, read-only GETs. Output is data only.
const PAGES = ['https://fizzl.eu/', 'https://fizzl.eu/tools.js', 'https://fizzl.eu/style.css', 'https://ai.fizzl.eu/', 'https://cv.fizzl.eu/', 'https://lab.fizzl.eu/', 'https://projects.fizzl.eu/',
  'https://x402-doctor.fizzl.eu/', 'https://x402-doctor.fizzl.eu/trust', 'https://presign-guard.fizzl.eu/', 'https://ichimoku-signal.fizzl.eu/', 'https://plaintext.fizzl.eu/'];
const PAT = {
  font_new: /Space\+?\s?Grotesk|DM\+?\s?Sans/gi, violet: /#a78bfa|167,\s?139,\s?250|violet/gi, old_ink: /#0d1117|#161b22|#58a6ff/gi, old_fonts: /Fraunces|family=Inter|'Inter'|Poppins|Montserrat/gi,
  mint: /#61f5c3/gi, surname: /zwager/gi, gmail: /@gmail\.com/gi, onrender: /[a-z0-9-]+\.onrender\.com[^"'\s<)]*/gi, linkedin: /linkedin\.com\/[^"'\s<)]*/gi,
  agentic: /agentic\.market[^"'\s<)]*/gi, agenttools: /agent-tools\.cloud[^"'\s<)]*/gi, hashlinks: /fizzl\.eu\/#[a-z-]+/gi, price: /\$0\.\d+[^<\n]{0,50}/g,
};
for (const url of PAGES) {
  try {
    const r = await fetch(url, { headers: { accept: 'text/html,*/*', 'user-agent': 'Mozilla/5.0 (fizzl site audit)' }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
    const t = await r.text();
    const title = (t.match(/<title>([^<]*)/i) || [])[1] || '';
    console.log(`\nPAGE ${url} -> ${r.status} ${r.url !== url ? 'redirected ' + r.url : ''} ${t.length}b title="${title.trim()}"`);
    for (const [k, re] of Object.entries(PAT)) {
      const m = t.match(re) || [];
      if (m.length) console.log(`  ${k} ${m.length}: ${[...new Set(m.map((x) => x.trim()))].slice(0, 12).join(' | ')}`);
    }
    if (/\.html?$|\/$|trust$/.test(url)) {
      const heads = [...t.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map((m) => m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 14);
      console.log(`  heads: ${heads.join(' || ')}`);
      const links = [...new Set([...t.matchAll(/href="(https?:[^"]+)"/gi)].map((m) => m[1]))].slice(0, 40);
      console.log(`  links: ${links.join(' ')}`);
      const css = [...new Set([...t.matchAll(/(?:href|src)="([^"]+\.(?:css|js))"/gi)].map((m) => m[1]))];
      if (css.length) console.log(`  assets: ${css.join(' ')}`);
    }
  } catch (e) { console.log(`\nPAGE ${url} ERR ${e.message}`); }
}
