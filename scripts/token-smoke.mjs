// Verify the AERO and USDC addresses on Base: on-chain name/symbol/decimals/supply + CoinGecko's listed Base contract. Read-only.
const RPC = "https://mainnet.base.org";
const call = async (to, data) => (await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }) })).json()).result;
const str = (hex) => { if (!hex || hex === "0x") return null; const b = Buffer.from(hex.slice(2), "hex"); const len = Number(BigInt("0x" + b.subarray(32, 64).toString("hex"))); return b.subarray(64, 64 + len).toString("utf8"); };
for (const [label, addr] of [["AERO", "0x940181a94A35A4569E4529A3CDfB74e38FD98631"], ["USDC", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"]]) {
  const name = str(await call(addr, "0x06fdde03")), symbol = str(await call(addr, "0x95d89b41"));
  const dec = parseInt(await call(addr, "0x313ce567"), 16);
  const supply = BigInt(await call(addr, "0x18160ddd"));
  const minter = await call(addr, "0x07546172"); // minter()
  console.log(`${label} ${addr}: name="${name}" symbol="${symbol}" decimals=${dec} totalSupply=${(Number(supply) / 10 ** dec).toLocaleString("en")}${minter && minter !== "0x" ? ` minter()=0x${minter.slice(26)}` : ""}`);
}
for (const id of ["aerodrome-finance", "usd-coin"]) {
  const d = await fetch(`https://api.coingecko.com/api/v3/coins/${id}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`).then((r) => r.json()).catch((e) => ({ e: e.message }));
  console.log(`CoinGecko ${id}: symbol=${d.symbol} base=${d.platforms?.base ?? d.detail_platforms?.base?.contract_address ?? "?"}`);
}
