// Is presign-guard shown as a verified provider on x402-trust.com after the email confirmation? Nothing paid. Retries ~10 min.
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
for (let i = 0; i < 20; i++) {
  const p = strip(await (await fetch('https://x402-trust.com/provider/presign-guard.onrender.com')).text());
  const v = strip(await (await fetch('https://x402-trust.com/verified')).text());
  const a = p.indexOf('home ›');
  const onList = v.includes('presign-guard.onrender.com');
  const badge = /provider[- ]verified|verified provider|✓ verified/i.test(p.slice(a, a + 2500));
  console.log(`round ${i}: badge on provider page=${badge} on /verified=${onList}`);
  if (badge || onList) {
    console.log(p.slice(a, a + 900));
    const j = v.indexOf('presign-guard.onrender.com');
    console.log('\n/verified row:', v.slice(Math.max(0, j - 200), j + 300));
    break;
  }
  await new Promise((s) => setTimeout(s, 30000));
}
