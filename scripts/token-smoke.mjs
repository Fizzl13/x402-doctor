// agent402.tools: exactly how a seller registers an origin (form fields, API, required data).
const ua = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15', accept: 'text/html,application/json,text/plain' };
const text = (s) => s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ');
const get = async (u) => { try { const r = await fetch(u, { headers: ua, redirect: 'follow', signal: AbortSignal.timeout(15000) }); return { status: r.status, url: r.url, body: await r.text() }; } catch (e) { return { status: 0, url: u, body: String(e.message) }; } };
const sell = await get('https://agent402.tools/sell');
const st = text(sell.body); const k = st.indexOf('Agents are buying');
console.log('SELL PAGE\n', st.slice(k, k + 5000));
console.log('\nFORMS', [...sell.body.matchAll(/<form[\s\S]*?<\/form>/g)].map((m) => m[0].replace(/\s+/g, ' ').slice(0, 1200)).join('\n---\n'));
console.log('\nSELL SCRIPT URLS', [...new Set([...sell.body.matchAll(/["'`](\/api\/[a-z0-9/_-]*(?:register|submit|seller|origin|index|list)[a-z0-9/_-]*)["'`]/gi)].map((m) => m[1]))].join(' '));
const llms = await get('https://agent402.tools/llms.txt');
for (const line of llms.body.split('\n').filter((l) => /register|seller|sell|origin|submit|index/i.test(l)).slice(0, 40)) console.log('LLMS', line.slice(0, 300));
const oa = await get('https://agent402.tools/openapi.json');
try { const j = JSON.parse(oa.body); for (const [p, ops] of Object.entries(j.paths || {})) if (/regist|seller|origin|submit|index|list/i.test(p)) for (const [m, o] of Object.entries(ops)) console.log('OPENAPI', m.toUpperCase(), p, '-', (o.summary || o.description || '').slice(0, 200), JSON.stringify(o.requestBody?.content?.['application/json']?.schema || o.parameters || '').slice(0, 500)); } catch { console.log('openapi', oa.status, oa.body.slice(0, 200)); }
