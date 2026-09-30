// Metaplex: verification status of our three agents (read-only GETs).
const assets = { doctor: "CLgJCXbmpJeL4v8KeXb6UGLHcVG4AkNDXKBWQjm1dupj", presign: "9NN5M9jSUv2opiU47huXeRunHvJa1DdEAtapLtrJbnG4", ichimoku: "zWMVHbd4xN1UEZ8ssGY7aCmqhyRzPtZhKtR1LeLc3WC" };
for (const [n, id] of Object.entries(assets)) {
  try {
    const j = await (await fetch(`https://api.metaplex.com/v1/agents/${id}?network=solana-mainnet&t=${Date.now()}`, { signal: AbortSignal.timeout(30000) })).json();
    const { verifiedAt, tokens, owner } = j;
    const extra = Object.keys(j).filter((k) => !["success","type","name","description","image","services","x402Support","active","registrations","supportedTrust","address","walletAddress","authority","agentMetadataUri","a2aCard","verifiedAt","owner","tokens"].includes(k));
    console.log("MPX", n, JSON.stringify({ verifiedAt, tokens, extraKeys: extra }));
  } catch (e) { console.log("MPX", n, "ERR", e.message); }
}
for (const u of ["https://api.metaplex.com/v1/agents?network=solana-mainnet&owner=ATWJ82T8nRdQwZnaysB68N5EpaSvLRsQP4h6eWmaJBH9", "https://api.metaplex.com/v1/agents/CLgJCXbmpJeL4v8KeXb6UGLHcVG4AkNDXKBWQjm1dupj/stats?network=solana-mainnet"]) {
  try { const r = await fetch(u, { signal: AbortSignal.timeout(30000) }); console.log("MPX GET", u.split("/v1/")[1], r.status, (await r.text()).slice(0, 400)); } catch (e) { console.log("ERR", e.message); }
}
