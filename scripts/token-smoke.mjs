// How to get listed on agent402.tools, agent-tools.cloud and x402list.fun.
const ua = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15', accept: 'text/html,application/json,text/plain' };
const text = (s) => s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ');
const get = async (u) => { try { const r = await fetch(u, { headers: ua, redirect: 'follow', signal: AbortSignal.timeout(15000) }); return { status: r.status, url: r.url, body: await r.text() }; } catch (e) { return { status: 0, url: u, body: String(e.message) }; } };
const show = async (u, n = 2500, raw = false) => { const r = await get(u); console.log(`\n==== ${u} -> ${r.status} ${r.url}\n${(raw ? r.body : text(r.body)).slice(0, n)}`); return r; };

// agent402.tools
await show('https://agent402.tools/sell', 3000);
await show('https://agent402.tools/contribute', 3000);
const docs = await get('https://agent402.tools/docs');
const t = text(docs.body); const i = t.search(/add (your|a) tool|list your|submit/i);
console.log(`\n==== agent402 /docs add section (at ${i})\n${t.slice(Math.max(0, i - 200), i + 2500)}`);
await show('https://raw.githubusercontent.com/MikeyPetrillo/Agent402/main/README.md', 2500, true);

// agent-tools.cloud
await show('https://agent-tools.cloud/submit', 2500);
const repo = await get('https://api.github.com/repos/AgentTools-Cloud/AgentToolsCollection');
console.log('\n==== AgentToolsCollection repo', repo.status, repo.body.slice(0, 600));
const tree = await get('https://api.github.com/repos/AgentTools-Cloud/AgentToolsCollection/contents/');
console.log('ROOT', tree.body.slice(0, 1500));
for (const f of ['README.md', 'CONTRIBUTING.md']) await show(`https://raw.githubusercontent.com/AgentTools-Cloud/AgentToolsCollection/main/${f}`, 3000, true);

// x402list.fun
const home = await get('https://x402list.fun');
console.log('\n==== x402list links', [...new Set([...home.body.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]).filter((x) => !x.startsWith('/provider/') && !x.startsWith('/_next')))].slice(0, 40).join(' | '));
for (const p of ['/about', '/faq', '/submit', '/add', '/docs', '/api']) await show(`https://x402list.fun${p}`, 900);
const src = text(home.body); const j = src.search(/indexed|crawl|source|bazaar|x402scan|submit|add your/i);
console.log(`\n==== x402list home, how listed (at ${j})\n${src.slice(Math.max(0, j - 300), j + 900)}`);
for (const h of ['x402-doctor.onrender.com', 'presign-guard.onrender.com']) await show(`https://x402list.fun/provider/${h}`, 500);
