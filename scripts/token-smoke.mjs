// Submit our services to agent-tools.cloud (contact approved by the owner).
const B = 'https://agent-tools.cloud';
const contact = 'Fizzl13@protonmail.com';
const spec = await (await fetch(`${B}/openapi.json`)).json();
const paths = Object.entries(spec.paths).filter(([p]) => /submit/i.test(p)).map(([p, v]) => [p, v.post?.requestBody?.content?.['application/json']?.schema?.$ref]);
console.log('submit paths', JSON.stringify(paths));
const pathFor = (name) => paths.find(([, r]) => r && r.endsWith('/' + name))?.[0];
const cats = await (await fetch(`${B}/api/v1/categories`)).json();
console.log('categories', JSON.stringify(cats).slice(0, 800));
const post = async (path, body) => {
  const r = await fetch(B + path, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
  console.log('==', path, body.url, r.status, (await r.text()).slice(0, 500));
};
const svc = pathFor('SubmissionPayload');
const mcp = pathFor('McpSubmissionPayload');
const x402 = [
  { name: 'x402 Doctor', url: 'https://x402-doctor.fizzl.eu/api/v1/diagnose', category: process.env.CAT_DEV, price_usdc: 0.01, chains: ['base', 'solana'],
    description: 'Why is my x402 endpoint broken? Checks the whole payment flow an agent would hit (402 challenge, networks, payTo and amount, Solana settlement, Bazaar/OpenAPI discovery, MCP) and returns a fix per problem. Free quick check; full diagnosis $0.01.' },
  { name: 'presign-guard', url: 'https://presign-guard.fizzl.eu/v1/token', price_usdc: 0.01, chains: ['base'],
    description: 'Check before your AI agent or wallet signs: green/orange/red verdict for EVM transactions, token approvals, EIP-712 signatures and tokens, with reasons. Signed answers; $0.01 via x402 on Base.' },
  { name: 'Ichimoku Signal', url: 'https://ichimoku-signal.fizzl.eu/signal/BTC-USDT', price_usdc: 0.02, chains: ['base', 'solana'],
    description: 'Ichimoku Cloud signals, key price levels and a 148-coin market scan for trading agents. Free daily trend and 7-day setup history; paid calls from $0.02 USDC via x402.' },
  { name: 'PlainText wallet approvals', url: 'https://plaintext.fizzl.eu/', price_usdc: 0.1, chains: ['base'],
    description: "Checks a wallet's token and NFT approvals and explains the risk of each in plain language, so agents and users know what to revoke. Paid via x402 on Base." },
];
const catNames = (Array.isArray(cats) ? cats : cats.categories || []).map((c) => (typeof c === 'string' ? c : c.slug || c.name || c.id));
const pick = (...want) => want.find((w) => catNames.includes(w)) ?? null;
x402[0].category = pick('developer-tools', 'devtools', 'developer', 'infrastructure');
x402[1].category = pick('security', 'crypto', 'defi', 'blockchain');
x402[2].category = pick('finance', 'trading', 'crypto', 'market-data', 'data');
x402[3].category = pick('security', 'crypto', 'blockchain');
for (const s of x402) await post(svc, { ...s, contact });
for (const m of [
  { url: 'https://ichimoku-signal.fizzl.eu/mcp', name: 'Ichimoku Signal MCP', description: 'Ichimoku trend, signals, confluence, price levels and a market scan as MCP tools. Free trend; paid tools via x402.' },
  { url: 'https://presign-guard.fizzl.eu/mcp', name: 'presign-guard MCP', description: 'Pre-sign safety verdicts for EVM transactions, approvals and EIP-712 signatures as MCP tools. Free quick verdict; full reasons via x402.' },
  { url: 'https://x402-doctor.fizzl.eu/mcp', name: 'x402 Doctor MCP', description: 'Diagnose, preflight and fix x402 endpoints as MCP tools. Free quick check; paid diagnosis via x402.' },
  { url: 'https://plaintext.fizzl.eu/mcp', name: 'PlainText MCP', description: "Check a wallet's token and NFT approvals and explain each risk in plain language, as MCP tools." },
]) await post(mcp, { ...m, transport: 'streamable-http', contact });
