// presign-guard x402-trust.txt served? and does x402-trust.com show the provider as verified? Nothing paid.
for (let i = 0; i < 10; i++) {
  const r = await fetch('https://presign-guard.onrender.com/.well-known/x402-trust.txt', { signal: AbortSignal.timeout(60000) }).catch(() => null);
  const t = r ? await r.text() : '';
  const ok = r?.status === 200 && /^x402-trust-verification=v1:[A-Za-z0-9_-]+\n$/.test(t);
  console.log(`round ${i}: HTTP ${r?.status} ${r?.headers.get('content-type')} well-formed=${ok} length=${t.length} starts=${JSON.stringify(t.slice(0, 40))}`);
  if (ok) break;
  await new Promise((s) => setTimeout(s, 30000));
}
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const p = strip(await (await fetch('https://x402-trust.com/provider/presign-guard.onrender.com')).text());
const i = p.indexOf('home ›');
console.log('\nprovider page:', p.slice(i, i + 700));
console.log('mentions verified:', /provider[- ]verified|Verified provider/i.test(p.slice(i, i + 3000)));
const v = strip(await (await fetch('https://x402-trust.com/verified')).text());
console.log('on /verified list:', v.includes('presign-guard.onrender.com'));
