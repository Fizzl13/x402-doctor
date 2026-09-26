// Verified badges for Doctor and ichimoku on x402-trust.com. Nothing paid. Retries ~5 min.
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const hosts = ['x402-doctor.onrender.com', 'ichimoku-signal.onrender.com', 'presign-guard.onrender.com'];
for (let i = 0; i < 10; i++) {
  const v = strip(await (await fetch('https://x402-trust.com/verified')).text());
  const res = [];
  for (const h of hosts) {
    const p = strip(await (await fetch(`https://x402-trust.com/provider/${h}`)).text());
    res.push([h, v.includes(h), /provider verified/i.test(p)]);
  }
  console.log(`round ${i}:`, JSON.stringify(res));
  if (res.every(([, a, b]) => a && b)) break;
  await new Promise((s) => setTimeout(s, 30000));
}
// recheck 12:28
