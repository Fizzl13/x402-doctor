// One-off: collect Xona's x402 endpoints from their docs, then run x402 Doctor
// (read-only, never pays) on a sample across networks and resource types.
import { execFileSync } from 'node:child_process';
const UA = { 'user-agent': 'x402-doctor/2.3 (+https://x402-doctor.onrender.com; read-only check, never pays)' };
const DOCS = 'https://docs.xona-agent.com';
const text = (html) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<svg[\s\S]*?<\/svg>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#\d+;|&\w+;/g, ' ').replace(/\s+/g, ' ').trim();

const llms = await (await fetch(`${DOCS}/llms.txt`, { headers: UA })).text();
console.log('## llms.txt\n' + llms);
const pages = [...new Set([...llms.matchAll(/\]\((\/docs[^)]*)\)/g)].map((m) => DOCS + m[1]))];
const endpoints = new Map();
for (const p of pages) {
  try {
    const html = await (await fetch(p, { headers: UA })).text();
    const t = text(html);
    const found = new Set([...(html + ' ' + t).matchAll(/https:\/\/api\.xona-agent\.com\/[A-Za-z0-9_\-\/]+/g)].map((m) => m[0].replace(/[\/]+$/, '')));
    const methodHint = /\bGET\b/.test(t) && !/\bPOST\b/.test(t) ? 'GET' : 'POST';
    for (const u of found) if (!endpoints.has(u)) endpoints.set(u, { method: methodHint, page: p });
    console.log(`\n## ${p}: ${found.size} endpoint URLs\n${t.slice(0, 1200)}`);
  } catch (e) { console.log(`${p}: ${e.message}`); }
}
console.log(`\n## all endpoints (${endpoints.size})`);
for (const [u, v] of endpoints) console.log(`${v.method} ${u}`);

// A sample: every network prefix, spread over resource types, at most 20.
const byNet = new Map();
for (const [u, v] of endpoints) {
  const net = u.split('/')[3] || '?';
  if (!byNet.has(net)) byNet.set(net, []);
  byNet.get(net).push([u, v]);
}
const sample = [];
while (sample.length < 20 && [...byNet.values()].some((l) => l.length)) {
  for (const l of byNet.values()) if (l.length && sample.length < 20) sample.push(l.splice(Math.floor(l.length / 2), 1)[0]);
}
console.log(`\n## Doctor on ${sample.length} endpoints`);
const results = [];
const run = (u, method) => {
  let out;
  try { out = execFileSync('node', ['doctor/bin/x402-doctor.js', u, '--method', method, '--json'], { encoding: 'utf8', timeout: 60000 }); }
  catch (e) { out = e.stdout || ''; }
  try { return JSON.parse(out); } catch { return null; }
};
const no402 = (r) => !r || (r.overall === 'fail' && (r.checks || []).some((c) => c.status === 'fail' && /\b(404|405)\b|method not allowed|not found/i.test(c.message || '')));
for (const [u, v] of sample) {
  let method = v.method;
  let r = run(u, method);
  if (no402(r)) { const other = method === 'POST' ? 'GET' : 'POST'; const r2 = run(u, other); if (!no402(r2)) { r = r2; method = other; } }
  results.push({ url: u, method, r });
  const count = (st) => (r?.checks || []).filter((c) => c.status === st).length;
  console.log(`\n### ${method} ${u}: ${String(r?.overall || 'no report').toUpperCase()} (${count('pass')} pass, ${count('warn')} warn, ${count('fail')} fail)`);
  for (const c of r?.checks || []) if (c.status === 'warn' || c.status === 'fail') console.log(`  ${c.status.toUpperCase()} [${c.group || ''}] ${c.message}${c.hint ? '\n      hint: ' + c.hint : ''}`);
}
console.log(`\n## tally`);
for (const x of results) console.log(`${String(x.r?.overall || 'none').padEnd(5)} ${x.method} ${x.url}`);
