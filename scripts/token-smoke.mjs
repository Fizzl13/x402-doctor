// Find EntRoute's contact channels on their public pages (read-only GETs). Output is data only.
const pages = ['https://entroute.com/', 'https://entroute.com/docs', 'https://entroute.com/providers', 'https://entroute.com/docs/api', 'https://entroute.com/docs/verification', 'https://entroute.com/contact', 'https://entroute.com/about', 'https://entroute.com/terms', 'https://entroute.com/privacy', 'https://api.entroute.com/openapi.json', 'https://entroute.com/llms.txt', 'https://entroute.com/.well-known/security.txt'];
for (const u of pages) {
  try {
    const r = await fetch(u); const t = await r.text();
    const mails = [...new Set(t.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g) || [])];
    const links = [...new Set(t.match(/https?:\/\/(?:x\.com|twitter\.com|github\.com|discord\.gg|t\.me|discord\.com)\/[^"'\s<)]+/g) || [])];
    console.log(`PAGE ${u} ${r.status} mails=${mails.join(',') || '-'} links=${links.slice(0, 8).join(' ') || '-'}`);
  } catch (e) { console.log(`PAGE ${u} ERR ${e.message}`); }
}
