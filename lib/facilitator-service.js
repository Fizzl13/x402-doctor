// x402 Doctor as an x402 facilitator for Solana, open to any seller: POST /facilitator/verify and
// /facilitator/settle take the standard x402 v2 bodies, so a seller points its x402 resource server at
// https://x402-doctor.fizzl.eu/facilitator (HTTPFacilitatorClient) and nothing else changes.
//
// What it adds over the free facilitators:
// - payments signed in Phantom settle too (lib/solana-facilitator.js);
// - every settle screens the payer and the payTo against the OFAC SDN list first (lib/sanctions.js), and refuses
//   when either is listed or the list can't be read: no payment to or from a sanctioned address goes through us.
//
// What a settle costs the seller: the first FREE_PER_DAY settles per payTo per UTC day are free; after that one
// Doctor credit ($0.001) each, from a prepaid credit key (the same packs as the paid checks, /api/v1/credits) sent as
// x-credit-key or "Authorization: Bearer <key>". /verify and /supported are free. A settle that fails gives its
// credit (or free settle) back. DAILY_MAX bounds the network fees our fee payer pays in a day, whoever pays.
//
// Off unless SOLANA_FACILITATOR_KEY is set (a fresh keypair holding a little SOL, never a wallet with other funds).
'use strict';

const credits = require('./credits');
const { createSolanaFacilitator, SOLANA_MAINNET } = require('./solana-facilitator');

const BASE_PATH = '/facilitator';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SETTLE_CREDITS = 1;
const FREE_PER_DAY = 20;
const DAILY_MAX = 1000;
const VERIFY_PER_MINUTE = 60;
const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

function creditKeyOf(req) {
  const header = req.get(credits.CREDIT_HEADER);
  if (header) return header.trim();
  const auth = req.get('authorization') || '';
  const m = /^Bearer\s+(\S+)$/i.exec(auth);
  return m ? m[1] : null;
}

// The x402 v2 body a resource server sends: { x402Version, paymentPayload, paymentRequirements }.
function readBody(body) {
  const payload = body?.paymentPayload;
  const req = body?.paymentRequirements;
  if (!payload || typeof payload !== 'object' || !req || typeof req !== 'object') {
    return { error: 'invalid_request', message: 'Send { x402Version, paymentPayload, paymentRequirements } as JSON (x402 v2).' };
  }
  if (req.network !== SOLANA_MAINNET) return { error: 'unsupported_network', message: `Only ${SOLANA_MAINNET} (Solana mainnet) is served here.` };
  if (req.scheme !== 'exact') return { error: 'unsupported_scheme', message: 'Only the "exact" scheme is served.' };
  if (req.asset !== USDC_MINT) return { error: 'unsupported_asset', message: `Only USDC (${USDC_MINT}) is served.` };
  if (typeof req.payTo !== 'string' || !req.payTo) return { error: 'invalid_request', message: 'paymentRequirements.payTo is missing.' };
  return { payload, requirements: req };
}

function createFacilitatorService({
  env = process.env,
  sanctions,
  creditStore = null,
  core = null,
  now = () => Date.now(),
  freePerDay = Number(env.FACILITATOR_FREE_PER_DAY ?? FREE_PER_DAY),
  dailyMax = Number(env.FACILITATOR_DAILY_MAX ?? DAILY_MAX),
  publicUrl = 'https://x402-doctor.fizzl.eu',
  log = console,
} = {}) {
  const key = env.SOLANA_FACILITATOR_KEY?.trim();
  const facilitator = core || (key ? createSolanaFacilitator({ privateKey: key, rpcUrl: env.SOLANA_FACILITATOR_RPC_URL || env.SOLANA_RPC_URL || PUBLIC_RPC, log }) : null);
  const enabled = Boolean(facilitator);

  // Counters for one UTC day (in memory: a restart gives a few extra free settles, never more fees than DAILY_MAX twice).
  let day = dayOf(now());
  let settled = 0;
  let refused = 0;
  const freeUsed = new Map();
  const verifyHits = new Map();
  const roll = () => {
    const d = dayOf(now());
    if (d !== day) { day = d; settled = 0; refused = 0; freeUsed.clear(); }
  };

  function verifyAllowed(ip) {
    const minute = Math.floor(now() / 60000);
    const k = `${ip}|${minute}`;
    const n = (verifyHits.get(k) || 0) + 1;
    verifyHits.set(k, n);
    if (verifyHits.size > 5000) for (const old of verifyHits.keys()) if (!old.endsWith(`|${minute}`)) verifyHits.delete(old);
    return n <= VERIFY_PER_MINUTE;
  }

  // The OFAC screen: { ok } or { ok: false, reason, message }. Fails closed when the list can't be read.
  async function screen(addresses) {
    if (!sanctions?.enabled) return { ok: false, reason: 'sanctions_screen_unavailable', message: 'The sanctions screen is off, so nothing is settled.' };
    const list = await sanctions.ready().catch(() => null);
    if (!list) return { ok: false, reason: 'sanctions_screen_unavailable', message: 'The OFAC SDN list could not be read just now; try again in a minute.' };
    for (const a of addresses.filter(Boolean)) {
      if (sanctions.check(a)?.listed) return { ok: false, reason: 'sanctioned_address', message: `${a} is on the OFAC SDN sanctions list.` };
    }
    return { ok: true };
  }

  // Who pays for this settle: a credit key, else the payTo's free settles of the day. { ok, charge, refund } or a refusal.
  async function charge(req, payTo) {
    const k = creditKeyOf(req);
    if (k) {
      if (!credits.isKey(k)) return { ok: false, status: 402, reason: 'facilitator_invalid_credit_key', message: 'The credit key is not an x402 Doctor credit key.' };
      if (!creditStore) return { ok: false, status: 503, reason: 'facilitator_credits_unavailable', message: 'Credits are not available right now.' };
      const hash = credits.hashKey(k);
      let taken;
      try { taken = await creditStore.take(hash, SETTLE_CREDITS); } catch { return { ok: false, status: 503, reason: 'facilitator_credits_unavailable', message: 'Credits are not available right now.' }; }
      if (!taken.ok) return { ok: false, status: 402, reason: `facilitator_credits_${taken.reason}`, message: taken.reason === 'insufficient' ? 'No credits left on this key.' : 'No credits for this key.' };
      return { ok: true, via: 'credits', remaining: taken.credits, refund: () => creditStore.refund(hash, SETTLE_CREDITS).catch(() => {}) };
    }
    const used = freeUsed.get(payTo) || 0;
    if (used >= freePerDay) {
      return { ok: false, status: 402, reason: 'facilitator_payment_required', message: `This payTo used its ${freePerDay} free settles today. Send a prepaid credit key (x-credit-key or Authorization: Bearer); 1 credit ($0.001) a settle, 1000 credits for $0.80 at ${publicUrl}${credits.PACK_ROUTE}/1000.` };
    }
    freeUsed.set(payTo, used + 1);
    return { ok: true, via: 'free', remaining: freePerDay - used - 1, refund: () => { freeUsed.set(payTo, Math.max(0, (freeUsed.get(payTo) || 1) - 1)); } };
  }

  const info = async () => ({
    what: 'An x402 facilitator for Solana mainnet (USDC, scheme exact), by x402 Doctor. It also settles payments signed in Phantom, and screens payer and payTo against the OFAC SDN list before every settle.',
    enabled,
    network: SOLANA_MAINNET,
    asset: USDC_MINT,
    fee_payer: enabled ? await facilitator.feePayer().catch(() => null) : null,
    url: `${publicUrl}${BASE_PATH}`,
    endpoints: { supported: `GET ${BASE_PATH}/supported`, verify: `POST ${BASE_PATH}/verify`, settle: `POST ${BASE_PATH}/settle` },
    pricing: {
      verify: 'free',
      settle: `${freePerDay} free a day per payTo, then ${SETTLE_CREDITS} credit ($0.001) each`,
      credits: `${publicUrl}${credits.PACK_ROUTE}`,
      credit_header: `${credits.CREDIT_HEADER} or Authorization: Bearer <credit key>`,
    },
    how_to_use: 'new HTTPFacilitatorClient({ url: "' + `${publicUrl}${BASE_PATH}` + '", createAuthHeaders: async () => ({ settle: { "x-credit-key": process.env.DOCTOR_CREDIT_KEY } }) }) in your x402 resource server; the Solana option in your 402 names this fee_payer as extra.feePayer (the library fills it from /supported).',
    today: { day, settled, refused, daily_max: dailyMax },
  });

  function router(express) {
    const r = express.Router();
    r.get(BASE_PATH, async (req, res) => res.json(await info()));
    r.get(`${BASE_PATH}/health`, async (req, res) => { roll(); res.json({ ok: enabled, ...(await info()).today }); });
    r.use(BASE_PATH, (req, res, next) => (enabled ? next() : res.status(503).json({ error: 'facilitator_off', message: 'The Solana facilitator is not switched on here.' })));
    r.get(`${BASE_PATH}/supported`, async (req, res) => {
      try { res.json(await facilitator.getSupported()); } catch (err) { res.status(503).json({ error: 'facilitator_unavailable', message: err.message }); }
    });
    r.post(`${BASE_PATH}/verify`, express.json({ limit: '64kb' }), async (req, res) => {
      if (!verifyAllowed(req.ip)) return res.status(429).json({ isValid: false, invalidReason: 'rate_limited', invalidMessage: `At most ${VERIFY_PER_MINUTE} verifies a minute.` });
      const body = readBody(req.body);
      if (body.error) return res.status(400).json({ isValid: false, invalidReason: body.error, invalidMessage: body.message });
      const sc = await screen([body.requirements.payTo]);
      if (!sc.ok) return res.json({ isValid: false, invalidReason: sc.reason, invalidMessage: sc.message });
      try {
        const out = await facilitator.verify(body.payload, body.requirements);
        if (out?.isValid && out.payer) {
          const sp = await screen([out.payer]);
          if (!sp.ok) return res.json({ isValid: false, invalidReason: sp.reason, invalidMessage: sp.message, payer: out.payer });
        }
        res.json(out);
      } catch (err) {
        res.status(500).json({ isValid: false, invalidReason: 'unexpected_verify_error', invalidMessage: String(err.message).slice(0, 300) });
      }
    });
    r.post(`${BASE_PATH}/settle`, express.json({ limit: '64kb' }), async (req, res) => {
      roll();
      const fail = (status, errorReason, errorMessage, extra = {}) => {
        refused++;
        res.status(status).json({ success: false, errorReason, errorMessage, transaction: '', network: SOLANA_MAINNET, ...extra });
      };
      const body = readBody(req.body);
      if (body.error) return fail(400, body.error, body.message);
      if (settled >= dailyMax) return fail(503, 'facilitator_daily_limit', 'The facilitator settled its daily maximum; try again after 00:00 UTC.');
      const paid = await charge(req, body.requirements.payTo);
      if (!paid.ok) return fail(paid.status, paid.reason, paid.message);
      res.set('x-facilitator-billing', paid.via);
      res.set('x-facilitator-remaining', String(paid.remaining));
      try {
        const sc = await screen([body.requirements.payTo]);
        if (!sc.ok) { await paid.refund(); return fail(200, sc.reason, sc.message); }
        const v = await facilitator.verify(body.payload, body.requirements);
        if (!v?.isValid) { await paid.refund(); return fail(200, v?.invalidReason || 'invalid_payment', v?.invalidMessage || 'The payment did not verify.', { payer: v?.payer }); }
        const sp = await screen([v.payer]);
        if (!sp.ok) { await paid.refund(); return fail(200, sp.reason, sp.message, { payer: v.payer }); }
        const out = await facilitator.settle(body.payload, body.requirements);
        if (!out?.success) { await paid.refund(); refused++; return res.json(out); }
        settled++;
        log.log(`[facilitator] settle ok via ${paid.via} payTo ${body.requirements.payTo} tx ${out.transaction}`);
        res.json(out);
      } catch (err) {
        await paid.refund();
        fail(500, 'unexpected_settle_error', String(err.message).slice(0, 300));
      }
    });
    return r;
  }

  return { enabled, router, info, status: () => { roll(); return { enabled, day, settled, refused, daily_max: dailyMax, free_per_day: freePerDay }; } };
}

module.exports = { createFacilitatorService, BASE_PATH, USDC_MINT, FREE_PER_DAY, DAILY_MAX, SETTLE_CREDITS, readBody, creditKeyOf };
