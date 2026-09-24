// One-off: read a few public pages and print their text and links.
const UA = { 'user-agent': 'Mozilla/5.0 (research; x402-doctor)' };
const seen = new Set();
const queue = ['https://asentum.com/downloads', 'https://asentum.com/'];
const text = (html) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<svg[\s\S]*?<\/svg>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#\d+;|&\w+;/g, ' ').replace(/\s+/g, ' ').trim();
while (queue.length && seen.size < 8) {
  const url = queue.shift();
  if (seen.has(url)) continue;
  seen.add(url);
  try {
    const res = await fetch(url, { headers: UA, redirect: 'follow' });
    const html = await res.text();
    console.log(`\n===== ${url} (HTTP ${res.status}, ${html.length} bytes)`);
    console.log(text(html).slice(0, 6000));
    const links = [...new Set([...html.matchAll(/href="([^"#]+)"/g)].map((m) => new URL(m[1], url).href))];
    console.log(`\n-- links: ${links.slice(0, 80).join(' ')}`);
    for (const l of links) if (/^https:\/\/(www\.)?asentum\.com\/(docs|about|pricing|features|faq|product|how|security|blog)?[^.]*$/.test(l) && !seen.has(l)) queue.push(l);
    const meta = [...html.matchAll(/<meta[^>]+(?:name|property)="(?:description|og:description|og:title)"[^>]*>/g)].map((m) => m[0]);
    if (meta.length) console.log(`-- meta: ${meta.join(' ')}`);
  } catch (e) { console.log(`${url}: ${e.message}`); }
}
