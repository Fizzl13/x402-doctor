// x402-trust.txt on Doctor and ichimoku (after X402_TRUST_TXT in Render), and verified status. Nothing paid. Retries ~8 min.
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const hosts = ['x402-doctor.onrender.com', 'ichimoku-signal.onrender.com'];
const done = new Set();
for (let i = 0; i < 16 && done.size < hosts.length; i++) {
  for (const h of hosts) {
    if (done.has(h)) continue;
    const r = await fetch(`https://${h}/.well-known/x402-trust.txt`, { signal: AbortSignal.timeout(90000) }).catch(() => null);
    const t = r ? await r.text() : '';
    const ok = r?.status === 200 && /^x402-trust-verification=v1:[A-Za-z0-9_-]+\n$/.test(t);
    console.log(`round ${i} ${h}: HTTP ${r?.status} well-formed=${ok} starts=${JSON.stringify(t.slice(0, 36))}`);
    if (ok) done.add(h);
  }
  if (done.size < hosts.length) await new Promise((s) => setTimeout(s, 30000));
}
const v = strip(await (await fetch('https://x402-trust.com/verified')).text());
for (const h of hosts) {
  const p = strip(await (await fetch(`https://x402-trust.com/provider/${h}`)).text());
  console.log(`${h}: on /verified=${v.includes(h)} badge=${/provider verified/i.test(p)}`);
}
