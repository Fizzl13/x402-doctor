// Aggregator survey: which x402/agent-tool directories exist, are our services in them, and how do providers get listed?
const OURS = /x402-doctor\.onrender|presign-guard\.onrender|ichimoku-signal\.onrender|smartcontractexplainer\.onrender/gi;
const ua = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15', accept: 'text/html,application/json' };
const text = (s) => s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const get = async (u) => { try { const r = await fetch(u, { headers: ua, redirect: 'follow', signal: AbortSignal.timeout(12000) }); return { status: r.status, url: r.url, body: await r.text() }; } catch (e) { return { status: 0, url: u, body: String(e.message) }; } };

// 1) AgentBIT's discovery: which sources carry which of our resources.
const bySource = {};
for (const q of ['x402-doctor', 'presign-guard', 'ichimoku', 'smartcontractexplainer', 'onrender']) {
  const d = JSON.parse((await get(`https://agentbit.app/api/discover?q=${q}`)).body || '{}');
  if (q === 'onrender') console.log('AGENTBIT SOURCES', JSON.stringify(d.sources));
  for (const i of d.items || []) if (OURS.test(i.resource || '')) { OURS.lastIndex = 0; (bySource[i.source] ||= new Set()).add(i.resource); }
  OURS.lastIndex = 0;
}
for (const [s, set] of Object.entries(bySource)) console.log('IN', s, [...set].length, [...set].slice(0, 6).join(' '));

// 2) Candidate directories: homepage summary, whether we appear, submission-looking links.
const cands = ['https://www.x402scan.com', 'https://agentic.market', 'https://agent402.tools', 'https://www.x402list.fun', 'https://x402list.com', 'https://x402.org/ecosystem', 'https://www.nohumans.directory', 'https://x402-api-catalog.onrender.com', 'https://agent-tools.cloud', 'https://www.402index.io', 'https://x402index.com', 'https://www.x402.watch', 'https://mcp.so', 'https://www.pulsemcp.com', 'https://mcpmarket.com', 'https://www.orthogonal.com/discover', 'https://merit.systems', 'https://www.proxy402.com', 'https://bazaar.x402.org', 'https://x402.jobs', 'https://www.x402hub.ai', 'https://payai.network', 'https://www.corbits.dev'];
for (const u of cands) {
  const r = await get(u);
  const t = text(r.body);
  const ours = [...new Set((r.body.match(OURS) || []))];
  const links = [...new Set([...r.body.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((x) => /submit|add|list-your|register|provider|seller|publish|contribute|github\.com|docs|apply|onboard|sell/i.test(x)))].slice(0, 12);
  console.log(`\n== ${u} -> ${r.status} ${r.url}\n  ${t.slice(0, 280)}\n  ours on page: ${ours.join(', ') || 'no'}\n  links: ${links.join(' | ')}`);
}
