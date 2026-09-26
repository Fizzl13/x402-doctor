// Account 3 (test payer) balance on Base: USDC and ETH, plus its latest incoming USDC transfers. Read-only.
const RPC = "https://mainnet.base.org";
const ADDR = "0x0fD3D46E688855B24536df33BBa3dFa35b67445C";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const rpc = async (method, params) => (await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()).result;
const pad = ADDR.slice(2).toLowerCase().padStart(64, "0");
const usdc = BigInt(await rpc("eth_call", [{ to: USDC, data: "0x70a08231" + pad }, "latest"]));
const eth = BigInt(await rpc("eth_getBalance", [ADDR, "latest"]));
console.log(`USDC: ${(Number(usdc) / 1e6).toFixed(6)}  ETH: ${(Number(eth) / 1e18).toFixed(8)}`);
// Incoming USDC transfers in the last ~2 hours (Transfer(from, to=ADDR)).
const head = Number(await rpc("eth_blockNumber", []));
const logs = await rpc("eth_getLogs", [{ address: USDC, fromBlock: "0x" + (head - 3600).toString(16), toBlock: "latest",
  topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", null, "0x" + pad] }]);
for (const l of logs || []) console.log(`in: ${(Number(BigInt(l.data)) / 1e6).toFixed(6)} USDC from 0x${l.topics[1].slice(26)} tx ${l.transactionHash} block ${Number(l.blockNumber)}`);
console.log(`incoming transfers in the last ~2h: ${(logs || []).length}`);
