// A self-hosted x402 facilitator for Solana (verify + settle in this process), the same one Ichimoku Signal runs
// (ichimoku-signal solana-facilitator.js), so that payments signed in Phantom settle too. Phantom puts Lighthouse
// instructions around the transfer; PayAI refuses that layout. The x402 reference facilitator has a "smart wallet"
// path that simulates such a transaction and checks the USDC really reaches payTo; the Token programs and
// Lighthouse are on its allow-list here. Phantom's Lighthouse asserts on the fee payer are let through
// (PhantomAwareExactSvmScheme), which is why @x402/svm is pinned exactly: the class overrides an internal method.
//
// The fee payer pays Solana's network fee (~0.000005 SOL a payment) and receives nothing; the money goes from the
// buyer to the seller's payTo. lib/facilitator-service.js puts credits, a free tier and the sanctions screen in front.
'use strict';

const { x402Facilitator } = require('@x402/core/facilitator');
const { ExactSvmScheme } = require('@x402/svm/exact/facilitator');
const { toFacilitatorSvmSigner, verifySmartWalletTransaction } = require('@x402/svm');
const {
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  getBase58Encoder,
  getBase64Encoder,
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
  decompileTransactionMessage,
} = require('@solana/kit');

const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const LIGHTHOUSE_PROGRAM = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

// Lighthouse instructions: 0 = MemoryWrite, 1 = MemoryClose (they write, and could charge a payer); 2..17 are the
// Assert* instructions, which only read and make the transaction fail when a check doesn't hold.
const LIGHTHOUSE_FIRST_ASSERT = 2;
const LIGHTHOUSE_LAST_ASSERT = 17;
const NOT_ISOLATED = 'invalid_exact_svm_smart_wallet_fee_payer_not_isolated';
const FEE_PAYER_TRANSFERRING = 'invalid_exact_svm_payload_transaction_fee_payer_transferring_funds';

// Phantom asserts on every writable account, the fee payer included (it must still hold enough SOL afterwards).
// The library refuses any instruction that names the fee payer. An assert can't take anything from it, so those are
// allowed: the fee payer may appear in Lighthouse asserts and nowhere else.
function feePayerOnlyInLighthouseAsserts(instructions, feePayer) {
  for (const ix of instructions) {
    const program = ix.programAddress.toString();
    if (program === feePayer) return false;
    const touches = (ix.accounts ?? []).some((a) => a.address.toString() === feePayer);
    if (!touches) continue;
    const kind = ix.data?.[0];
    const isAssert = program === LIGHTHOUSE_PROGRAM && kind >= LIGHTHOUSE_FIRST_ASSERT && kind <= LIGHTHOUSE_LAST_ASSERT;
    if (!isAssert) return false;
  }
  return true;
}

// ExactSvmScheme with one exception to fee payer isolation (above). Every other check (signatures, our fee payer,
// program allow-list, compute limits, simulation, amount/mint/receiver, the fee payer pays nothing) stays the
// library's. settle() uses _verify too, so the exception holds for both.
class PhantomAwareExactSvmScheme extends ExactSvmScheme {
  constructor(signer, unused, options) {
    super(signer, unused, options);
    this.phantomSigner = signer;
    this.phantomOptions = options;
  }

  async _verify(payload, requirements) {
    const result = await super._verify(payload, requirements);
    const reason = result.response?.invalidReason;
    if (result.response?.isValid || typeof reason !== 'string') return result;
    // Up to @x402/svm 2.29 the smart-wallet path refused Phantom's asserts as NOT_ISOLATED naming Lighthouse; from
    // 2.31 the static path, which allows Lighthouse guards itself, refuses a guard naming the fee payer as
    // "fee payer transferring funds". The checks below decide in both cases.
    const lighthouseNotIsolated = reason.startsWith(NOT_ISOLATED) && reason.includes(`(program: ${LIGHTHOUSE_PROGRAM})`);
    if (!lighthouseNotIsolated && reason !== FEE_PAYER_TRANSFERRING) return result;

    const transactionBase64 = payload.payload.transaction;
    const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(transactionBase64));
    const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    if ((compiled.addressTableLookups ?? []).length > 0) return result;
    const decompiled = decompileTransactionMessage(compiled);
    const feePayer = requirements.extra.feePayer;
    const instructions = decompiled.instructions ?? [];
    if (!feePayerOnlyInLighthouseAsserts(instructions, feePayer)) return result;
    // The 2.31 reason also covers a transfer that moves the fee payer's own funds: only step in when a Lighthouse
    // instruction names the fee payer (the check above already rules out every other use of it).
    const lighthouseTouchesFeePayer = instructions.some(
      (ix) => ix.programAddress.toString() === LIGHTHOUSE_PROGRAM && (ix.accounts ?? []).some((a) => a.address.toString() === feePayer),
    );
    if (!lighthouseTouchesFeePayer) return result;

    // The library's smart-wallet verification without the Lighthouse asserts (they hold no transfers); the
    // simulation runs on the whole, unchanged transaction.
    const withoutLighthouse = instructions.filter((ix) => ix.programAddress.toString() !== LIGHTHOUSE_PROGRAM);
    const signerAddresses = this.phantomSigner.getAddresses().map(String);
    const { matchedTransfer, ...response } = await verifySmartWalletTransaction(
      transactionBase64,
      requirements,
      this.phantomSigner,
      feePayer,
      signerAddresses,
      {
        enabled: true,
        maxComputeUnits: this.phantomOptions?.smartWalletMaxComputeUnits,
        maxPriorityFeeMicroLamports: this.phantomOptions?.smartWalletMaxPriorityFeeMicroLamports,
      },
      {
        transaction,
        compiled,
        decompiled: { ...decompiled, instructions: withoutLighthouse },
        resolvedAccountKeys: compiled.staticAccounts.map(String),
      },
    );
    return { response, verificationPath: response.isValid ? 'smartWallet' : null, matchedTransfer };
  }
}

// A base58 secret key (a Phantom/Solflare export) or a Solana CLI keypair as a JSON array of 64 bytes.
function parseSecretKey(value) {
  const trimmed = String(value).trim();
  const bytes = trimmed.startsWith('[') ? Uint8Array.from(JSON.parse(trimmed)) : getBase58Encoder().encode(trimmed);
  if (bytes.length !== 64) throw new Error(`the Solana fee payer key must be a 64-byte keypair, got ${bytes.length} bytes`);
  return bytes;
}

// After settling, the smart-wallet path checks on chain that the USDC arrived, but only in innerInstructions
// (transfers by CPI). With Phantom the transfer is a top-level instruction, so mainnet gives an empty list and the
// library reports post_settlement_transfer_not_confirmed although the payment went through. The confirmed
// transaction's top-level instructions are added as one more group, parsed the same way (jsonParsed transferChecked).
function withTopLevelTransfers(signer, rpcUrl) {
  const rpc = createSolanaRpc(rpcUrl);
  return {
    ...signer,
    async getConfirmedTransactionInnerInstructions(signature) {
      const result = await rpc
        .getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 1, encoding: 'jsonParsed' })
        .send();
      if (!result) return null;
      const inner = result.meta?.innerInstructions ?? [];
      const topLevel = result.transaction?.message?.instructions ?? [];
      return { innerInstructions: [...inner, { index: -1, instructions: topLevel }] };
    },
  };
}

// A FacilitatorClient (getSupported/verify/settle) plus the fee payer's address. The keypair loads async.
function createSolanaFacilitator({ privateKey, rpcUrl, network = SOLANA_MAINNET, log = console }) {
  const ready = (async () => {
    const signer = await createKeyPairSignerFromBytes(parseSecretKey(privateKey));
    const facilitatorSigner = withTopLevelTransfers(toFacilitatorSvmSigner(signer, { defaultRpcUrl: rpcUrl }), rpcUrl);
    const scheme = new PhantomAwareExactSvmScheme(facilitatorSigner, undefined, {
      enableSmartWalletVerification: true,
      smartWalletAllowedPrograms: [LIGHTHOUSE_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM],
    });
    log.log(`[facilitator] Solana facilitator on, fee payer ${signer.address}`);
    return { facilitator: new x402Facilitator().register(network, scheme), feePayer: String(signer.address) };
  })();
  // No unhandled rejection for a bad key; the error comes up again on the first call.
  ready.catch((err) => log.error('[facilitator] Solana facilitator does not start:', err.message));
  return {
    network,
    feePayer: async () => (await ready).feePayer,
    async getSupported() { return (await ready).facilitator.getSupported(); },
    async verify(paymentPayload, paymentRequirements) { return (await ready).facilitator.verify(paymentPayload, paymentRequirements); },
    async settle(paymentPayload, paymentRequirements) { return (await ready).facilitator.settle(paymentPayload, paymentRequirements); },
  };
}

module.exports = { createSolanaFacilitator, parseSecretKey, feePayerOnlyInLighthouseAsserts, SOLANA_MAINNET, LIGHTHOUSE_PROGRAM };
