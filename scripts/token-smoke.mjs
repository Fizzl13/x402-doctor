// x402-trust.com endpoint page for Doctor's preflight, right after a paid refresh (free page, nothing paid).
const text = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
for (const id of [153087]) {
  const res = await fetch(`https://x402-trust.com/endpoint/${id}`);
  const t = text(await res.text());
  const a = t.indexOf('home ›');
  console.log(t.slice(a, a + 1500));
  const i = t.search(/Why this verdict/);
  console.log('\n', t.slice(i, i + 800));
  const j = t.search(/Snapshot computed/);
  console.log('\n', t.slice(j, j + 200));
}
