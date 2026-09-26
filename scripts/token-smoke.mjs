// x402-trust.com scores for our hosts: grade, score, verdict and flag counts per endpoint (free pages, nothing paid).
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const hosts = ['x402-doctor.onrender.com', 'presign-guard.onrender.com', 'ichimoku-signal.onrender.com', 'smartcontractexplainer.onrender.com'];
for (const h of hosts) {
  const res = await fetch(`https://x402-trust.com/provider/${h}`);
  const body = await res.text();
  const t = strip(body);
  console.log(`\n=== ${h}: HTTP ${res.status} verified=${/provider verified/i.test(t)}`);
  if (!res.ok) continue;
  const i = t.indexOf('All endpoints');
  console.log(t.slice(i, i + 900));
  const ids = [...new Set([...body.matchAll(/href="\/endpoint\/(\d+)"/g)].map((m) => m[1]))];
  for (const id of ids) {
    const e = strip(await (await fetch(`https://x402-trust.com/endpoint/${id}`)).text());
    const head = e.slice(e.indexOf('home ›'), e.indexOf('home ›') + 260);
    const why = (e.match(/Why this verdict\?[^F]{0,80}/) || [''])[0];
    const snap = (e.match(/Snapshot computed [0-9-]+ [0-9:]+ UTC/) || [''])[0];
    const probes = (e.match(/Probes \(30d\) \d+/) || [''])[0];
    console.log(`  #${id}: ${head.replace(/home › providers › /, '').slice(0, 200)} | ${why.trim()} | ${probes} | ${snap}`);
  }
}
