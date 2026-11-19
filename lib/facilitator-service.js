// x402 Doctor as an x402 facilitator for Solana and NEAR, open to any seller: POST /facilitator/verify and
// /facilitator/settle take the standard x402 v2 bodies, so a seller points its x402 resource server at
// https://x402-doctor.fizzl.eu/facilitator (HTTPFacilitatorClient) and nothing else changes.
//
// What it adds over the free facilitators:
// - payments signed in Phantom settle too (lib/solana-facilitator.js);
// - USDC on NEAR settles, our relayer paying the gas (lib/near-facilitator.js), behind the same OFAC screen;
// - every settle screens the payer and the payTo against the OFAC SDN list first (lib/sanctions.js), and refuses
//   when either is listed or the list can't be read: no payment to or from a sanctioned address goes through us.
// - each NEAR settle is reported to NEAR Builders Activity when ACTIVITY_API_KEY is set (lib/activity.js).
//
// What a settle costs the seller: the first free settles per payTo per UTC day are free (Solana 20, NEAR 5); after
// that Doctor credits ($0.001 each) from a prepaid credit key (the same packs as the paid checks, /api/v1/credits) sent
// as x-credit-key or "Authorization: Bearer <key>": 1 a Solana settle, 2 a NEAR settle (NEAR gas costs more than a
// Solana fee). /verify and /supported are free. A settle that fails gives its credit (or free settle) back. A daily
// maximum per network bounds the fees our fee payer and relayer pay in a day, whoever pays.
//
// Solana is off unless SOLANA_FACILITATOR_KEY is set (a fresh keypair holding a little SOL), NEAR unless
// NEAR_FACILITATOR_ACCOUNT and NEAR_FACILITATOR_KEY are (a dedicated account with a little NEAR for gas); never a
// wallet with other funds.
'use strict';

const credits = require('./credits');
const { createSolanaFacilitator, SOLANA_MAINNET } = require('./solana-facilitator');
const { createActivityReporter } = require('./activity');
const { createNearFacilitator, nearConfig, NEAR_MAINNET, NEAR_USDC } = require('./near-facilitator');

const BASE_PATH = '/facilitator';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SETTLE_CREDITS = 1;
const FREE_PER_DAY = 20;
const DAILY_MAX = 1000;
const NEAR_SETTLE_CREDITS = 2;
const NEAR_FREE_PER_DAY = 5;
const NEAR_DAILY_MAX = 200;
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

const NETWORK_NAMES = { [SOLANA_MAINNET]: 'Solana mainnet', [NEAR_MAINNET]: 'NEAR mainnet' };
const ASSETS = { [SOLANA_MAINNET]: USDC_MINT, [NEAR_MAINNET]: NEAR_USDC };

// The x402 v2 body a resource server sends: { x402Version, paymentPayload, paymentRequirements }. `networks`: the
// CAIP-2 ids served right now (Solana when called without).
function readBody(body, networks = [SOLANA_MAINNET]) {
  const payload = body?.paymentPayload;
  const req = body?.paymentRequirements;
  if (!payload || typeof payload !== 'object' || !req || typeof req !== 'object') {
    return { error: 'invalid_request', message: 'Send { x402Version, paymentPayload, paymentRequirements } as JSON (x402 v2).' };
  }
  if (!networks.includes(req.network)) return { error: 'unsupported_network', message: `Only ${networks.map((n) => `${n} (${NETWORK_NAMES[n]})`).join(' and ')} ${networks.length === 1 ? 'is' : 'are'} served here.` };
  if (req.scheme !== 'exact') return { error: 'unsupported_scheme', message: 'Only the "exact" scheme is served.' };
  if (req.asset !== ASSETS[req.network]) return { error: 'unsupported_asset', message: `Only USDC (${ASSETS[req.network]}) is served on ${NETWORK_NAMES[req.network]}.` };
  if (typeof req.payTo !== 'string' || !req.payTo) return { error: 'invalid_request', message: 'paymentRequirements.payTo is missing.' };
  return { payload, requirements: req };
}

function createFacilitatorService({
  env = process.env,
  sanctions,
  creditStore = null,
  core = null,
  nearCore = null,
  now = () => Date.now(),
  freePerDay = Number(env.FACILITATOR_FREE_PER_DAY ?? FREE_PER_DAY),
  dailyMax = Number(env.FACILITATOR_DAILY_MAX ?? DAILY_MAX),
  nearFreePerDay = Number(env.NEAR_FACILITATOR_FREE_PER_DAY ?? NEAR_FREE_PER_DAY),
  nearDailyMax = Number(env.NEAR_FACILITATOR_DAILY_MAX ?? NEAR_DAILY_MAX),
  publicUrl = 'https://x402-doctor.fizzl.eu',
  log = console,
  fetchImpl = globalThis.fetch,
  activity = createActivityReporter({ env, fetchImpl, log }),
} = {}) {
  const key = env.SOLANA_FACILITATOR_KEY?.trim();
  const rpcUrl = env.SOLANA_FACILITATOR_RPC_URL || env.SOLANA_RPC_URL || PUBLIC_RPC;
  const facilitator = core || (key ? createSolanaFacilitator({ privateKey: key, rpcUrl, log }) : null);
  let near = nearCore;
  if (!near) {
    // A malformed account id or key leaves NEAR off with a log line; it never stops Doctor from starting.
    try {
      const cfg = nearConfig(env);
      if (cfg) near = createNearFacilitator({ ...cfg, fetchImpl, now, log });
    } catch (err) { log.error(`[facilitator] NEAR facilitator off: ${err.message}`); }
  }
  // The networks served, each with its own price, free settles and daily maximum.
  const lanes = new Map();
  if (facilitator) lanes.set(SOLANA_MAINNET, { core: facilitator, credits: SETTLE_CREDITS, freePerDay, dailyMax, settled: 0, refused: 0 });
  if (near) lanes.set(NEAR_MAINNET, { core: near, credits: NEAR_SETTLE_CREDITS, freePerDay: nearFreePerDay, dailyMax: nearDailyMax, settled: 0, refused: 0 });
  const networks = [...lanes.keys()];
  const enabled = lanes.size > 0;

  // Counters for one UTC day (in memory: a restart gives a few extra free settles, never more fees than the daily
  // maximum twice).
  let day = dayOf(now());
  const freeUsed = new Map(); // "<network>|<payTo>" -> settles
  const verifyHits = new Map();
  const roll = () => {
    const d = dayOf(now());
    if (d !== day) { day = d; for (const l of lanes.values()) { l.settled = 0; l.refused = 0; } freeUsed.clear(); }
  };
  const total = (field) => [...lanes.values()].reduce((n, l) => n + l[field], 0);

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
  async function charge(req, payTo, lane, network) {
    const SETTLE_CREDITS = lane.credits;
    const freePerDay = lane.freePerDay;
    const k = creditKeyOf(req);
    if (k) {
      if (!credits.isKey(k)) return { ok: false, status: 402, reason: 'facilitator_invalid_credit_key', message: 'The credit key is not an x402 Doctor credit key.' };
      if (!creditStore) return { ok: false, status: 503, reason: 'facilitator_credits_unavailable', message: 'Credits are not available right now.' };
      const hash = credits.hashKey(k);
      let taken;
      try { taken = await creditStore.take(hash, SETTLE_CREDITS); } catch { return { ok: false, status: 503, reason: 'facilitator_credits_unavailable', message: 'Credits are not available right now.' }; }
      if (!taken.ok) return { ok: false, status: 402, reason: `facilitator_credits_${taken.reason}`, message: taken.reason === 'insufficient' ? `Too few credits left on this key (a settle on ${NETWORK_NAMES[network]} takes ${SETTLE_CREDITS}).` : 'No credits for this key.' };
      return { ok: true, via: 'credits', remaining: taken.credits, refund: () => creditStore.refund(hash, SETTLE_CREDITS).catch(() => {}) };
    }
    const slot = `${network}|${payTo}`;
    const used = freeUsed.get(slot) || 0;
    if (used >= freePerDay) {
      return { ok: false, status: 402, reason: 'facilitator_payment_required', message: `This payTo used its ${freePerDay} free settles on ${NETWORK_NAMES[network]} today. Send a prepaid credit key (x-credit-key or Authorization: Bearer); ${SETTLE_CREDITS} credit${SETTLE_CREDITS === 1 ? '' : 's'} ($${(SETTLE_CREDITS / 1000).toFixed(3)}) a settle, 1000 credits for $0.80 at ${publicUrl}${credits.PACK_ROUTE}/1000.` };
    }
    freeUsed.set(slot, used + 1);
    return { ok: true, via: 'free', remaining: freePerDay - used - 1, refund: () => { freeUsed.set(slot, Math.max(0, (freeUsed.get(slot) || 1) - 1)); } };
  }

  const priceLine = (l) => `${l.freePerDay} free a day per payTo, then ${l.credits} credit${l.credits === 1 ? '' : 's'} ($${(l.credits / 1000).toFixed(3)}) each`;

  const solanaLane = lanes.get(SOLANA_MAINNET);
  const nearLane = lanes.get(NEAR_MAINNET);
  const info = async () => {
    roll();
    return {
      what: 'An x402 facilitator for USDC on Solana mainnet and on NEAR mainnet (scheme exact), by x402 Doctor. On Solana it also settles payments signed in Phantom; on NEAR our relayer pays the gas, so neither buyer nor seller needs NEAR. It screens payer and payTo against the OFAC SDN list before every settle.',
      enabled,
      networks,
      // Solana (kept at the top level as before)
      network: SOLANA_MAINNET,
      asset: USDC_MINT,
      fee_payer: solanaLane ? await facilitator.feePayer().catch(() => null) : null,
      near: nearLane ? {
        network: NEAR_MAINNET,
        asset: NEAR_USDC,
        relayer: await near.relayer().catch(() => null),
        settle: priceLine(nearLane),
        note: 'Your payTo must be registered on the USDC contract (storage_deposit) to receive USDC; the settle is refused before anything is sent when it is not.',
      } : null,
      url: `${publicUrl}${BASE_PATH}`,
      endpoints: { supported: `GET ${BASE_PATH}/supported`, verify: `POST ${BASE_PATH}/verify`, settle: `POST ${BASE_PATH}/settle` },
      pricing: {
        verify: 'free',
        settle: solanaLane ? priceLine(solanaLane) : null,
        settle_near: nearLane ? priceLine(nearLane) : null,
        credits: `${publicUrl}${credits.PACK_ROUTE}`,
        credit_header: `${credits.CREDIT_HEADER} or Authorization: Bearer <credit key>`,
      },
      how_to_use: 'new HTTPFacilitatorClient({ url: "' + `${publicUrl}${BASE_PATH}` + '", createAuthHeaders: async () => ({ settle: { "x-credit-key": process.env.DOCTOR_CREDIT_KEY } }) }) in your x402 resource server; the Solana option in your 402 names this fee_payer as extra.feePayer (the library fills it from /supported). For NEAR, register ExactNearScheme from @x402/near/exact/server for near:mainnet; nothing else to set.',
      today: { day, settled: total('settled'), refused: total('refused'), daily_max: solanaLane ? solanaLane.dailyMax : null, by_network: Object.fromEntries([...lanes].map(([n, l]) => [n, { settled: l.settled, refused: l.refused, daily_max: l.dailyMax }])) },
    };
  };

  function router(express) {
    const r = express.Router();
    r.get(BASE_PATH, async (req, res) => res.json(await info()));
    r.get(`${BASE_PATH}/health`, async (req, res) => { roll(); res.json({ ok: enabled, ...(await info()).today }); });
    r.use(BASE_PATH, (req, res, next) => (enabled ? next() : res.status(503).json({ error: 'facilitator_off', message: 'The facilitator is not switched on here.' })));
    // Every served network's kinds in one answer; a network whose core fails is left out (503 only when all fail).
    r.get(`${BASE_PATH}/supported`, async (req, res) => {
      const answers = await Promise.allSettled([...lanes.values()].map((l) => l.core.getSupported()));
      const ok = answers.filter((a) => a.status === 'fulfilled').map((a) => a.value);
      if (!ok.length) return res.status(503).json({ error: 'facilitator_unavailable', message: answers[0]?.reason?.message || 'no network answered' });
      const signers = {};
      for (const a of ok) for (const [fam, list] of Object.entries(a.signers || {})) signers[fam] = [...new Set([...(signers[fam] || []), ...list])];
      res.json({ kinds: ok.flatMap((a) => a.kinds || []), extensions: [...new Set(ok.flatMap((a) => a.extensions || []))], signers });
    });
    r.post(`${BASE_PATH}/verify`, express.json({ limit: '64kb' }), async (req, res) => {
      if (!verifyAllowed(req.ip)) return res.status(429).json({ isValid: false, invalidReason: 'rate_limited', invalidMessage: `At most ${VERIFY_PER_MINUTE} verifies a minute.` });
      const body = readBody(req.body, networks);
      if (body.error) return res.status(400).json({ isValid: false, invalidReason: body.error, invalidMessage: body.message });
      const sc = await screen([body.requirements.payTo]);
      if (!sc.ok) return res.json({ isValid: false, invalidReason: sc.reason, invalidMessage: sc.message });
      try {
        const out = await lanes.get(body.requirements.network).core.verify(body.payload, body.requirements);
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
      const asked = req.body?.paymentRequirements?.network;
      let lane = lanes.get(asked);
      const fail = (status, errorReason, errorMessage, extra = {}) => {
        if (lane) lane.refused++;
        res.status(status).json({ success: false, errorReason, errorMessage, transaction: '', network: lane ? asked : SOLANA_MAINNET, ...extra });
      };
      const body = readBody(req.body, networks);
      if (body.error) { if (body.error === 'unsupported_network') lane = null; return fail(400, body.error, body.message); }
      const network = body.requirements.network;
      const core = lane.core;
      if (lane.settled >= lane.dailyMax) return fail(503, 'facilitator_daily_limit', `The facilitator settled its daily maximum on ${NETWORK_NAMES[network]}; try again after 00:00 UTC.`);
      const paid = await charge(req, body.requirements.payTo, lane, network);
      if (!paid.ok) return fail(paid.status, paid.reason, paid.message);
      res.set('x-facilitator-billing', paid.via);
      res.set('x-facilitator-remaining', String(paid.remaining));
      try {
        const sc = await screen([body.requirements.payTo]);
        if (!sc.ok) { await paid.refund(); return fail(200, sc.reason, sc.message); }
        const v = await core.verify(body.payload, body.requirements);
        if (!v?.isValid) { await paid.refund(); return fail(200, v?.invalidReason || 'invalid_payment', v?.invalidMessage || 'The payment did not verify.', { payer: v?.payer }); }
        const sp = await screen([v.payer]);
        if (!sp.ok) { await paid.refund(); return fail(200, sp.reason, sp.message, { payer: v.payer }); }
        const out = await core.settle(body.payload, body.requirements);
        if (!out?.success) { await paid.refund(); lane.refused++; return res.json(out); }
        lane.settled++;
        log.log(`[facilitator] settle ok on ${network} via ${paid.via} payTo ${body.requirements.payTo} tx ${out.transaction}`);
        res.json(out);
        // NEAR Builders Activity (lib/activity.js): after the answer, never in its way.
        if (network === NEAR_MAINNET) activity.nearPaymentSettled({ payer: out.payer || v.payer, payTo: body.requirements.payTo, transaction: out.transaction, amount: body.requirements.amount, asset: body.requirements.asset, network }).catch(() => {});
      } catch (err) {
        await paid.refund();
        fail(500, 'unexpected_settle_error', String(err.message).slice(0, 300));
      }
    });
    return r;
  }

  // The fee payer's SOL, for the owner's usage page: it pays every settle's network fee (~0.000005 SOL).
  async function feePayerBalance() {
    if (!solanaLane) return null;
    const address = await facilitator.feePayer();
    const r = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address, { commitment: 'confirmed' }] }),
      signal: AbortSignal.timeout(5000),
    });
    const j = await r.json();
    const lamports = j?.result?.value;
    if (typeof lamports !== 'number') throw new Error(j?.error?.message || 'no balance in the RPC answer');
    return { address, sol: lamports / 1e9, settles_left: Math.floor(lamports / 5000) };
  }

  // The NEAR relayer's balance, for the owner's usage page and /health: it pays every NEAR settle's gas.
  const relayerBalance = async () => (near ? near.balance() : null);

  return {
    enabled,
    networks,
    router,
    info,
    feePayerBalance,
    relayerBalance,
    status: () => {
      roll();
      return {
        enabled,
        day,
        settled: total('settled'),
        refused: total('refused'),
        daily_max: solanaLane ? solanaLane.dailyMax : null,
        free_per_day: solanaLane ? solanaLane.freePerDay : null,
        networks,
        ...(nearLane ? { near: { settled: nearLane.settled, refused: nearLane.refused, daily_max: nearLane.dailyMax, free_per_day: nearLane.freePerDay } } : {}),
      };
    },
  };
}

module.exports = { createFacilitatorService, BASE_PATH, USDC_MINT, NEAR_USDC, FREE_PER_DAY, DAILY_MAX, SETTLE_CREDITS, NEAR_SETTLE_CREDITS, NEAR_FREE_PER_DAY, NEAR_DAILY_MAX, readBody, creditKeyOf };
