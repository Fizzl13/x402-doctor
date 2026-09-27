// Read MetaMask's Terms of Use and print the clauses about automated access, APIs, scraping, commercial use. Read-only.
const r = await fetch("https://legal.consensys.io/metamask/terms-of-use/", { headers: { "user-agent": "Mozilla/5.0" } });
const html = await r.text();
const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&#8217;|&rsquo;/g, "'").replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"').replace(/\s+/g, " ");
console.log("HTTP", r.status, "chars", text.length, "| last updated:", (text.match(/Last Updated[^.]{0,60}/i) || [""])[0]);
const keys = /automat|scrap|crawl|robot|\bbot|spider|reverse engineer|\bAPI|interface|commercial|resell|sublicense|third[- ]party (services|content)|security (alert|provider)|Blockaid|data mining/i;
const sentences = text.split(/(?<=[.;])\s+/);
const seen = new Set();
for (let i = 0; i < sentences.length; i++) {
  if (keys.test(sentences[i]) && !seen.has(i)) { seen.add(i); console.log(`\n[${i}] ${sentences[i].slice(0, 700)}`); }
}
const def = text.match(/"Services"[^.]{0,500}\./);
console.log("\nSERVICES DEFINITION:", def ? def[0] : "(not found)");
