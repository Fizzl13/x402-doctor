// Is DEGEN on Base (0x4ed4…efed) a proxy? Read the EIP-1967 / EIP-1822 slots and the bytecode size,
// and compare GoPlus token_security vs approval_security. Free, read-only.
const RPC = "https://mainnet.base.org";
const T = "0x4ed4e862860bed51a9570b96d89af5e1b0efefed";
const rpc = async (method, params) => (await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()).result;
const slots = {
  "EIP-1967 implementation": "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  "EIP-1967 admin": "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  "EIP-1967 beacon": "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
  "EIP-1822 (UUPS) proxiable": "0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7",
};
const code = await rpc("eth_getCode", [T, "latest"]);
console.log("bytecode bytes:", (code.length - 2) / 2, "delegatecall opcode (0xf4) present:", /f4/.test(code.slice(2)));
for (const [k, s] of Object.entries(slots)) console.log(k, await rpc("eth_getStorageAt", [T, s, "latest"]));
const g1 = await (await fetch(`https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${T}`)).json();
const t = g1.result?.[T] || {};
console.log("GoPlus token_security:", JSON.stringify({ is_proxy: t.is_proxy, is_mintable: t.is_mintable, is_open_source: t.is_open_source, owner_address: t.owner_address, token_name: t.token_name }));
const g2 = await (await fetch(`https://api.gopluslabs.io/api/v2/approval_security/8453?contract_addresses=${T}`)).json().catch(() => ({}));
const g2b = await (await fetch(`https://api.gopluslabs.io/api/v1/approval_security/8453?contract_addresses=${T}`)).json().catch(() => ({}));
const pick = (g) => { const r = g.result || {}; const v = r[T] || r; return JSON.stringify({ is_proxy: v.is_proxy, is_contract: v.is_contract, is_open_source: v.is_open_source, contract_name: v.contract_name, tag: v.tag }); };
console.log("GoPlus approval_security v1:", pick(g2b));
