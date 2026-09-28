// GoPlus control fields for the TAT pilot tokens: does GoPlus see pause / blacklist powers?
const T = {
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', cbBTC: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
  EURC: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42', cbETH: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22',
  DEGEN: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', WELL: '0xA88594D404727625A9437C3f886C7643872296AE',
  VIRTUAL: '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b', DAI: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
  wstETH: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452', MORPHO: '0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842',
  USDT0: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
};
const F = ['is_proxy', 'is_blacklisted', 'is_whitelisted', 'transfer_pausable', 'is_mintable', 'owner_address', 'owner_change_balance', 'hidden_owner', 'trust_list', 'is_open_source', 'external_call', 'personal_slippage_modifiable', 'is_anti_whale'];
for (const [sym, a] of Object.entries(T)) {
  const r = await fetch(`https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${a}`).then((x) => x.json()).catch((e) => ({ err: e.message }));
  const t = r.result ? Object.values(r.result)[0] || {} : {};
  console.log(sym, r.code, JSON.stringify(Object.fromEntries(F.map((k) => [k, t[k]]))));
  await new Promise((s) => setTimeout(s, 2500));
}
