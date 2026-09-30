// Read the registration JSON Metaplex stores for the three agents (read-only GETs).
const assets = { doctor: "CLgJCXbmpJeL4v8KeXb6UGLHcVG4AkNDXKBWQjm1dupj", presign: "9NN5M9jSUv2opiU47huXeRunHvJa1DdEAtapLtrJbnG4", ichimoku: "zWMVHbd4xN1UEZ8ssGY7aCmqhyRzPtZhKtR1LeLc3WC" };
for (const [name, id] of Object.entries(assets)) {
  try {
    const r = await fetch(`https://api.metaplex.com/v1/agents/${id}?network=solana-mainnet`, { signal: AbortSignal.timeout(30000) });
    console.log("MPX", name, r.status, (await r.text()).slice(0, 3500));
  } catch (e) { console.log("MPX", name, "ERR", e.message); }
}
