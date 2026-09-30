// Re-read the x402 Doctor registration JSON at Metaplex (read-only GET), no cache.
const r = await fetch(`https://api.metaplex.com/v1/agents/CLgJCXbmpJeL4v8KeXb6UGLHcVG4AkNDXKBWQjm1dupj?network=solana-mainnet&t=${Date.now()}`, { headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(30000) });
const j = await r.json();
console.log("MPX doctor", r.status, JSON.stringify({ name: j.name, services: j.services, x402Support: j.x402Support, active: j.active }));
