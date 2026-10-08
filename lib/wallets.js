// Which wallets can actually pay an endpoint, worked out from the payment
// options and the checks that already ran. The rules only claim what the
// doctor has seen fail or succeed:
//
// - an option with a failed check (bad payTo, missing EIP-712 domain or fee
//   payer, ...) cannot be paid by anyone;
// - a Solana option whose payout wallet has no token account fails on-chain;
// - PayAI, as the Solana facilitator, rejects Phantom (Lighthouse
//   instructions), while Solflare, Backpack and x402 agents settle fine;
// - EVM browser wallets sign the EIP-3009 authorization on any EVM network;
//   Phantom's EVM side covers Base and Polygon;
// - MetaMask can pay an EOA payout wallet, but Blockaid may warn (a note);
// - an Algorand option whose payout address has not opted in to the asset fails;
//   Pera and Defly (and x402 agents with an AVM client) pay Algorand options;
// - an XRPL option whose payout account is missing, refuses payments or lacks the token's trust line fails;
//   Xaman, Crossmark and GemWallet (and x402 agents with an XRPL client) pay XRPL options;
// - an option with a custom scheme (not exact/upto) needs a client built for
//   it, so no standard wallet or x402 agent is counted as able to pay it.
// - a Lightning (lnbtc) option is paid by x402 agents with a Lightning node that returns the preimage (the
//   x402 SDKs had no Lightning client yet in Oct 2026); an invoice that doesn't match the option fails.
// - an "upto" option is paid with a Permit2 signature, not EIP-3009: browser
//   wallets (through the x402 paywall) can't pay it; x402 agents can, with an
//   upto client and a Permit2 approval for the token (a note).

const { NETWORKS, familyOf } = require('./networks');

const WALLETS = [
  { name: 'MetaMask', families: ['evm'] },
  { name: 'Coinbase Wallet', families: ['evm'] },
  { name: 'Rabby', families: ['evm'] },
  { name: 'Phantom', families: ['evm', 'solana'], evmNetworks: ['eip155:8453', 'eip155:137'] },
  { name: 'Solflare', families: ['solana'] },
  { name: 'Backpack', families: ['solana'] },
  { name: 'Pera', families: ['algorand'] },
  { name: 'Defly', families: ['algorand'] },
  { name: 'Xaman', families: ['xrpl'] },
  { name: 'Crossmark', families: ['xrpl'] },
  { name: 'GemWallet', families: ['xrpl'] },
  { name: 'x402 agents', families: ['evm', 'solana', 'algorand', 'xrpl'], agent: true },
  { name: 'x402 Lightning agents', families: ['lightning'], agent: true },
];

const networkName = (network) => NETWORKS[network]?.name || network;

// Why nobody can pay option i, or null when it is payable.
function optionProblem(i, option, checks) {
  const prefix = `accepts[${i}]`;
  if (checks.some((c) => c.status === 'fail' && (c.id === prefix || c.id.startsWith(`${prefix}-`)))) return 'the option has errors (see above)';
  if (checks.some((c) => c.id === 'solana-payout-account' && c.status === 'fail' && c.option === i)) return 'the payout wallet has no USDC account';
  if (checks.some((c) => c.id === 'algorand-payout-optin' && c.status === 'fail' && c.option === i)) return 'the payout address has not opted in to the asset';
  if (checks.some((c) => c.id === 'xrpl-payout-account' && c.status === 'fail' && c.option === i)) return 'the payout account cannot receive payments';
  if (checks.some((c) => c.id === 'xrpl-payout-trustline' && c.status === 'fail' && c.option === i)) return 'the payout account has no trust line for the token';
  if (checks.some((c) => (c.id === 'lightning-invoice' || c.id === 'lightning-request-hash') && c.status === 'fail' && c.option === i)) return 'the Lightning invoice does not match the option or the request';
  if (option && option.scheme !== undefined && option.scheme !== 'exact' && option.scheme !== 'upto') return `custom scheme "${option.scheme}": standard x402 clients and wallets pay "exact"`;
  if (!option || !familyOf(option.network)) return 'unknown network';
  return null;
}

function walletCompatibility(accepts, checks) {
  const options = (Array.isArray(accepts) ? accepts : []).map((option, i) => ({
    i,
    option,
    family: familyOf(option?.network),
    name: networkName(option?.network),
    testnet: Boolean(NETWORKS[option?.network]?.testnet),
    problem: optionProblem(i, option, checks),
    phantomBlocked: checks.some((c) => c.id === 'solana-wallets' && c.status === 'warn' && c.option === i),
    eoaPayTo: checks.some((c) => c.id === 'evm-payto-eoa' && c.option === i),
  }));

  const wallets = [];
  for (const wallet of WALLETS) {
    const yes = [];
    const no = [];
    const notes = [];
    const needs = [];
    for (const o of options) {
      if (!wallet.families.includes(o.family)) continue;
      if (o.family === 'evm' && wallet.evmNetworks && !wallet.evmNetworks.includes(o.option.network)) continue;
      const label = o.testnet ? `${o.name} (testnet)` : o.name;
      if (o.problem) no.push({ network: label, reason: o.problem });
      else if (o.option.scheme === 'upto' && !wallet.agent) no.push({ network: label, reason: '"upto" is paid with a Permit2 signature; the browser paywall signs EIP-3009 (exact) only' });
      else if (o.family === 'solana' && o.phantomBlocked && wallet.name === 'Phantom') no.push({ network: label, reason: 'PayAI rejects Phantom transactions' });
      else {
        if (!yes.includes(label)) yes.push(label);
        if (o.eoaPayTo && wallet.name === 'MetaMask') notes.push(`${label}: may show a Blockaid "deceptive request" warning (payout wallet is an EOA)`);
        if (o.option.scheme === 'upto' && wallet.agent) needs.push(`${label}: "upto" needs an x402 upto client${o.family === 'evm' ? ' and a Permit2 approval for the token' : ''}`);
      }
    }
    if (yes.length || no.length) wallets.push({ wallet: wallet.name, agent: Boolean(wallet.agent), yes, no, ...(notes.length ? { notes } : {}), ...(needs.length ? { needs } : {}) });
  }
  return wallets;
}

function summaryCheck(accepts, wallets) {
  const families = new Set((Array.isArray(accepts) ? accepts : []).map((a) => familyOf(a?.network)).filter(Boolean));
  const parts = wallets.map((w) => {
    const bits = [...w.yes.map((n) => `✓ ${n}`), ...w.no.map((n) => `✗ ${n.network}`)];
    return `${w.wallet} ${bits.join(', ')}${w.notes ? ' (may warn)' : ''}${w.needs ? ' (with an upto client)' : ''}`;
  });
  const nobody = wallets.length > 0 && wallets.every((w) => w.yes.length === 0);
  // Every option uses a custom scheme: not broken, just not for standard clients.
  const schemes = (Array.isArray(accepts) ? accepts : []).map((a) => a?.scheme);
  const custom = nobody && schemes.length && schemes.every((x) => x !== undefined && x !== 'exact' && x !== 'upto') ? [...new Set(schemes)] : [];
  const missing = [];
  if (!families.has('evm')) missing.push('a Base option would reach MetaMask, Coinbase Wallet and Rabby users');
  if (!families.has('solana')) missing.push('a Solana option would reach Solflare and Backpack users');
  return {
    id: 'wallets',
    group: 'wallets',
    status: 'info',
    message: wallets.length === 0 ? 'No payment option that a known wallet can use.'
      : custom.length ? `Only clients built for the ${custom.map((c) => `"${c}"`).join(', ')} scheme can pay: no standard wallet or x402 agent pays it.`
      : nobody ? `Nobody can pay yet: ${parts.join(' · ')}` : `Who can pay: ${parts.join(' · ')}`,
    ...(custom.length ? { hint: 'Add an "exact" option next to it to reach standard x402 agents and wallets.' } : missing.length ? { hint: `To reach more buyers: ${missing.join('; ')}.` } : {}),
  };
}

module.exports = { walletCompatibility, summaryCheck, WALLETS };
