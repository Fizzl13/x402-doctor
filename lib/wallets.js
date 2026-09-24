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
// - MetaMask can pay an EOA payout wallet, but Blockaid may warn (a note).

const { NETWORKS, familyOf } = require('./networks');

const WALLETS = [
  { name: 'MetaMask', families: ['evm'] },
  { name: 'Coinbase Wallet', families: ['evm'] },
  { name: 'Rabby', families: ['evm'] },
  { name: 'Phantom', families: ['evm', 'solana'], evmNetworks: ['eip155:8453', 'eip155:137'] },
  { name: 'Solflare', families: ['solana'] },
  { name: 'Backpack', families: ['solana'] },
  { name: 'x402 agents', families: ['evm', 'solana'], agent: true },
];

const networkName = (network) => NETWORKS[network]?.name || network;

// Why nobody can pay option i, or null when it is payable.
function optionProblem(i, option, checks) {
  const prefix = `accepts[${i}]`;
  if (checks.some((c) => c.status === 'fail' && (c.id === prefix || c.id.startsWith(`${prefix}-`)))) return 'the option has errors (see above)';
  if (checks.some((c) => c.id === 'solana-payout-account' && c.status === 'fail' && c.option === i)) return 'the payout wallet has no USDC account';
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
    for (const o of options) {
      if (!wallet.families.includes(o.family)) continue;
      if (o.family === 'evm' && wallet.evmNetworks && !wallet.evmNetworks.includes(o.option.network)) continue;
      const label = o.testnet ? `${o.name} (testnet)` : o.name;
      if (o.problem) no.push({ network: label, reason: o.problem });
      else if (o.family === 'solana' && o.phantomBlocked && wallet.name === 'Phantom') no.push({ network: label, reason: 'PayAI rejects Phantom transactions' });
      else {
        if (!yes.includes(label)) yes.push(label);
        if (o.eoaPayTo && wallet.name === 'MetaMask') notes.push(`${label}: may show a Blockaid "deceptive request" warning (payout wallet is an EOA)`);
      }
    }
    if (yes.length || no.length) wallets.push({ wallet: wallet.name, agent: Boolean(wallet.agent), yes, no, ...(notes.length ? { notes } : {}) });
  }
  return wallets;
}

function summaryCheck(accepts, wallets) {
  const families = new Set((Array.isArray(accepts) ? accepts : []).map((a) => familyOf(a?.network)).filter(Boolean));
  const parts = wallets.map((w) => {
    const bits = [...w.yes.map((n) => `✓ ${n}`), ...w.no.map((n) => `✗ ${n.network}`)];
    return `${w.wallet} ${bits.join(', ')}${w.notes ? ' (may warn)' : ''}`;
  });
  const nobody = wallets.length > 0 && wallets.every((w) => w.yes.length === 0);
  const missing = [];
  if (!families.has('evm')) missing.push('a Base option would reach MetaMask, Coinbase Wallet and Rabby users');
  if (!families.has('solana')) missing.push('a Solana option would reach Solflare and Backpack users');
  return {
    id: 'wallets',
    group: 'wallets',
    status: 'info',
    message: wallets.length === 0 ? 'No payment option that a known wallet can use.' : nobody ? `Nobody can pay yet: ${parts.join(' · ')}` : `Who can pay: ${parts.join(' · ')}`,
    ...(missing.length ? { hint: `To reach more buyers: ${missing.join('; ')}.` } : {}),
  };
}

module.exports = { walletCompatibility, summaryCheck, WALLETS };
