// Walk from a signed receipt to its on-chain payment, as an outsider would: USDC's
// AuthorizationUsed(payer, nonce) event on Base, then the transfer in the same tx. Free, read-only.
const RPC = "https://mainnet.base.org";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const AUTH_USED = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5"; // AuthorizationUsed(address,bytes32)
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const rpc = async (method, params) => (await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json());
const pad = (a) => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const payer = "0x0fD3D46E688855B24536df33BBa3dFa35b67445C";
const head = parseInt((await rpc("eth_blockNumber", [])).result, 16);
for (const [what, nonce] of [["presign-guard /v1/token", "0xd2d2e9502829e514ce7804e8202d71d7e29a4e4711e4b283936945f2648dfc40"], ["x402 Doctor preflight", "0x254637d79cbcb3631c70fb04093bd0fc6b7226ad12ccdcd04fd346be9dedea1a"]]) {
  let found = null;
  for (let to = head; to > head - 3000 && !found; to -= 500) {
    const r = await rpc("eth_getLogs", [{ address: USDC, fromBlock: "0x" + (to - 499).toString(16), toBlock: "0x" + to.toString(16), topics: [AUTH_USED, pad(payer), nonce] }]);
    if (r.error) { console.log(what, "rpc error", r.error.message); break; }
    if (r.result.length) found = r.result[0];
  }
  if (!found) { console.log(`${what}: nonce not found in the last 3000 blocks`); continue; }
  const rc = (await rpc("eth_getTransactionReceipt", [found.transactionHash])).result;
  const t = rc.logs.find((l) => l.address.toLowerCase() === USDC.toLowerCase() && l.topics[0] === TRANSFER);
  console.log(`${what}: AuthorizationUsed in tx ${found.transactionHash} (block ${parseInt(found.blockNumber, 16)}); transfer ${parseInt(t.data, 16)} base units from 0x${t.topics[1].slice(26)} to 0x${t.topics[2].slice(26)}`);
}
